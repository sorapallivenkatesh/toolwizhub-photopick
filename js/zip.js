/* PhotoPick — minimal, dependency-free ZIP writer (STORE / no compression).
   Photos & videos are already compressed, so storing them raw is the right call
   and keeps this tiny. Everything runs locally; nothing is uploaded. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* entries: [{ name, blob }]. Returns a single application/zip Blob. onProgress(done,total). */
export async function buildZip(entries, onProgress) {
  const enc = new TextEncoder();
  const parts = [];        // Blob/Uint8Array chunks in file order
  const central = [];      // central-directory records
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const { name, blob } = entries[i];
    const nameBytes = enc.encode(name);
    const data = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(data);
    const size = data.length;

    // local file header (30 bytes + name)
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);            // version needed
    lh.setUint16(6, 0x0800, true);        // UTF-8 filename flag
    lh.setUint16(8, 0, true);             // compression = store
    lh.setUint16(10, 0, true);            // mod time
    lh.setUint16(12, 0x21, true);         // mod date (1980-01-01, fixed for determinism)
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);         // compressed size
    lh.setUint32(22, size, true);         // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);            // extra length
    parts.push(new Uint8Array(lh.buffer), nameBytes, data);

    // central directory record (46 bytes + name)
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);            // version made by
    cd.setUint16(6, 20, true);            // version needed
    cd.setUint16(8, 0x0800, true);        // UTF-8 flag
    cd.setUint16(10, 0, true);            // compression
    cd.setUint16(12, 0, true);            // mod time
    cd.setUint16(14, 0x21, true);         // mod date
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);            // extra len
    cd.setUint16(32, 0, true);            // comment len
    cd.setUint16(34, 0, true);            // disk number
    cd.setUint16(36, 0, true);            // internal attrs
    cd.setUint32(38, 0, true);            // external attrs
    cd.setUint32(42, offset, true);       // local header offset
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
    if (onProgress) onProgress(i + 1, entries.length);
  }

  // central directory
  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  // end of central directory
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);       // cd offset
  eocd.setUint16(20, 0, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: "application/zip" });
}
