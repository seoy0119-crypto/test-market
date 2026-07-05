---
name: moodboard
description: >
  Collect reference/mood-board images from Pinterest for one or more keywords and deliver
  them either as real downloaded image files (organized in per-keyword folders) or as a
  document of clickable pin/image links. Use this skill whenever the user asks to "모아줘",
  "수집", "다운로드", "캡쳐" Pinterest pins, wants a "무드보드"/"moodboard"/"레퍼런스 이미지"
  built around one or more keywords or themes (e.g. brand aesthetics, interior styles, product
  design directions, fashion/editorial looks), or asks to gather visual references/inspiration
  images for a design, branding, or research project — even if they don't say "Pinterest" or
  "moodboard" explicitly (e.g. "이 브랜드 느낌 참고할 이미지들 좀 찾아줘", "reference images for X").
  Trigger this proactively for any multi-image visual-reference-gathering request, not just
  ones that name Pinterest directly.
---

# Moodboard: Pinterest Reference Collector

## What this does

Given one or more keywords, search Pinterest for each and collect a batch of pins, then
deliver either:

1. **Image files** (default) — real image files downloaded into `Downloads/<keyword>/`,
   one folder per keyword.
2. **Link document** — an .xlsx with clickable pin links and image URLs (no image files).

## Before starting

Only ask the user something if it's genuinely ambiguous — don't interrupt for things that
already have a sensible default:

- **Keywords**: should be explicit in the request. If the user gives a vague topic instead of
  keywords ("우리 브랜드 느낌 참고 이미지"), it's fine to turn that into 1-3 concrete search
  keywords yourself rather than asking — treat it the way you'd naturally phrase a Pinterest
  search for that topic.
- **Count per keyword**: default to **25** if not specified.
- **Output format**: default to **image file download** if not specified. Only ask if the
  request is genuinely unclear about wanting files vs. a reference list (e.g. they mention
  "정리해서 보여줘" ambiguously).

## Why this can't be done with plain `bash` + `requests`/`playwright`

The sandboxed shell's network is allowlisted, and `pinterest.com` / `i.pinimg.com` are **not**
on it — any direct `curl`/`requests`/Playwright-in-sandbox attempt to reach Pinterest will get
a `403 blocked-by-allowlist` from the sandbox's proxy. The only path to Pinterest is through
the user's real, already-logged-in Chrome via the `claude-in-chrome` MCP tools. Load them first:

```
ToolSearch: select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__browser_batch
```

## Step 1: Collect pins for a keyword

Navigate to `https://www.pinterest.com/search/pins/?q=<url-encoded keyword>&rs=typed` in a tab.
Wait ~3s for images to render (Pinterest lazy-loads; a screenshot right after navigation often
shows solid-color placeholders — wait and re-screenshot rather than trusting the first frame).

Then repeatedly run this in the page (accumulating into a `window` global so scrolling doesn't
lose earlier results — Pinterest is an infinite-scroll feed and re-querying the DOM after each
scroll only sees what's currently mounted):

```js
window.__c = window.__c || {};
(() => {
  const anchors = Array.from(document.querySelectorAll('a[href^="/pin/"]'));
  for (const a of anchors) {
    const href = a.getAttribute('href');
    const img = a.querySelector('img');
    if (!href || !img || !img.src) continue;
    window.__c[href] = img.src;
  }
  return Object.keys(window.__c).length;
})();
```

Between calls, scroll the page (`computer` action `scroll`, direction `down`, amount ~10) and
wait ~2s for the next batch to load. Repeat until `Object.keys(window.__c).length` is
comfortably above the target count (collect a few extra — a handful of pins turn out to be
sponsored/unrelated tiles with no real `img`). Then take `Object.values(window.__c).slice(0, N)`
as your working set of image URLs for that keyword.

**Don't print the whole collection back through `javascript_tool`.** Its return value gets
silently truncated past a certain length, so `JSON.stringify(Object.values(window.__c))` for
20+ entries will come back cut off mid-string, not as an error — easy to miss. Keep the data in
the `window` global and only pull small slices (~5 at a time) into a returned string if you
actually need to eyeball it; when you need the whole set to reach Step 2, pass it by reference
inside the same script (e.g. `window.__urls = Object.values(window.__c).slice(0, N)`) rather
than round-tripping it through the tool's text output.

## Step 2a: Deliver as image files (default)

**Critical constraint**: Chrome blocks *automatic multiple downloads* from a tab after the
first successful one — subsequent `a.click()`-triggered downloads in that same tab silently
vanish (no error, no file). This was confirmed empirically: a 2nd, 3rd, Nth download attempt
in a tab that already completed one download never reaches disk, regardless of whether the
click is JS-synthetic or a real dispatched mouse click. Reloading or re-navigating the same
tab does **not** reset this. The only thing that reliably resets it is a **brand new tab**
(`tabs_create_mcp`), which gets its own fresh one-download allowance.

So: **use exactly one fresh tab per keyword, and trigger exactly one download per tab** — a
zip containing all of that keyword's images, built client-side in the page:

1. Open a new tab (`tabs_create_mcp`), navigate it to the search URL for this keyword, and
   collect pin image URLs there (Step 1) — collecting doesn't consume the download allowance,
   only triggering an actual download does.
2. In that same tab, run `scripts/zip_and_download.js` (read it, substitute the URL list and
   filename prefix, and execute via `javascript_tool`). It fetches each image (works fine —
   `i.pinimg.com` allows cross-origin `fetch`, this was tested and confirmed), builds a
   zero-dependency ZIP client-side (store method, no compression — just CRC32 + local/central
   headers, since no npm packages are available inside the page), and clicks a synthetic
   download link exactly once.
3. Confirm the zip landed in the real Downloads folder (bash path
   `/sessions/<session>/mnt/Downloads/<name>.zip` — give it a couple seconds, downloads aren't
   always instant), then unzip it into `Downloads/<keyword_slug>/` and delete the zip.
4. Files in the user's Downloads folder can't be deleted without asking first — call
   `allow_cowork_file_delete` and get a yes before removing the zip (and any leftover
   `.webp`/test artifacts from experimentation) rather than silently leaving clutter or
   silently trying to rm and failing.

Repeat with a new tab for every keyword — don't try to reuse a tab that has already downloaded
something.

Sanitize the keyword into a filename-safe slug (lowercase, spaces → underscores, strip
punctuation) for both the folder name and the per-image filenames, e.g.
`minimal tech branding moodboard` → `minimal_tech_branding_moodboard`.

## Step 2b: Deliver as a link document (if requested)

Skip all the download/zip machinery — just build a spreadsheet. Use the `xlsx` skill for the
mechanics (fonts, recalculation, etc.), with this structure:

| No | 키워드 | 핀 링크 | 이미지 URL |
|----|--------|---------|-----------|

Each pin link (`https://www.pinterest.com/pin/<id>/`) and image URL should be a real clickable
hyperlink, not just text. See `references/link_list_template.py` for a working openpyxl
snippet (header styling, hyperlink cells, column widths) — adapt keyword labels and row data
to what you collected in Step 1 rather than re-deriving the openpyxl calls from scratch.

## Final check

Before telling the user you're done: for image-file delivery, `ls` the destination folder(s)
and confirm the file count matches what was requested per keyword (a `find ... | wc -l` or
`ls | wc -l` is enough — don't just trust the JS's reported count, since a download can still
silently fail). For the link-document delivery, confirm the row count in the saved file. Then
share the result with `present_files` and give a short one- or two-line summary — no need to
narrate every step back to the user, they were not necessarily watching.
