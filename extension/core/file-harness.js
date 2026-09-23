/* file-harness.js — in-memory file extraction (extension port of harness/file-harness.js).
   No filesystem: returns { name, content } entries; zip built separately via zip.js. */

const FILE_TAG_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
const FENCE_RE = /```([a-zA-Z0-9_+#.\-]*)\r?\n([\s\S]*?)```/g;
const LANG_EXT = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'ts', tsx: 'ts',
  py: 'py', python: 'py',
  css: 'css', html: 'html', htm: 'html',
  md: 'md', markdown: 'md', json: 'json',
};
const ILLEGAL_CHAR_RE = /[<>:"|?*]/g;

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

/* Collect files from outputs, detect conflicts. Returns { files, conflicts }.
   files: [{ name, content }] (sanitized, deduped). */
export function collectRunArtifacts({ text, extraTexts = [] }) {
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

  const files = [...byName].map(([name, v]) => {
    let safe;
    try {
      safe = sanitizeRelPath(name);
    } catch {
      safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    }
    return { name: safe, content: v.content };
  });
  return { files, conflicts };
}