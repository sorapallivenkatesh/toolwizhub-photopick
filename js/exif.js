/* PhotoPick — minimal, dependency-free EXIF reader + embedded-JPEG extractor for RAW.
   Everything runs locally on the file bytes; nothing is uploaded. */

/* Read a small EXIF subset from a JPEG blob: dateTaken, make, model, orientation.
   Returns {} on anything unparseable — callers must tolerate missing fields. */
export async function readExif(blob) {
  try {
    // EXIF lives in the APP1 marker, always near the start — 128 KB is plenty.
    const buf = await blob.slice(0, 131072).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return {}; // not a JPEG
    let off = 2;
    const len = v.byteLength;
    while (off + 4 < len) {
      if (v.getUint16(off) !== 0xffe1) {
        // skip this marker segment
        if ((v.getUint16(off) & 0xff00) !== 0xff00) break;
        off += 2 + v.getUint16(off + 2);
        continue;
      }
      // APP1 — check for "Exif\0\0"
      const segStart = off + 4;
      if (v.getUint32(segStart) !== 0x45786966) { off += 2 + v.getUint16(off + 2); continue; }
      return parseTiff(v, segStart + 6);
    }
  } catch { /* fall through */ }
  return {};
}

function parseTiff(v, base) {
  const le = v.getUint16(base) === 0x4949; // 'II' little-endian, else 'MM'
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const out = {};
  const ifd0 = base + u32(base + 4);
  const exifPtr = readIfd(v, base, ifd0, le, u16, u32, out);
  if (exifPtr) readIfd(v, base, base + exifPtr, le, u16, u32, out);
  return out;
}

function readIfd(v, base, ifd, le, u16, u32, out) {
  let exifPtr = 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    if (tag === 0x0112) out.orientation = u16(e + 8);               // Orientation
    else if (tag === 0x010f) out.make = ascii(v, base, e, u32);     // Make
    else if (tag === 0x0110) out.model = ascii(v, base, e, u32);    // Model
    else if (tag === 0x8769) exifPtr = u32(e + 8);                  // ExifIFD pointer
    else if (tag === 0x829a) out.exposure = shutter(rational(v, base, e, le, u32)); // ExposureTime
    else if (tag === 0x829d) { const f = rational(v, base, e, le, u32); if (f) out.fnumber = "f/" + trim(f); } // FNumber
    else if (tag === 0x8827) out.iso = u16(e + 8) || u32(e + 8);    // ISO
    else if (tag === 0x920a) { const f = rational(v, base, e, le, u32); if (f) out.focal = Math.round(f) + "mm"; } // FocalLength
    else if (tag === 0x9003 || tag === 0x0132) {                    // DateTimeOriginal / DateTime
      const s = ascii(v, base, e, u32);
      const d = parseExifDate(s);
      if (d && (tag === 0x9003 || !out.dateTaken)) out.dateTaken = d;
    }
  }
  return exifPtr;
}

function rational(v, base, e, le, u32) {
  try {
    const off = base + u32(e + 8); // rationals are 8 bytes → always stored via offset
    const num = v.getUint32(off, le), den = v.getUint32(off + 4, le);
    return den ? num / den : 0;
  } catch { return 0; }
}
function shutter(s) { if (!s) return ""; return s >= 1 ? trim(s) + "s" : "1/" + Math.round(1 / s) + "s"; }
function trim(n) { return (Math.round(n * 10) / 10).toString(); }

function ascii(v, base, e, u32) {
  try {
    const count = u32(e + 4);
    const valOff = count <= 4 ? e + 8 : base + u32(e + 8);
    let s = "";
    for (let i = 0; i < count; i++) {
      const c = v.getUint8(valOff + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  } catch { return ""; }
}

function parseExifDate(s) {
  // "YYYY:MM:DD HH:MM:SS"
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || "");
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

/* Best-effort: pull the largest embedded JPEG out of a RAW file so we can show a
   real preview. Most CR2/NEF/ARW/DNG embed one near the front, so cap the read. */
export async function extractEmbeddedJpeg(blob) {
  try {
    const cap = Math.min(blob.size, 24 * 1024 * 1024);
    const bytes = new Uint8Array(await blob.slice(0, cap).arrayBuffer());
    let best = null;
    let i = 0;
    while (i < bytes.length - 3) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
        const end = findJpegEnd(bytes, i + 2);
        if (end > i) {
          const size = end - i;
          if (!best || size > best.size) best = { start: i, end, size };
          i = end;
          continue;
        }
      }
      i++;
    }
    if (best && best.size > 2048) return new Blob([bytes.subarray(best.start, best.end)], { type: "image/jpeg" });
  } catch { /* fall through */ }
  return null;
}

function findJpegEnd(bytes, from) {
  for (let j = from; j < bytes.length - 1; j++) {
    if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) return j + 2;
  }
  return -1;
}
