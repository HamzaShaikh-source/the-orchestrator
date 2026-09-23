/* file-harness.js — file extraction, safe writes, pure-node zip (STORE method). No npm deps. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE_TAG_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
const FENCE_RE = /```([a-zA-Z0-9_+#\\.\\-]*)\r?\n([\s\S]*?)```/g;
const LANG_EXT = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'ts', tsx: 'ts',
  py: 'py', python: 'py',
  css: 'css', html: 'html', htm: 'html',
  md: 'md', markdown: 'md', json: 'json',
};
const ILLEGAL_CHAR_RE = /[<>:"|?*]/g;

/* ── Extraction ── */

export function extractFiles(text) {
  const src = String(text ?? '');
  const out = new Map();
  let m;

  FILE_TAG_RE.lastIndex = 0;
  let anyTag = false;
  while ((m = FILE_TAG_RE.exec(src)) !== null) {
    anyTag = true;
    out.set(m[1], m[2]);
  }
  if (anyTag) {
    return [...out].map(([name, content]) => ({ name, content }));
  }

  FENCE_RE.lastIndex = 0;
  let n = 0;
  while ((m = FENCE_RE.exec(src)) !== null) {
    n++;
    const lang = (m[1] || '').toLowerCase();
    const ext = LANG_EXT[lang] || 'txt';
    out.set(`snippet-${n}.${ext}`, m[2].replace(/\r?\n$/, ''));
  }
  return [...out].map(([name, content]) => ({ name, content }));
}

export function sanitizeRelPath(name) {
  if (typeof name !== 'string') throw new Error('sanitizeRelPath: name must be a string');
  let p = name.replace(/\\/g, '/').trim();
  if (!p) throw new Error('sanitizeRelPath: empty path');

  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) {
    throw new Error(`sanitizeRelPath: path traversal rejected: ${name}`);
  }
  let cleaned = segs.map((s) => s.replace(ILLEGAL_CHAR_RE, '_')).join('/');
  if (cleaned.length > 200) cleaned = cleaned.slice(0, 200);
  if (!cleaned) throw new Error('sanitizeRelPath: empty after clean');
  return cleaned;
}

/* ── Writing ── */

export async function writeFiles(files, outDir) {
  const resolvedOut = path.resolve(outDir);
  await fs.mkdir(resolvedOut, { recursive: true });
  const results = [];
  for (const f of files || []) {
    const rel = sanitizeRelPath(f.name);
    const abs = path.resolve(resolvedOut, rel);
    if (!abs.startsWith(resolvedOut + path.sep)) {
      throw new Error(`writeFiles: path escapes outDir: ${f.name}`);
    }
    const content = String(f.content ?? '');
    const bytes = Buffer.byteLength(content);

    let existing = null;
    try {
      existing = await fs.readFile(abs, 'utf8');
    } catch {
      existing = null;
    }

    let status;
    if (existing === content) {
      status = 'skipped-identical';
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      status = 'written';
    }
    results.push({ name: rel, path: abs, bytes, status });
  }
  return results;
}

export async function collectRunArtifacts({ runDir, text, extraTexts = [] }) {
  const inputs = [];
  const addInput = (t, defLabel) => {
    if (t == null) return;
    if (typeof t === 'string') {
      if (t.trim()) inputs.push({ label: defLabel, text: t });
    } else if (typeof t === 'object' && typeof t.text === 'string') {
      if (t.text.trim()) inputs.push({ label: t.label || defLabel, text: t.text });
    }
  };
  addInput(text, 'main');
  (extraTexts || []).forEach((t, i) => addInput(t, `text-${i + 1}`));

  const byName = new Map();
  for (const { label, text: t } of inputs) {
    for (const f of extractFiles(t)) {
      const prev = byName.get(f.name);
      if (!prev) {
        byName.set(f.name, { content: f.content, labels: [label], conflict: false });
      } else {
        if (!prev.labels.includes(label)) prev.labels.push(label);
        if (prev.content !== f.content) prev.conflict = true;
        prev.content = f.content;
      }
    }
  }

  const conflicts = [...byName.entries()]
    .filter(([, v]) => v.conflict && v.labels.length > 1)
    .map(([name, v]) => ({ name, from: v.labels }));

  const files = await writeFiles(
    [...byName].map(([name, v]) => ({ name, content: v.content })),
    path.join(runDir, 'files'),
  );
  return { files, conflicts };
}

/* ── Pure-node ZIP writer (STORE method) ── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { time, date };
}

export async function zipDir(dir, zipPath) {
  const resolvedDir = path.resolve(dir);
  const entries = [];

  async function walk(d, prefix) {
    let items;
    try {
      items = await fs.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.isDirectory()) {
        await walk(full, rel);
      } else if (it.isFile()) {
        const [data, st] = await Promise.all([fs.readFile(full), fs.stat(full)]);
        entries.push({ name: rel, data, mtime: st.mtime, crc: crc32(data) });
      }
    }
  }
  await walk(resolvedDir, '');

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.crc >>> 0, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, e.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(e.crc >>> 0, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    centralParts.push(cen, nameBuf);

    offset += 30 + nameBuf.length + e.data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  const zipBuf = Buffer.concat([...localParts, ...centralParts, eocd]);
  const resolvedZip = path.resolve(zipPath);
  await fs.mkdir(path.dirname(resolvedZip), { recursive: true });
  await fs.writeFile(resolvedZip, zipBuf);
  return resolvedZip;
}