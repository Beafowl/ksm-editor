"use strict";
/* ============================================================
 * Minimal ZIP archive writer (store method, no compression).
 * ============================================================ */

const ZIP = (() => {

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name: "path/in/zip.ext", data: Uint8Array }] -> zip Blob
function make(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0, cdSize = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true);         // version needed to extract
    local.setUint16(6, 0x0800, true);     // flags: UTF-8 file names
    local.setUint16(8, 0, true);          // method: store
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true); // compressed size
    local.setUint32(22, e.data.length, true); // uncompressed size
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);         // extra field length
    parts.push(local.buffer, name, e.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);    // central directory signature
    cd.setUint16(4, 20, true);            // version made by
    cd.setUint16(6, 20, true);            // version needed
    cd.setUint16(8, 0x0800, true);        // flags: UTF-8 file names
    cd.setUint16(10, 0, true);            // method: store
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);       // local header offset
    central.push(cd.buffer, name);

    offset += 30 + name.length + e.data.length;
    cdSize += 46 + name.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);     // end of central directory signature
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);        // central directory offset
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

return { make };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZIP;
