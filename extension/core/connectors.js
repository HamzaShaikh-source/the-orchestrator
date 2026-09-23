/* connectors.js — GitHub / Google Drive / Webhook connectors (extension port).
   Tokens come from chrome.storage.local 'connectorTokens' (set in dashboard).
   Files come from args.files or the in-memory lastRun files (no filesystem). */

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

function utf8(str) {
  return new TextEncoder().encode(str);
}

function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function getTokens(store) {
  return (await store.get('connectorTokens', {})) || {};
}

async function ghFetch(store, pathname, init = {}) {
  const tokens = await getTokens(store);
  const token = tokens.github;
  if (!token) throw new ConnectorError('GitHub token not configured', 'auth');
  const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const res = await fetch(`${GITHUB_API}${pathname}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { res, json };
}

function ghError(res, fallback = 'GitHub API request failed') {
  if (res.status === 401 || res.status === 403) return new ConnectorError('GitHub authentication failed', 'auth');
  if (res.status === 404) return new ConnectorError('GitHub resource not found', 'not-found');
  return new ConnectorError(`${fallback} (HTTP ${res.status})`, 'api');
}

async function driveAccessToken(store) {
  const tokens = await getTokens(store);
  const { googleClientId, googleClientSecret, googleRefreshToken } = tokens;
  if (!googleClientId || !googleClientSecret || !googleRefreshToken) {
    throw new ConnectorError('Google Drive credentials not configured', 'auth');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token: googleRefreshToken,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok || !json || !json.access_token) {
    throw new ConnectorError('Google Drive token refresh failed', 'auth');
  }
  return json.access_token;
}

async function githubStatus(store) {
  const tokens = await getTokens(store);
  if (!tokens.github) {
    return { status: 'needs-setup', detail: 'Add a GitHub personal access token in Settings' };
  }
  try {
    const { res, json } = await ghFetch(store, '/user');
    if (res.status === 200) {
      return { status: 'connected', detail: json && json.login ? `Authenticated as ${json.login}` : 'Authenticated' };
    }
    return { status: 'error', detail: `GitHub auth failed (HTTP ${res.status})` };
  } catch (err) {
    return { status: 'error', detail: `GitHub validation failed: ${err.message}` };
  }
}

async function driveStatus(store) {
  const tokens = await getTokens(store);
  if (!tokens.googleClientId || !tokens.googleClientSecret || !tokens.googleRefreshToken) {
    return { status: 'needs-setup', detail: 'Add Google OAuth client ID, secret and refresh token in Settings' };
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

/* files: [{ path, name, content(string) | bytes(Uint8Array) }] — from args or lastRun */
function resolveFileList(args, lastRunFiles) {
  if (Array.isArray(args.files) && args.files.length > 0) {
    return args.files.map((f) => {
      const relPath = f.path || f.name;
      if (!relPath) throw new ConnectorError('File entry missing name/path', 'invalid');
      let bytes;
      if (f.bytes instanceof Uint8Array) bytes = f.bytes;
      else if (typeof f.content === 'string') bytes = utf8(f.content);
      else if (typeof f.bytes === 'string') bytes = utf8(f.bytes);
      else throw new ConnectorError(`File "${relPath}" has no content`, 'invalid');
      return { path: relPath, name: basename(relPath), bytes };
    });
  }
  if (Array.isArray(lastRunFiles) && lastRunFiles.length > 0) {
    return lastRunFiles.map((f) => ({
      path: f.path,
      name: f.name || basename(f.path),
      bytes: f.bytes instanceof Uint8Array ? f.bytes : utf8(String(f.content ?? '')),
    }));
  }
  throw new ConnectorError('No previous run found', 'not-found');
}

function basename(p) {
  return String(p).split('/').pop();
}

function encodeGitPath(p) {
  return String(p).split('/').map((s) => encodeURIComponent(s)).join('/');
}

async function runGithubAction(store, action, args, lastRunFiles) {
  if (action === 'create-repo') {
    const name = args.name;
    if (!name) throw new ConnectorError('name is required for create-repo', 'invalid');
    log('github', 'create-repo', name);
    const { res, json } = await ghFetch(store, '/user/repos', {
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
    const { res, json } = await ghFetch(store, `/user/repos?per_page=${perPage}&sort=updated`);
    if (!res.ok) throw ghError(res, 'Could not list repos');
    const repos = (json || []).map((r) => ({ full_name: r.full_name, html_url: r.html_url, private: r.private }));
    return { ok: true, result: { repos } };
  }

  if (action === 'push-files') {
    const repo = args.repo;
    if (!repo) throw new ConnectorError('repo is required for push-files', 'invalid');
    const files = resolveFileList(args, lastRunFiles);
    if (!files.length) throw new ConnectorError('No files to push', 'api');
    log('github', 'push-files', repo, files.map((f) => f.path).join(', '));
    const pushed = [];
    for (const file of files) {
      const endpoint = `/repos/${encodeGitPath(repo)}/contents/${encodeGitPath(file.path)}`;
      const existing = await ghFetch(store, endpoint);
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
      const payload = { message: 'Orchestrator run', content: b64(file.bytes) };
      if (sha) payload.sha = sha;
      const put = await ghFetch(store, endpoint, {
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
    chunks.push(utf8(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(file.metadata)}\r\n`));
    chunks.push(utf8(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(file.bytes);
    chunks.push(utf8('\r\n'));
  }
  chunks.push(utf8(`--${boundary}--\r\n`));
  return concatBytes(chunks);
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function runDriveAction(store, action, args, lastRunFiles) {
  if (action !== 'upload-files') throw new ConnectorError(`Unknown google-drive action: ${action}`, 'invalid');
  const files = resolveFileList(args, lastRunFiles);
  if (!files.length) throw new ConnectorError('No files to upload', 'api');
  const token = await driveAccessToken(store);
  const folderId = args.folderId;
  log('google-drive', 'upload-files', folderId || '(root)', files.map((f) => f.name).join(', '));
  const uploaded = [];
  for (const file of files) {
    const metadata = folderId ? { name: file.name, parents: [folderId] } : { name: file.name };
    const boundary = `OrchestratorBoundary${randomHex(12)}`;
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
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new ConnectorError('Google Drive upload failed (auth)', 'auth');
      throw new ConnectorError(`Google Drive upload failed (HTTP ${res.status})`, 'api');
    }
    uploaded.push({ name: file.name, id: json.id, webViewLink: json.webViewLink });
  }
  return { ok: true, result: { uploaded, folderId } };
}

