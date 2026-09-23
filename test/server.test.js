/* HTTP/SSE server tests — stub client, temp dirs, ephemeral ports, no network */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../harness/server.js';
import { Store } from '../harness/store.js';

function makeStubClient() {
  const calls = [];
  return {
    calls,
    async providers() {
      return [
        { id: 'chatgpt', label: 'ChatGPT', available: true },
        { id: 'gemini', label: 'Gemini', available: true },
        { id: 'perplexity', label: 'Perplexity', available: true },
      ];
    },
    async chat({ provider, message, onDelta }) {
      calls.push({ provider, message });
      let content;
      if (/agent selection system/i.test(message)) {
        content = '{"selected":["chatgpt","gemini","perplexity"],"reasoning":"stub"}';
      } else if (/subtasks for this goal/i.test(message)) {
        content = JSON.stringify([
          { description: 'Build the index.html landing page', type: 'code' },
          { description: 'Write the README documentation', type: 'writing' },
        ]);
      } else if (/Output Format/i.test(message) || /<file name/i.test(message)) {
        content = `<file name="index.html">\n<!DOCTYPE html>\n<html><body>hi</body></html>\n</file>`;
      } else if (/synthesiz|self-contained/i.test(message)) {
        content = `<file name="index.html">\n<!DOCTYPE html>\n<html><body>final</body></html>\n</file>\n<file name="README.md">\n# Docs\n</file>`;
      } else {
        content = `reply to: ${message.slice(0, 40)}`;
      }
      onDelta?.(content);
      return { content, session: { id: provider }, provider };
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return server.address().port;
}

async function stop(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DEAD_WEB2API = 'http://127.0.0.1:1';
const ctx = { tmp: null, outDir: null, store: null, server: null, base: null };
const ck = { tmp: null, stateDir: null, authDir: null, server: null, base: null };

before(async () => {
  ctx.tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-srv-'));
  ctx.outDir = path.join(ctx.tmp, 'runs');
  await fs.mkdir(ctx.outDir, { recursive: true });
  ctx.store = new Store(path.join(ctx.tmp, 'state'));
  const created = createServer({
    client: makeStubClient(),
    store: ctx.store,
    outDir: ctx.outDir,
    web2apiBaseUrl: DEAD_WEB2API,
  });
  ctx.server = created.server;
  const port = await listen(ctx.server);
  ctx.base = `http://127.0.0.1:${port}`;

  ck.tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-cookies-'));
  ck.stateDir = path.join(ck.tmp, 'state');
  ck.authDir = path.join(ck.tmp, 'auth');
  const createdCk = createServer({
    client: makeStubClient(),
    store: new Store(ck.stateDir),
    outDir: path.join(ck.tmp, 'runs'),
    stateDir: ck.stateDir,
    authDir: ck.authDir,
    web2apiBaseUrl: DEAD_WEB2API,
  });
  ck.server = createdCk.server;
  const ckPort = await listen(ck.server);
  ck.base = `http://127.0.0.1:${ckPort}`;
});

after(async () => {
  if (ctx.server) await stop(ctx.server);
  if (ck.server) await stop(ck.server);
  if (ctx.tmp) await fs.rm(ctx.tmp, { recursive: true, force: true });
  if (ck.tmp) await fs.rm(ck.tmp, { recursive: true, force: true });
});

test('GET / serves dashboard HTML', async () => {
  const res = await fetch(`${ctx.base}/`);
  assert.equal(res.status, 200);
  const html = (await res.text()).toLowerCase();
  assert.ok(html.includes('<!doctype html') || html.includes('<html'), 'serves html document');
});

test('GET /api/state returns expected shape', async () => {
  const res = await fetch(`${ctx.base}/api/state`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const s = await res.json();
  assert.equal(s.running, false);
  assert.equal(s.lastRun, null);
  assert.ok(Array.isArray(s.agents) && s.agents.length >= 1, 'agents array');
  for (const a of s.agents) {
    assert.ok(typeof a.id === 'string' && a.id, 'agent id');
    assert.ok(typeof a.name === 'string' && a.name, 'agent name');
    assert.ok('icon' in a && 'color' in a && 'active' in a, 'agent display fields');
  }
  assert.ok(Array.isArray(s.providers), 'providers array');
  assert.deepEqual(s.providers, []);
});

test('SSE + POST /api/run: streams events and writes manifest', async () => {
  const sse = await fetch(`${ctx.base}/api/events`);
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type') || '', /text\/event-stream/);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`SSE timed out; buffer head: ${buf.slice(0, 400)}`)),
      15000,
    );
  });
  const wanted = ['"type":"task-start"', '"type":"task-done"', '"type":"run-end"'];
  try {
    const runRes = await postJson(`${ctx.base}/api/run`, { goal: 'build a page' });
    assert.equal(runRes.status, 200);
    const runBody = await runRes.json();
    assert.equal(runBody.ok, true);
    assert.match(runBody.runId, /^run-\d{8}-\d{6}$/);

    while (!wanted.every((w) => buf.includes(w))) {
      const chunk = await Promise.race([reader.read(), guard]);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  for (const w of wanted) assert.ok(buf.includes(w), `SSE stream contains ${w}`);

  let manifest = null;
  const entries = await fs.readdir(ctx.outDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const m = JSON.parse(
        await fs.readFile(path.join(ctx.outDir, e.name, 'manifest.json'), 'utf8'),
      );
      if (m.goal === 'build a page') {
        manifest = m;
        break;
      }
    } catch {
      /* no manifest */
    }
  }
  assert.ok(manifest, 'manifest.json written in run dir');
  assert.equal(manifest.ok, true, JSON.stringify(manifest.error));
  assert.ok(Array.isArray(manifest.tasks) && manifest.tasks.length >= 1, 'tasks recorded');
  assert.ok(Array.isArray(manifest.files), 'files recorded');
  assert.ok(manifest.ts, 'timestamp recorded');
});

test('GET /api/runs lists the completed run', async () => {
  assert.ok(ctx.base, 'shared server up');
  const res = await fetch(`${ctx.base}/api/runs`);
  assert.equal(res.status, 200);
  const runs = await res.json();
  assert.ok(Array.isArray(runs));
  assert.equal(runs.length, 1, `expected 1 run, got ${JSON.stringify(runs)}`);
  assert.match(runs[0].dir, /^run-/);
  assert.equal(runs[0].goal, 'build a page');
  assert.equal(runs[0].ok, true);
  assert.ok(Array.isArray(runs[0].files));
});

test('GET /api/zip serves PK bytes', async () => {
  const runs = await (await fetch(`${ctx.base}/api/runs`)).json();
  assert.equal(runs.length, 1);
  const res = await fetch(`${ctx.base}/api/zip?run=${encodeURIComponent(runs[0].dir)}`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 4, 'zip has bytes');
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
});

test('GET /api/zip rejects path traversal dirname', async () => {
  const res = await fetch(`${ctx.base}/api/zip?run=../evil`);
  assert.equal(res.status, 400);
});

test('POST /api/run while running returns 409; cancel resolves', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-srv-slow-'));
  const outDir = path.join(tmp, 'runs');
  await fs.mkdir(outDir, { recursive: true });
  const store = new Store(path.join(tmp, 'state'));
  const inner = makeStubClient();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slowClient = {
    async providers() {
      return inner.providers();
    },
    async chat(args) {
      await gate;
      return inner.chat(args);
    },
  };
  const { server } = createServer({
    client: slowClient,
    store,
    outDir,
    web2apiBaseUrl: DEAD_WEB2API,
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const first = await postJson(`${base}/api/run`, { goal: 'slow goal' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ok, true);

    const second = await postJson(`${base}/api/run`, { goal: 'another goal' });
    assert.equal(second.status, 409);

    const cancel = await fetch(`${base}/api/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { ok: true });

    release();
    const start = Date.now();
    let running = true;
    while (running && Date.now() - start < 10000) {
      const s = await (await fetch(`${base}/api/state`)).json();
      running = s.running;
      if (running) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(running, false, 'pipeline settled after cancel');
  } finally {
    try {
      release();
    } catch {
      /* already released */
    }
    await stop(server);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('GET /api/connectors lists connectors with statuses', async () => {
  assert.ok(ctx.base, 'shared server up');
  const res = await fetch(`${ctx.base}/api/connectors`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  const ids = list.map((c) => c.id);
  for (const id of ['github', 'google-drive', 'webhook']) {
    assert.ok(ids.includes(id), `${id} listed`);
  }
  const gh = list.find((c) => c.id === 'github');
  assert.ok(gh.name && gh.icon && Array.isArray(gh.actions), 'github metadata');
  if (!process.env.GITHUB_TOKEN) {
    assert.equal(gh.status, 'needs-setup');
  }
  const wh = list.find((c) => c.id === 'webhook');
  assert.equal(wh.status, 'connected');
});

test('POST webhook connector action posts to own server', async () => {
  assert.ok(ctx.base, 'shared server up');
  const res = await fetch(`${ctx.base}/api/connectors/webhook/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'send', url: `${ctx.base}/api/state` }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.ok(body.result, 'result present');
  assert.equal(body.result.status, 200, JSON.stringify(body.result));
  assert.equal(body.result.ok, true, JSON.stringify(body.result));
});

test('POST /api/cookies pairs token and writes perplexity flat file', async () => {
  assert.ok(ck.base, 'cookie server up');
  const res = await postJson(`${ck.base}/api/cookies`, {
    provider: 'perplexity',
    cookies: { a: '1', b: '2' },
    token: 'tok-1',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'perplexity');
  assert.equal(body.file, 'cookies.local.json');
  assert.equal(body.reloaded, false, 'dead web2api -> reloaded false');
  const raw = await fs.readFile(path.join(ck.authDir, 'cookies.local.json'), 'utf8');
  assert.ok(raw.includes('\n  "a": "1"'), 'auth file is pretty-printed 2-space JSON');
  assert.deepEqual(JSON.parse(raw), { a: '1', b: '2' }, 'perplexity file is flat cookies');
  const tok = JSON.parse(await fs.readFile(path.join(ck.stateDir, 'server-token.json'), 'utf8'));
  assert.equal(tok.token, 'tok-1', 'server-token.json written on first call');
});

test('POST /api/cookies writes chatgpt nested file with headers and account_id', async () => {
  const res = await postJson(`${ck.base}/api/cookies`, {
    provider: 'chatgpt',
    cookies: { x: 'y' },
    headers: { authorization: 'Bearer t' },
    account_id: 'acc',
    token: 'tok-1',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).file, 'chatgpt.local.json');
  const written = JSON.parse(
    await fs.readFile(path.join(ck.authDir, 'chatgpt.local.json'), 'utf8'),
  );
  assert.deepEqual(written, {
    cookies: { x: 'y' },
    headers: { authorization: 'Bearer t' },
    account_id: 'acc',
  });
});

test('POST /api/cookies writes gemini nested file with empty headers', async () => {
  const res = await postJson(`${ck.base}/api/cookies`, {
    provider: 'gemini',
    cookies: { SID: 's' },
    token: 'tok-1',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).file, 'gemini.local.json');
  const written = JSON.parse(
    await fs.readFile(path.join(ck.authDir, 'gemini.local.json'), 'utf8'),
  );
  assert.equal(written.cookies.SID, 's');
  assert.deepEqual(written.headers, {});
  assert.equal(written.build_label, '');
});

test('POST /api/cookies wrong token -> 401 token-mismatch; matching -> 200', async () => {
  const bad = await postJson(`${ck.base}/api/cookies`, {
    provider: 'perplexity',
    cookies: { a: '1' },
    token: 'wrong-token',
  });
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: 'token-mismatch' });

  const good = await postJson(`${ck.base}/api/cookies`, {
    provider: 'perplexity',
    cookies: { a: '1' },
    token: 'tok-1',
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).ok, true);
});

test('POST /api/cookies rejects invalid provider and invalid cookies with 400', async () => {
  const badProvider = await postJson(`${ck.base}/api/cookies`, {
    provider: 'bogus',
    cookies: { a: '1' },
    token: 'tok-1',
  });
  assert.equal(badProvider.status, 400);

  const emptyCookies = await postJson(`${ck.base}/api/cookies`, {
    provider: 'perplexity',
    cookies: {},
    token: 'tok-1',
  });
  assert.equal(emptyCookies.status, 400);

  const nonStringValues = await postJson(`${ck.base}/api/cookies`, {
    provider: 'perplexity',
    cookies: { a: 1 },
    token: 'tok-1',
  });
  assert.equal(nonStringValues.status, 400);
});

test('GET /api/cookies/status reports configured providers, token, dead web2api', async () => {
  const res = await fetch(`${ck.base}/api/cookies/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const byId = Object.fromEntries(body.providers.map((p) => [p.id, p]));
  assert.deepEqual(
    body.providers.map((p) => p.id).sort(),
    ['chatgpt', 'gemini', 'perplexity'],
    'all three providers listed',
  );
  assert.equal(byId.perplexity.configured, true);
  assert.equal(byId.perplexity.file, 'cookies.local.json');
  assert.equal(byId.chatgpt.configured, true);
  assert.equal(byId.chatgpt.file, 'chatgpt.local.json');
  assert.equal(byId.gemini.configured, true);
  assert.equal(byId.gemini.file, 'gemini.local.json');
  assert.equal(body.serverToken, true, 'pairing active after first POST');
  assert.deepEqual(body.web2api, { reachable: false, providers: [] }, 'dead port');
});

test('POST /api/cookies/reset wrong token -> 401; right token -> 200 and clears pairing', async () => {
  const bad = await postJson(`${ck.base}/api/cookies/reset`, { token: 'wrong' });
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: 'token-mismatch' });

  const good = await postJson(`${ck.base}/api/cookies/reset`, { token: 'tok-1' });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true });

  const tokenRaw = await fs
    .readFile(path.join(ck.stateDir, 'server-token.json'), 'utf8')
    .then(() => 'exists')
    .catch(() => 'gone');
  assert.equal(tokenRaw, 'gone', 'server-token.json removed');

  const status = await (await fetch(`${ck.base}/api/cookies/status`)).json();
  assert.equal(status.serverToken, false, 'pairing inactive after reset');
});

test('GET /api/state includes providers and cookies arrays', async () => {
  const res = await fetch(`${ck.base}/api/state`);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.ok(Array.isArray(s.providers), 'providers array present');
  assert.deepEqual(s.providers, [], 'dead web2api -> empty providers');
  assert.ok(Array.isArray(s.cookies), 'cookies array present');
  assert.equal(s.cookies.length, 3, 'one entry per provider');
  const byId = Object.fromEntries(s.cookies.map((c) => [c.id, c]));
  for (const id of ['perplexity', 'chatgpt', 'gemini']) {
    assert.ok(byId[id], `${id} listed in state cookies`);
    assert.equal(byId[id].configured, true, `${id} configured after writes`);
  }
});
