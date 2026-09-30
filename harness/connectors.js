import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class ConnectorError extends Error {
  constructor(message, code = 'api') {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

export const CONNECTORS = [
  { id: 'github', name: 'GitHub', icon: '🐙', actions: ['create-repo', 'push-files', 'list-repos'] },
  { id: 'google-drive', name: 'Google Drive', icon: '📁', actions: ['upload-files'] },
  { id: 'webhook', name: 'Webhook', icon: '🔗', actions: ['send'] },
];

const TIMEOUT_MS = 15000;
const GITHUB_API = 'https://api.github.com';
const GDRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

function log(id, ...msg) {
  console.log(`[Connector:${id}]`, ...msg);
}

/* Tokens come from the server's Store (set in the dashboard Connectors panel)
   and fall back to environment variables. Never logged, never committed. */
const TOKEN_KEYS = ['github', 'googleClientId', 'googleClientSecret', 'googleRefreshToken'];

async function getTokens(store) {
  let saved = {};
  if (store && typeof store.get === 'function') {
    try {
      saved = (await store.get('connectorTokens', {})) || {};
    } catch {
      saved = {};
    }
  }
  return {
    github: saved.github || process.env.GITHUB_TOKEN || '',
    googleClientId: saved.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: saved.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
    googleRefreshToken: saved.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN || '',
  };
}

/* Persist connector credentials (used by POST /api/connector-tokens). */
export async function saveConnectorTokens(store, tokens = {}) {
  const current = (await store.get('connectorTokens', {})) || {};
  const next = { ...current };
  for (const key of TOKEN_KEYS) {
    if (!(key in tokens)) continue;
    const v = tokens[key];
    if (typeof v === 'string' && v.trim()) next[key] = v.trim();
    else if (v === null || v === '') delete next[key];
  }
  await store.set('connectorTokens', next);
  return next;
}

async function ghFetch(token, pathname, init = {}) {
  if (!token) throw new ConnectorError('GitHub token not configured', 'auth');
  const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const res = await fetch(`${GITHUB_API}${pathname}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

function ghError(res, fallback = 'GitHub API request failed') {
  if (res.status === 401 || res.status === 403) return new ConnectorError('GitHub authentication failed', 'auth');
  if (res.status === 404) return new ConnectorError('GitHub resource not found', 'not-found');
  return new ConnectorError(`${fallback} (HTTP ${res.status})`, res.status >= 500 ? 'api' : 'api');
}

async function driveAccessToken(store) {
  const { googleClientId: GOOGLE_CLIENT_ID, googleClientSecret: GOOGLE_CLIENT_SECRET, googleRefreshToken: GOOGLE_REFRESH_TOKEN } = await getTokens(store);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new ConnectorError('Google Drive credentials not configured', 'auth');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json || !json.access_token) {
    throw new ConnectorError('Google Drive token refresh failed', 'auth');
  }
  return json.access_token;
}

async function githubStatus(store) {
  const { github: token } = await getTokens(store);
  if (!token) {
    return { status: 'needs-setup', detail: 'Add a GitHub token in the Connectors panel (or set GITHUB_TOKEN)' };
  }
  try {
    const { res, json } = await ghFetch(token, '/user');
    if (res.status === 200) {
      return { status: 'connected', detail: json && json.login ? `Authenticated as ${json.login}` : 'Authenticated' };
    }
    return { status: 'error', detail: `GitHub auth failed (HTTP ${res.status})` };
  } catch (err) {
    return { status: 'error', detail: `GitHub validation failed: ${err.message}` };
  }
}

async function driveStatus(store) {
  const { googleClientId: GOOGLE_CLIENT_ID, googleClientSecret: GOOGLE_CLIENT_SECRET, googleRefreshToken: GOOGLE_REFRESH_TOKEN } = await getTokens(store);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    return { status: 'needs-setup', detail: 'Add Drive OAuth credentials in the Connectors panel (or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)' };
  }
  try {
    await driveAccessToken(store);
    return { status: 'connected', detail: 'Authenticated via OAuth refresh token' };
  } catch {
    return { status: 'error', detail: 'Google Drive token exchange failed' };
  }
}

export async function connectorStatus(id, { store } = {}) {
  const meta = CONNECTORS.find((c) => c.id === id);
  if (!meta) throw new ConnectorError(`Unknown connector: ${id}`, 'invalid');
  let result;
  if (id === 'github') result = await githubStatus(store);
  else if (id === 'google-drive') result = await driveStatus(store);
  else result = { status: 'connected', detail: 'POST JSON to any URL' };
  log(id, `status=${result.status}`);
  return { id: meta.id, name: meta.name, icon: meta.icon, ...result, actions: meta.actions };
}

export async function listConnectorStatuses({ store } = {}) {
  return Promise.all(CONNECTORS.map((c) => connectorStatus(c.id, { store })));
}

export async function lastRunDir(outDir) {
  let entries;
  try {
    entries = await fs.readdir(outDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(outDir, entry.name);
    try {
      const st = await fs.stat(full);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { dir: full, mtimeMs: st.mtimeMs };
    } catch {
      // unreadable dir, skip
    }
  }
  return newest ? newest.dir : null;
}

async function readRunFiles(outDir) {
  const runDir = await lastRunDir(outDir);
  if (!runDir) throw new ConnectorError('No previous run found', 'not-found');
  const files = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relPath);
      } else if (entry.isFile() && !entry.name.endsWith('.zip')) {
        const bytes = await fs.readFile(full);
        files.push({ path: relPath, name: entry.name, bytes });
      }
    }
  }
  await walk(runDir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function resolveFileList(args, outDir) {
  if (Array.isArray(args.files) && args.files.length > 0) {
    return args.files.map((f) => {
      const relPath = f.path || f.name;
      if (!relPath) throw new ConnectorError('File entry missing name/path', 'invalid');
      let bytes;
      if (Buffer.isBuffer(f.content)) bytes = f.content;
      else if (typeof f.content === 'string') bytes = Buffer.from(f.content, 'utf8');
      else if (f.bytes && Buffer.isBuffer(f.bytes)) bytes = f.bytes;
      else throw new ConnectorError(`File "${relPath}" has no content`, 'invalid');
      return { path: relPath, name: basename(relPath), bytes };
    });
  }
  return readRunFiles(outDir);
}

function basename(p) {
  return p.split('/').pop();
}

function encodeGitPath(p) {
  return p.split('/').map((s) => encodeURIComponent(s)).join('/');
}

async function runGithubAction(store, action, args, outDir) {
  const { github: token } = await getTokens(store);
  if (action === 'create-repo') {
    const name = args.name;
    if (!name) throw new ConnectorError('name is required for create-repo', 'invalid');
    log('github', 'create-repo', name);
    const { res, json } = await ghFetch(token, '/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: !!args.private, auto_init: false }),
    });
    if (!res.ok) throw ghError(res, 'Could not create repo');
    return { ok: true, result: { repo: { full_name: json.full_name, html_url: json.html_url } } };
  }

  if (action === 'list-repos') {
    const perPage = Number.isInteger(args.per_page) ? args.per_page : 20;
    log('github', 'list-repos', `per_page=${perPage}`);
    const { res, json } = await ghFetch(token, `/user/repos?per_page=${perPage}&sort=updated`);
    if (!res.ok) throw ghError(res, 'Could not list repos');
    const repos = (json || []).map((r) => ({ full_name: r.full_name, html_url: r.html_url, private: r.private }));
    return { ok: true, result: { repos } };
  }

  if (action === 'push-files') {
    const repo = args.repo;
    if (!repo) throw new ConnectorError('repo is required for push-files', 'invalid');
    const files = await resolveFileList(args, outDir);
    if (!files.length) throw new ConnectorError('No files to push', 'api');
    log('github', 'push-files', repo, files.map((f) => f.path).join(', '));
    const pushed = [];
    for (const file of files) {
      const endpoint = `/repos/${encodeGitPath(repo)}/contents/${encodeGitPath(file.path)}`;
      const existing = await ghFetch(token, endpoint);
      let sha;
      let status;
      if (existing.res.status === 200) {
        sha = existing.json && existing.json.sha;
        status = 'updated';
      } else if (existing.res.status === 404) {
        status = 'created';
      } else {
        throw ghError(existing.res, `Could not check ${file.path}`);
      }
      const payload = { message: 'Orchestrator run', content: file.bytes.toString('base64') };
      if (sha) payload.sha = sha;
      const put = await ghFetch(token, endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!put.res.ok) throw ghError(put.res, `Could not push ${file.path}`);
      pushed.push({ path: file.path, status });
    }
    return { ok: true, result: { pushed, repo } };
  }

  throw new ConnectorError(`Unknown github action: ${action}`, 'invalid');
}

function buildMultipart(boundary, files) {
  const chunks = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(file.metadata)}\r\n`,
        'utf8',
      ),
    );
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8'));
    chunks.push(file.bytes);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

async function runDriveAction(store, action, args, outDir) {
  if (action !== 'upload-files') throw new ConnectorError(`Unknown google-drive action: ${action}`, 'invalid');
  const files = await resolveFileList(args, outDir);
  if (!files.length) throw new ConnectorError('No files to upload', 'api');
  const token = await driveAccessToken(store);
  const folderId = args.folderId;
  log('google-drive', 'upload-files', folderId || '(root)', files.map((f) => f.name).join(', '));
  const uploaded = [];
  for (const file of files) {
    const metadata = folderId ? { name: file.name, parents: [folderId] } : { name: file.name };
    const boundary = `OrchestratorBoundary${randomBytes(12).toString('hex')}`;
    const body = buildMultipart(boundary, [{ name: file.name, bytes: file.bytes, metadata }]);
    const res = await fetch(`${GDRIVE_UPLOAD}?uploadType=multipart`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new ConnectorError('Google Drive upload failed (auth)', 'auth');
      throw new ConnectorError(`Google Drive upload failed (HTTP ${res.status})`, 'api');
    }
    uploaded.push({ name: file.name, id: json.id, webViewLink: json.webViewLink });
  }
  return { ok: true, result: { uploaded, folderId } };
}

async function runWebhookAction(action, args, outDir) {
  if (action !== 'send') throw new ConnectorError(`Unknown webhook action: ${action}`, 'invalid');
  const url = args.url;
  if (!url || typeof url !== 'string') throw new ConnectorError('url is required for send', 'invalid');
  if (!/^https?:\/\//i.test(url)) throw new ConnectorError('url must be http(s)', 'invalid');
  let payload = args.payload;
  if (payload === undefined || payload === null) {
    let names = [];
    try {
      names = (await readRunFiles(outDir)).map((f) => f.name);
    } catch {
      names = [];
    }
    payload = { source: 'the-orchestrator', ts: new Date().toISOString(), files: names };
  }
  log('webhook', 'send', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.arrayBuffer();
  return { ok: true, result: { status: res.status, ok: res.ok } };
}

export async function runConnectorAction(id, action, args = {}, { store, outDir } = {}) {
  const meta = CONNECTORS.find((c) => c.id === id);
  if (!meta) throw new ConnectorError(`Unknown connector: ${id}`, 'invalid');
  if (!meta.actions.includes(action)) throw new ConnectorError(`Unknown action: ${id}/${action}`, 'invalid');
  if (id === 'github') return runGithubAction(store, action, args, outDir);
  if (id === 'google-drive') return runDriveAction(store, action, args, outDir);
  if (id === 'webhook') return runWebhookAction(action, args, outDir);
  throw new ConnectorError(`Unknown connector: ${id}`, 'invalid');
}