/* server.js — HTTP/SSE server for The Orchestrator dashboard */
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPipeline } from './orchestrator.js';
import { AGENTS } from './agents.js';
import { Web2ApiClient, Web2ApiError } from './web2api-client.js';
import { Store } from './store.js';
import {
  CONNECTORS,
  connectorStatus,
  listConnectorStatuses,
  runConnectorAction,
  lastRunDir,
} from './connectors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(ROOT, 'ui');
const BODY_LIMIT = 5 * 1024 * 1024;
const KEEP_ALIVE_MS = 15000;
const RUN_ID_RE = /^[a-z0-9-]+$/i;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const COOKIE_PROVIDERS = ['perplexity', 'chatgpt', 'gemini'];
const COOKIE_FILES = {
  perplexity: 'cookies.local.json',
  chatgpt: 'chatgpt.local.json',
  gemini: 'gemini.local.json',
};
const PROVIDERS_CACHE_MS = 10000;
let providersMem = { url: null, ts: 0, ids: [] };

function isStringMap(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function web2apiHeaders() {
  const key = process.env.WEB2API_API_KEY || '';
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function fetchProviderIds(baseUrl) {
  const res = await fetch(`${baseUrl}/api/providers`, {
    signal: AbortSignal.timeout(2000),
    headers: web2apiHeaders(),
  });
  if (!res.ok) throw new Error(`providers http ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data?.providers) ? data.providers : [];
  return items.map((p) => p?.id).filter((id) => typeof id === 'string');
}

async function cachedProviderIds(baseUrl) {
  const now = Date.now();
  if (providersMem.url === baseUrl && now - providersMem.ts < PROVIDERS_CACHE_MS) {
    return providersMem.ids;
  }
  let ids = [];
  try {
    ids = await fetchProviderIds(baseUrl);
  } catch {
    ids = [];
  }
  providersMem = { url: baseUrl, ts: Date.now(), ids };
  return ids;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        settled = true;
        reject(new HttpError(413, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function runStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function agentList() {
  return AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    color: a.color,
    active: a.active,
  }));
}

export function createServer({
  client,
  store,
  outDir,
  port = 3000,
  host = '127.0.0.1',
  stateDir = path.join(ROOT, 'harness', 'state'),
  authDir = path.join(ROOT, 'vendor', 'web2api', 'auth'),
  web2apiBaseUrl = process.env.WEB2API_BASE_URL || 'http://127.0.0.1:8080',
} = {}) {
  const state = { running: false, lastRun: null };
  const sseClients = new Set();
  let currentAbort = null;
  let keepAliveTimer = null;
  const tokenFile = path.join(stateDir, 'server-token.json');
  void port;
  void host;

  async function readServerToken() {
    try {
      const data = JSON.parse(await fsp.readFile(tokenFile, 'utf8'));
      return typeof data?.token === 'string' && data.token ? data.token : null;
    } catch {
      return null;
    }
  }

  async function cookieConfigList() {
    const list = [];
    for (const id of COOKIE_PROVIDERS) {
      list.push({ id, configured: await fileExists(path.join(authDir, COOKIE_FILES[id])) });
    }
    return list;
  }

  async function statePayload() {
    const [providers, cookies] = await Promise.all([
      cachedProviderIds(web2apiBaseUrl),
      cookieConfigList(),
    ]);
    return {
      running: state.running,
      lastRun: state.lastRun,
      agents: agentList(),
      providers,
      cookies,
    };
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      for (const res of [...sseClients]) {
        try {
          if (res.writableEnded || res.destroyed) {
            sseClients.delete(res);
            continue;
          }
          res.write(': keep-alive\n\n');
        } catch {
          sseClients.delete(res);
        }
      }
      if (!sseClients.size) stopKeepAlive();
    }, KEEP_ALIVE_MS);
    if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
  }

  function broadcast(event) {
    if (!sseClients.size) return;
    let line;
    try {
      line = `data: ${JSON.stringify(event)}\n\n`;
    } catch {
      return;
    }
    for (const res of [...sseClients]) {
      try {
        if (res.writableEnded || res.destroyed) {
          sseClients.delete(res);
          continue;
        }
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
    if (!sseClients.size) stopKeepAlive();
  }

  async function serveStatic(res, relRaw) {
    let decoded;
    try {
      decoded = decodeURIComponent(relRaw);
    } catch {
      sendJson(res, 400, { error: 'bad path' });
      return;
    }
    if (decoded.includes('\0')) {
      sendJson(res, 400, { error: 'bad path' });
      return;
    }
    const abs = path.resolve(UI_DIR, decoded);
    if (abs !== UI_DIR && !abs.startsWith(UI_DIR + path.sep)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = STATIC_TYPES[ext];
    if (!type) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    try {
      const data = await fsp.readFile(abs);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
  }

  async function openSse(req, res) {
    const helloState = await statePayload();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    sseClients.add(res);
    startKeepAlive();
    const drop = () => {
      sseClients.delete(res);
      if (!sseClients.size) stopKeepAlive();
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    try {
      res.write(`data: ${JSON.stringify({ type: 'hello', state: helloState })}\n\n`);
    } catch {
      drop();
    }
  }

  async function executeRun({ runId, runOut, goal, selectedAgents, projectFiles, controller }) {
    let result;
    try {
      result = await runPipeline({
        goal,
        selectedAgents,
        projectFiles,
        outDir: runOut,
        autoConfirm: true,
        runSettings: { retries: 2, maxAgents: 4, signal: controller.signal },
        onEvent: (event) => broadcast(event),
        client,
        store,
      });
    } catch (err) {
      const message =
        err instanceof Web2ApiError
          ? `${err.code}: ${err.message}`
          : err?.message || String(err);
      result = { ok: false, error: message, tasks: [], files: [], conflicts: [], zipPath: null, step: 'error' };
    }

    try {
      const manifest = {
        goal,
        ok: !!result.ok,
        tasks: result.tasks ?? [],
        files: result.files ?? [],
        conflicts: result.conflicts ?? [],
        zipPath: result.zipPath ?? null,
        error: result.error ?? null,
        ts: new Date().toISOString(),
      };
      await fsp.mkdir(runOut, { recursive: true });
      await fsp.writeFile(path.join(runOut, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    } catch (err) {
      console.log(`[Server] manifest write failed for ${runId}: ${err.message}`);
    }

    state.lastRun = {
      goal,
      ok: !!result.ok,
      files: result.files ?? [],
      zipPath: result.zipPath ?? null,
      conflicts: result.conflicts ?? [],
      error: result.error ?? null,
    };
    state.running = false;
    if (currentAbort === controller) currentAbort = null;
    broadcast({ type: 'run-end', result: { ...result, runId } });
    console.log(
      `[Server] run ${runId} finished ok=${!!result.ok}${result.error ? ` error=${result.error}` : ''}`,
    );
  }

  async function handleRun(req, res) {
    const body = await readJsonBody(req);
    if (state.running) {
      sendJson(res, 409, { error: 'a run is already in progress' });
      return;
    }
    const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
    if (!goal) {
      sendJson(res, 400, { error: 'goal is required' });
      return;
    }
    let selectedAgents = null;
    if (body.agents !== undefined && body.agents !== null) {
      if (!Array.isArray(body.agents)) {
        sendJson(res, 400, { error: 'agents must be an array' });
        return;
      }
      selectedAgents = body.agents;
    }
    const projectFiles = {};
    if (body.files !== undefined && body.files !== null) {
      if (!Array.isArray(body.files)) {
        sendJson(res, 400, { error: 'files must be an array' });
        return;
      }
      for (const f of body.files) {
        if (!f || typeof f.name !== 'string' || typeof f.content !== 'string') {
          sendJson(res, 400, { error: 'files entries need {name, content} strings' });
          return;
        }
        projectFiles[f.name] = f.content;
      }
    }

    const runId = `run-${runStamp()}`;
    const runOut = path.join(outDir, runId);
    const controller = new AbortController();
    state.running = true;
    currentAbort = controller;
    try {
      await fsp.mkdir(runOut, { recursive: true });
    } catch (err) {
      state.running = false;
      currentAbort = null;
      throw err;
    }
    console.log(`[Server] run ${runId} started: ${goal.slice(0, 80)}`);
    void executeRun({ runId, runOut, goal, selectedAgents, projectFiles, controller });
    sendJson(res, 200, { ok: true, runId });
  }

  function handleCancel(req, res) {
    req.resume();
    if (currentAbort) {
      console.log('[Server] cancel requested');
      try {
        currentAbort.abort();
      } catch {
        /* already aborted */
      }
    }
    sendJson(res, 200, { ok: true });
  }

  async function handleConnectorList(req, res) {
    req.resume();
    const statuses = await listConnectorStatuses({ store });
    sendJson(res, 200, statuses);
  }

  async function handleConnectorRefresh(req, res, id) {
    req.resume();
    if (!CONNECTORS.some((c) => c.id === id)) {
      sendJson(res, 404, { ok: false, error: `unknown connector: ${id}` });
      return;
    }
    const status = await connectorStatus(id, { store });
    sendJson(res, 200, status);
  }

  async function handleConnectorAction(req, res, id) {
    const body = await readJsonBody(req);
    if (!CONNECTORS.some((c) => c.id === id)) {
      sendJson(res, 404, { ok: false, error: `unknown connector: ${id}` });
      return;
    }
    const { action, ...args } = body || {};
    if (!action || typeof action !== 'string') {
      sendJson(res, 400, { ok: false, error: 'action is required' });
      return;
    }
    try {
      const envelope = await runConnectorAction(id, action, args, { store, outDir });
      const ok = !!envelope.ok;
      const inner = envelope.result ?? null;
      broadcast({ type: 'connector', id, action, ok, result: inner });
      sendJson(res, 200, { ...(inner && typeof inner === 'object' ? inner : {}), ok, result: inner });
    } catch (err) {
      const message = err?.message || String(err);
      const code = err?.code;
      broadcast({ type: 'connector', id, action, ok: false, error: message });
      const status = ['invalid', 'not-found', 'auth'].includes(code) ? 400 : 502;
      sendJson(res, status, { ok: false, error: message, code });
    }
  }

  async function handleZip(res, u) {
    const runParam = u.searchParams.get('run');
    if (!runParam || !RUN_ID_RE.test(runParam)) {
      sendJson(res, 400, { error: 'bad run id' });
      return;
    }
    const base = path.resolve(outDir);
    const runPath = path.resolve(base, runParam);
    if (!runPath.startsWith(base + path.sep)) {
      sendJson(res, 400, { error: 'bad run id' });
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(runPath, { withFileTypes: true });
    } catch {
      sendJson(res, 404, { error: 'run not found' });
      return;
    }
    const zipEntry = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.zip'));
    if (!zipEntry) {
      sendJson(res, 404, { error: 'no zip found' });
      return;
    }
    const data = await fsp.readFile(path.join(runPath, zipEntry.name));
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${zipEntry.name}"`,
    });
    res.end(data);
  }

  async function handleRuns(req, res) {
    req.resume();
    let entries = [];
    try {
      entries = await fsp.readdir(outDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let manifest = null;
      try {
        manifest = JSON.parse(
          await fsp.readFile(path.join(outDir, entry.name, 'manifest.json'), 'utf8'),
        );
      } catch {
        /* no manifest yet */
      }
      runs.push({
        dir: entry.name,
        goal: manifest?.goal ?? null,
        ts: manifest?.ts ?? null,
        ok: manifest?.ok ?? null,
        files: Array.isArray(manifest?.files)
          ? manifest.files.map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean)
          : [],
        zip: manifest?.zipPath ? path.basename(manifest.zipPath) : null,
      });
    }
    runs.sort((a, b) => b.dir.localeCompare(a.dir));
    sendJson(res, 200, runs);
  }

  async function handleCookiesPost(req, res) {
    const body = await readJsonBody(req);
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    if (!COOKIE_PROVIDERS.includes(provider)) {
      sendJson(res, 400, { error: 'invalid provider' });
      return;
    }
    const cookies = body?.cookies;
    if (!isStringMap(cookies) || Object.keys(cookies).length === 0) {
      sendJson(res, 400, { error: 'cookies must be a non-empty object of string values' });
      return;
    }
    const headers = body?.headers;
    if (headers !== undefined && headers !== null && !isStringMap(headers)) {
      sendJson(res, 400, { error: 'headers must be an object of string values' });
      return;
    }
    const accountId = body?.account_id;
    if (accountId !== undefined && accountId !== null && typeof accountId !== 'string') {
      sendJson(res, 400, { error: 'account_id must be a string' });
      return;
    }
    const token = body?.token;
    if (typeof token !== 'string' || !token) {
      sendJson(res, 400, { error: 'token is required' });
      return;
    }

    const existingToken = await readServerToken();
    if (existingToken !== null && existingToken !== token) {
      sendJson(res, 401, { error: 'token-mismatch' });
      return;
    }

    let payload;
    if (provider === 'perplexity') {
      payload = cookies;
    } else if (provider === 'chatgpt') {
      payload = { cookies, headers: headers || {}, account_id: accountId || '' };
    } else {
      payload = { cookies, headers: {}, build_label: '' };
    }

    const file = COOKIE_FILES[provider];
    await writeJsonAtomic(path.join(authDir, file), payload);
    if (existingToken === null) {
      await writeJsonAtomic(tokenFile, { token });
      console.log('[Cookies] paired server token');
    }

    let reloaded = false;
    try {
      const reloadRes = await fetch(`${web2apiBaseUrl}/api/reload`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
        headers: web2apiHeaders(),
      });
      reloaded = reloadRes.ok;
    } catch {
      reloaded = false;
    }

    console.log(`[Cookies] wrote ${file} for ${provider} (reloaded=${reloaded})`);
    broadcast({ type: 'cookies', provider, ok: true });
    sendJson(res, 200, { ok: true, provider, file, reloaded });
  }

  async function handleCookiesReset(req, res) {
    const body = await readJsonBody(req);
    const token = typeof body?.token === 'string' ? body.token : '';
    const existingToken = await readServerToken();
    if (!token || existingToken === null || existingToken !== token) {
      sendJson(res, 401, { error: 'token-mismatch' });
      return;
    }
    await fsp.rm(tokenFile, { force: true });
    console.log('[Cookies] server token cleared');
    sendJson(res, 200, { ok: true });
  }

  async function handleCookiesStatus(req, res) {
    req.resume();
    const providers = [];
    for (const id of COOKIE_PROVIDERS) {
      const file = COOKIE_FILES[id];
      const configured = await fileExists(path.join(authDir, file));
      providers.push({ id, configured, file: configured ? file : null });
    }
    const serverToken = (await readServerToken()) !== null;
    let web2api;
    try {
      web2api = { reachable: true, providers: await fetchProviderIds(web2apiBaseUrl) };
    } catch {
      web2api = { reachable: false, providers: [] };
    }
    sendJson(res, 200, { providers, serverToken, web2api });
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const m = req.method;

    if (p === '/' && m === 'GET') {
      await serveStatic(res, 'dashboard.html');
      return;
    }
    if (p === '/ui' || p.startsWith('/ui/')) {
      if (m !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const rel = p === '/ui' ? '' : p.slice(4);
      await serveStatic(res, rel);
      return;
    }
    if (p === '/api/state') {
      if (m !== 'GET' && m !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      req.resume();
      sendJson(res, 200, await statePayload());
      return;
    }
    if (p === '/api/cookies') {
      if (m !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleCookiesPost(req, res);
      return;
    }
    if (p === '/api/cookies/reset') {
      if (m !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleCookiesReset(req, res);
      return;
    }
    if (p === '/api/cookies/status') {
      if (m !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleCookiesStatus(req, res);
      return;
    }
    if (p === '/api/events') {
      if (m !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await openSse(req, res);
      return;
    }
    if (p === '/api/run') {
      if (m !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleRun(req, res);
      return;
    }
    if (p === '/api/cancel') {
      if (m !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      handleCancel(req, res);
      return;
    }
    if (p === '/api/connectors') {
      if (m !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleConnectorList(req, res);
      return;
    }
    const connMatch = /^\/api\/connectors\/([^/]+)\/(refresh|action)$/.exec(p);
    if (connMatch) {
      if (m !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const id = decodeURIComponent(connMatch[1]);
      if (connMatch[2] === 'refresh') await handleConnectorRefresh(req, res, id);
      else await handleConnectorAction(req, res, id);
      return;
    }
    if (p === '/api/zip') {
      if (m !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleZip(res, u);
      return;
    }
    if (p === '/api/runs') {
      if (m !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleRuns(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'internal error';
      if (!(err instanceof HttpError)) {
        console.log(`[Server] ${req.method} ${req.url} failed: ${err.message}`);
      }
      if (!res.headersSent) sendJson(res, status, { error: message });
      else {
        try {
          res.end();
        } catch {
          /* connection already gone */
        }
      }
    });
  });

  server.on('close', () => {
    stopKeepAlive();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    sseClients.clear();
  });

  return { server, broadcast, state };
}

export async function main() {
  const port = Number.parseInt(process.env.ORCH_PORT || '3000', 10) || 3000;
  const host = '127.0.0.1';
  const outDir = path.resolve(process.env.ORCH_OUT_DIR || './runs');
  const baseUrl = process.env.WEB2API_BASE_URL || 'http://127.0.0.1:8080';
  const apiKey = process.env.WEB2API_API_KEY || '';

  await fsp.mkdir(outDir, { recursive: true });
  const store = new Store(path.join(ROOT, 'harness', 'state'));
  const client = new Web2ApiClient({ baseUrl, apiKey });
  const { server } = createServer({ client, store, outDir, port, host, web2apiBaseUrl: baseUrl });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${port} is already in use — set ORCH_PORT to a free port`);
    } else {
      console.error(`[Server] ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`[Server] listening on http://${host}:${port}`);
    console.log(`[Server] dashboard: http://${host}:${port}/`);
    console.log(`[Server] runs dir: ${outDir}`);
    console.log(`[Server] web2api: ${baseUrl}`);
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[Server] failed to start: ${err.message}`);
    process.exit(1);
  });
}