async function runWebhookAction(action, args, lastRunFiles) {
  if (action !== 'send') throw new ConnectorError(`Unknown webhook action: ${action}`, 'invalid');
  const url = args.url;
  if (!url || typeof url !== 'string') throw new ConnectorError('url is required for send', 'invalid');
  if (!/^https?:\/\//i.test(url)) throw new ConnectorError('url must be http(s)', 'invalid');
  let payload = args.payload;
  if (payload === undefined || payload === null) {
    let names = [];
    try {
      names = (Array.isArray(lastRunFiles) ? lastRunFiles : []).map((f) => f.name || basename(f.path));
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

export async function runConnectorAction(id, action, args = {}, { store, lastRunFiles } = {}) {
  const meta = CONNECTORS.find((c) => c.id === id);
  if (!meta) throw new ConnectorError(`Unknown connector: ${id}`, 'invalid');
  if (!meta.actions.includes(action)) throw new ConnectorError(`Unknown action: ${id}/${action}`, 'invalid');
  if (id === 'github') return runGithubAction(store, action, args, lastRunFiles);
  if (id === 'google-drive') return runDriveAction(store, action, args, lastRunFiles);
  if (id === 'webhook') return runWebhookAction(action, args, lastRunFiles);
  throw new ConnectorError(`Unknown connector: ${id}`, 'invalid');
}