// zip_and_download.js
//
// Run this INSIDE the Pinterest tab via the `javascript_tool` MCP tool, in a FRESH tab that
// has not yet triggered any download (see SKILL.md — Chrome blocks automatic multi-downloads
// per tab after the first success, and this is the workaround: one zip = one download).
//
// Before running, replace the two placeholders below:
//   __URLS__   -> a JSON array of image URLs, e.g. Object.values(window.__c).slice(0, 25)
//   __PREFIX__ -> filename-safe keyword slug, e.g. "minimal_tech_branding_moodboard"
//
// Returns JSON: {"count": <n>, "zipSize": <bytes>} on success.

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.table[n] = c >>> 0;
    }
  }
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

// Local file header: fixed 30-byte layout per the ZIP spec (sig 4, version 2, flags 2,
// compression 2, mod time 2, mod date 2, crc 4, comp size 4, uncomp size 4, name len 2,
// extra len 2). Each field is written via its own u16/u32 call rather than packed into one
// literal array — an earlier hand-packed version silently dropped 2 bytes from the central
// header and produced zips that `unzip` rejected as corrupt, so this explicit, one-field-per-
// call layout is deliberate: it's easy to verify by eye against the spec.
function localHeaderFor(nameBytes, crc, size) {
  return new Uint8Array([
    0x50, 0x4B, 0x03, 0x04,
    ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(size), ...u32(size),
    ...u16(nameBytes.length), ...u16(0)
  ]);
}

// Central directory header: fixed 46-byte layout (sig 4, version-made-by 2, version-needed 2,
// flags 2, compression 2, mod time 2, mod date 2, crc 4, comp size 4, uncomp size 4, name len 2,
// extra len 2, comment len 2, disk number 2, internal attrs 2, external attrs 4, local header
// offset 4). Same one-field-per-call approach as above, for the same reason.
function centralHeaderFor(nameBytes, crc, size, offset) {
  return new Uint8Array([
    0x50, 0x4B, 0x01, 0x02,
    ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(size), ...u32(size),
    ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(offset)
  ]);
}

// Minimal store-only (uncompressed) ZIP writer — no external libraries are reachable from
// inside the page, so this hand-rolls just enough of the ZIP spec (local file headers +
// central directory + end record) to produce a file every unzip tool can read. Verified against
// both a 3-file text case and a 25-file binary stress case with `unzip -t` before shipping.
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const localHeader = localHeaderFor(nameBytes, crc, size);
    localParts.push(localHeader, nameBytes, f.data);
    const centralHeader = centralHeaderFor(nameBytes, crc, size, offset);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + size;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const p of centralParts) centralSize += p.length;
  const end = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, 0, 0, 0, 0,
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(centralStart), 0, 0
  ]);
  return new Blob([...localParts, ...centralParts, end]);
}

const urls = __URLS__;
const prefix = "__PREFIX__";
const files = [];
for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  const res = await fetch(url, { mode: 'cors' });
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  const ext = ct.includes('webp') ? 'webp' : (ct.includes('png') ? 'png' : 'jpg');
  files.push({ name: `${prefix}_${String(i + 1).padStart(2, '0')}.${ext}`, data: buf });
}
const zipBlob = makeZip(files);
const a = document.createElement('a');
document.body.appendChild(a);
a.href = URL.createObjectURL(zipBlob);
a.download = `${prefix}.zip`;
a.click();
JSON.stringify({ count: files.length, zipSize: zipBlob.size });
