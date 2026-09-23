/* zip.js — minimal ZIP writer (method 8, deflate-raw via CompressionStream).
   Works in Chrome 80+ (service worker) and Node 18+ (tests). Async, returns Blob. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function u16(v) { return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]); }
function u32(v) { return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]); }

/**
 * zipFiles(entries) -> Promise<Blob>
 * entries: [{ name: 'dir/file.txt', content: string|Uint8Array }]
 */
export async function zipFiles(entries) {
  const localParts = [];
  const centralParts = [];
  const now = dosDateTime(new Date());
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.name);
    const content = typeof entry.content === 'string' ? utf8Bytes(entry.content) : entry.content;
    const crc = crc32(content);
    const compressed = await deflateRaw(content);

    const local = concatBytes([
      u32(0x04034b50), // signature
      u16(20),         // version needed
      u16(0x0800),     // flags: UTF-8 names
      u16(8),          // method: deflate
      u16(now.time),
      u16(now.date),
      u32(crc),
      u32(compressed.length),
      u32(content.length),
      u16(nameBytes.length),
      u16(0),          // extra length
      nameBytes,
      compressed,
    ]);
    localParts.push(local);

    const central = concatBytes([
      u32(0x02014b50), // signature
      u16(20),         // version made by
      u16(20),         // version needed
      u16(0x0800),
      u16(8),
      u16(now.time),
      u16(now.date),
      u32(crc),
      u32(compressed.length),
      u32(content.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),          // comment length
      u16(0),          // disk number
      u16(0),          // internal attrs
      u32(0),          // external attrs
      u32(offset),
      nameBytes,
    ]);
    centralParts.push(central);
    offset += local.length;
  }

  const centralDir = concatBytes(centralParts);
  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centralParts.length),
    u16(centralParts.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);

  const blob = new Blob([concatBytes([...localParts, centralDir, eocd])], { type: 'application/zip' });
  return blob;
}