import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONNECTORS,
  ConnectorError,
  connectorStatus,
  runConnectorAction,
  listConnectorStatuses,
  lastRunDir,
} from '../harness/connectors.js';

const ORIG_FETCH = global.fetch;

function installFetch(routes) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
    };
    calls.push(call);
    const route = routes.find((r) => {
      const urlOk = r.url instanceof RegExp ? r.url.test(call.url) : r.url === call.url;
      return urlOk && (!r.method || r.method === call.method);
    });
    if (!route) return new Response('{}', { status: 404 });
    if (route.handler) return route.handler(call);
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});
    return new Response(body, { status: route.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, restore: () => { global.fetch = ORIG_FETCH; } };
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function clearConnectorEnv() {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
}

let activeStub = null;
test.afterEach(() => {
  if (activeStub) activeStub.restore();
  activeStub = null;
  clearConnectorEnv();
});

async function withRunDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-conn-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function makeRunWithFiles(outDir, runName, files) {
  const runDir = path.join(outDir, runName);
  await fs.mkdir(path.join(runDir, 'files'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(runDir, 'files', name), content, 'utf8');
  }
  return runDir;
}

test('github status connected when token valid', async () => {
  process.env.GITHUB_TOKEN = 'tok123';
  activeStub = installFetch([{ url: /api\.github\.com\/user$/, method: 'GET', body: { login: 'octocat' } }]);
  const st = await connectorStatus('github');
  assert.equal(st.id, 'github');
  assert.equal(st.status, 'connected');
  assert.equal(st.name, 'GitHub');
  assert.ok(st.icon);
  assert.deepEqual(st.actions, ['create-repo', 'push-files', 'list-repos']);
  assert.equal(activeStub.calls.length, 1);
  assert.equal(activeStub.calls[0].headers.Authorization, 'Bearer tok123');
});

test('github status needs-setup when token missing', async () => {
  delete process.env.GITHUB_TOKEN;
  activeStub = installFetch([]);
  const st = await connectorStatus('github');
  assert.equal(st.status, 'needs-setup');
  assert.equal(activeStub.calls.length, 0);
});

test('github status error on 401', async () => {
  process.env.GITHUB_TOKEN = 'bad';
  activeStub = installFetch([{ url: /api\.github\.com\/user$/, status: 401, body: { message: 'Bad credentials' } }]);
  const st = await connectorStatus('github');
  assert.equal(st.status, 'error');
});

test('create-repo posts correct body', async () => {
  process.env.GITHUB_TOKEN = 'tok';
  activeStub = installFetch([
    {
      url: 'https://api.github.com/user/repos',
      method: 'POST',
      status: 201,
      body: { full_name: 'octocat/newthing', html_url: 'https://github.com/octocat/newthing' },
    },
  ]);
  const out = await runConnectorAction('github', 'create-repo', { name: 'newthing', private: true });
  const call = activeStub.calls[0];
  assert.equal(call.method, 'POST');
  const body = JSON.parse(call.body);
  assert.deepEqual(body, { name: 'newthing', private: true, auto_init: false });
  assert.deepEqual(out, {
    ok: true,
    result: { repo: { full_name: 'octocat/newthing', html_url: 'https://github.com/octocat/newthing' } },
  });
});

test('create-repo emits private:false when omitted', async () => {
  process.env.GITHUB_TOKEN = 'tok';
  activeStub = installFetch([
    { url: 'https://api.github.com/user/repos', method: 'POST', status: 201, body: { full_name: 'o/r' } },
  ]);
  await runConnectorAction('github', 'create-repo', { name: 'r' });
  const body = JSON.parse(activeStub.calls[0].body);
  assert.equal(body.private, false);
});

test('push-files create path (file not present) PUTs base64 content', () =>
  withRunDir(async (outDir) => {
    process.env.GITHUB_TOKEN = 'tok';
    await makeRunWithFiles(outDir, 'run-1', { 'hello.txt': 'hello world' });
    activeStub = installFetch([
      { url: /contents\/files\/hello\.txt$/, method: 'GET', status: 404 },
      {
        url: /contents\/files\/hello\.txt$/,
        method: 'PUT',
        handler: (call) => {
          const body = JSON.parse(call.body);
          assert.equal(body.message, 'Orchestrator run');
          assert.equal(body.content, Buffer.from('hello world').toString('base64'));
          assert.equal(body.sha, undefined);
          return jsonRes(200, { content: { path: 'files/hello.txt' } });
        },
      },
    ]);
    const out = await runConnectorAction('github', 'push-files', { repo: 'octocat/repo' }, { outDir });
    assert.equal(out.ok, true);
    assert.deepEqual(out.result.pushed, [{ path: 'files/hello.txt', status: 'created' }]);
    assert.equal(out.result.repo, 'octocat/repo');
  }));

test('push-files update path includes sha and base64 content', () =>
  withRunDir(async (outDir) => {
    process.env.GITHUB_TOKEN = 'tok';
    await makeRunWithFiles(outDir, 'run-1', { 'a.txt': 'alpha', 'b.txt': 'beta' });
    let putCalls = 0;
    activeStub = installFetch([
      { url: /contents\/files\/a\.txt$/, method: 'GET', status: 200, body: { sha: 'sha-aaa' } },
      { url: /contents\/files\/b\.txt$/, method: 'GET', status: 200, body: { sha: 'sha-bbb' } },
      {
        url: /contents\/files\/a\.txt$/,
        method: 'PUT',
        handler: (call) => {
          const body = JSON.parse(call.body);
          assert.equal(body.content, Buffer.from('alpha').toString('base64'));
          assert.equal(body.sha, 'sha-aaa');
          putCalls++;
          return jsonRes(200, { content: { path: 'files/a.txt' } });
        },
      },
      {
        url: /contents\/files\/b\.txt$/,
        method: 'PUT',
        handler: (call) => {
          const body = JSON.parse(call.body);
          assert.equal(body.content, Buffer.from('beta').toString('base64'));
          assert.equal(body.sha, 'sha-bbb');
          putCalls++;
          return jsonRes(200, { content: { path: 'files/b.txt' } });
        },
      },
    ]);

    const out = await runConnectorAction('github', 'push-files', { repo: 'octocat/repo' }, { outDir });
    assert.equal(out.ok, true);
    assert.equal(putCalls, 2);
    assert.deepEqual(out.result.pushed, [
      { path: 'files/a.txt', status: 'updated' },
      { path: 'files/b.txt', status: 'updated' },
    ]);
  }));

test('push-files uses explicit files arg when provided', () =>
  withRunDir(async (outDir) => {
    process.env.GITHUB_TOKEN = 'tok';
    activeStub = installFetch([
      { url: /contents\/x\.js$/, method: 'GET', status: 404 },
      { url: /contents\/x\.js$/, method: 'PUT', status: 201, body: { content: {} } },
    ]);
    await runConnectorAction(
      'github',
      'push-files',
      { repo: 'octocat/repo', files: [{ path: 'x.js', content: 'console.log(1)' }] },
      { outDir },
    );
    const put = activeStub.calls.find((c) => c.method === 'PUT');
    const body = JSON.parse(put.body);
    assert.equal(body.content, Buffer.from('console.log(1)').toString('base64'));
  }));

test('list-repos maps repos and defaults per_page to 20', async () => {
  process.env.GITHUB_TOKEN = 'tok';
  activeStub = installFetch([
    {
      url: 'https://api.github.com/user/repos?per_page=20&sort=updated',
      method: 'GET',
      body: [
        { full_name: 'a/b', html_url: 'https://github.com/a/b', private: false },
        { full_name: 'c/d', html_url: 'https://github.com/c/d', private: true },
      ],
    },
  ]);
  const out = await runConnectorAction('github', 'list-repos', {});
  assert.deepEqual(out.result.repos, [
    { full_name: 'a/b', html_url: 'https://github.com/a/b', private: false },
    { full_name: 'c/d', html_url: 'https://github.com/c/d', private: true },
  ]);
});

test('list-repos honors per_page arg', async () => {
  process.env.GITHUB_TOKEN = 'tok';
  activeStub = installFetch([{ url: 'https://api.github.com/user/repos?per_page=5&sort=updated', body: [] }]);
  await runConnectorAction('github', 'list-repos', { per_page: 5 });
  assert.equal(activeStub.calls[0].url, 'https://api.github.com/user/repos?per_page=5&sort=updated');
});

test('drive upload refreshes token then multipart uploads', () =>
  withRunDir(async (outDir) => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csecret';
    process.env.GOOGLE_REFRESH_TOKEN = 'refreshme';
    await makeRunWithFiles(outDir, 'run-1', { 'doc.txt': 'drive bytes here' });

    let uploadCallBody = null;
    let uploadCallHeaders = null;
    let refreshCallBody = null;
    activeStub = installFetch([
      {
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        handler: (call) => {
          refreshCallBody = call.body;
          return jsonRes(200, { access_token: 'access-tok' });
        },
      },
      {
        url: /upload\/drive\/v3\/files\?uploadType=multipart/,
        method: 'POST',
        handler: (call) => {
          uploadCallBody = call.body;
          uploadCallHeaders = call.headers;
          return jsonRes(200, { id: 'DRIVEID', webViewLink: 'https://drive.google.com/file/d/DRIVEID/view' });
        },
      },
    ]);

    const out = await runConnectorAction('google-drive', 'upload-files', { folderId: 'F1' }, { outDir });

    const refresh = new URLSearchParams(refreshCallBody);
    assert.equal(refresh.get('grant_type'), 'refresh_token');
    assert.equal(refresh.get('client_id'), 'cid');
    assert.equal(refresh.get('refresh_token'), 'refreshme');

    const contentType = uploadCallHeaders['Content-Type'];
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    const boundary = contentType.match(/boundary=([^;]+)/)[1];
    assert.ok(`--${boundary}`.length > 10);

    const text = Buffer.from(uploadCallBody).toString('utf8');
    assert.ok(text.includes(`--${boundary}`), 'multipart boundary present');
    assert.ok(text.includes('"name":"doc.txt"'), 'metadata part contains name');
    assert.ok(text.includes('"parents":["F1"]'), 'metadata part contains parents');
    assert.ok(uploadCallBody.includes(Buffer.from('drive bytes here')), 'bytes part contains file content');
    assert.match(uploadCallHeaders.Authorization, /^Bearer access-tok$/);

    assert.deepEqual(out.result.uploaded, [
      { name: 'doc.txt', id: 'DRIVEID', webViewLink: 'https://drive.google.com/file/d/DRIVEID/view' },
    ]);
    assert.equal(out.result.folderId, 'F1');
  }));

test('drive upload omits parents when no folderId', () =>
  withRunDir(async (outDir) => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'cs';
    process.env.GOOGLE_REFRESH_TOKEN = 'rt';
    await makeRunWithFiles(outDir, 'r', { 'x.txt': 'x' });
    let text = null;
    activeStub = installFetch([
      { url: 'https://oauth2.googleapis.com/token', method: 'POST', body: { access_token: 't' } },
      {
        url: /uploadType=multipart/,
        method: 'POST',
        handler: (call) => {
          text = Buffer.from(call.body).toString('utf8');
          return jsonRes(200, { id: '1', webViewLink: 'https://d/1' });
        },
      },
    ]);
    await runConnectorAction('google-drive', 'upload-files', {}, { outDir });
    assert.ok(!text.includes('parents'), 'no parents when folderId omitted');
  }));

test('drive status connected / needs-setup / error', async () => {
  process.env.GOOGLE_CLIENT_ID = 'c';
  process.env.GOOGLE_CLIENT_SECRET = 's';
  process.env.GOOGLE_REFRESH_TOKEN = 'r';
  activeStub = installFetch([{ url: 'https://oauth2.googleapis.com/token', method: 'POST', body: { access_token: 'a' } }]);
  assert.equal((await connectorStatus('google-drive')).status, 'connected');

  activeStub.restore();
  delete process.env.GOOGLE_CLIENT_ID;
  activeStub = installFetch([]);
  assert.equal((await connectorStatus('google-drive')).status, 'needs-setup');

  activeStub.restore();
  process.env.GOOGLE_CLIENT_ID = 'c';
  activeStub = installFetch([{ url: 'https://oauth2.googleapis.com/token', method: 'POST', status: 400, body: {} }]);
  assert.equal((await connectorStatus('google-drive')).status, 'error');
});

test('webhook always connected', async () => {
  activeStub = installFetch([]);
  const st = await connectorStatus('webhook');
  assert.equal(st.status, 'connected');
  assert.deepEqual(st.actions, ['send']);
});

test('webhook send posts JSON with default payload from last run', () =>
  withRunDir(async (outDir) => {
    await makeRunWithFiles(outDir, 'run-x', { 'f1.txt': 'a', 'f2.md': 'b' });
    let seenBody = null;
    activeStub = installFetch([
      {
        url: 'https://example.com/hook',
        method: 'POST',
        handler: (call) => {
          seenBody = call.body;
          return new Response(null, { status: 204 });
        },
      },
    ]);
    const out = await runConnectorAction('webhook', 'send', { url: 'https://example.com/hook' }, { outDir });
    const payload = JSON.parse(seenBody);
    assert.equal(payload.source, 'the-orchestrator');
    assert.ok(!Number.isNaN(Date.parse(payload.ts)));
    assert.deepEqual(payload.files, ['f1.txt', 'f2.md']);
    assert.deepEqual(out, { ok: true, result: { status: 204, ok: true } });
  }));

test('webhook send passes explicit payload through', async () => {
  let seenBody = null;
  activeStub = installFetch([
    {
      url: 'https://x.dev/w',
      method: 'POST',
      handler: (call) => {
        seenBody = call.body;
        return jsonRes(200, { received: true });
      },
    },
  ]);
  const out = await runConnectorAction('webhook', 'send', { url: 'https://x.dev/w', payload: { custom: 42 } });
  assert.deepEqual(JSON.parse(seenBody), { custom: 42 });
  assert.equal(out.result.status, 200);
  assert.equal(out.result.ok, true);
});

test('webhook send validates url', async () => {
  activeStub = installFetch([]);
  await assert.rejects(
    () => runConnectorAction('webhook', 'send', { url: 'not-a-url' }, {}),
    (e) => e instanceof ConnectorError && e.code === 'invalid',
  );
});

test('lastRunDir picks newest subdir by mtime', () =>
  withRunDir(async (outDir) => {
    const oldDir = path.join(outDir, 'run-old');
    const newDir = path.join(outDir, 'run-new');
    await fs.mkdir(oldDir);
    await fs.mkdir(newDir);
    const base = Date.now() - 100_000;
    await fs.utimes(oldDir, new Date(base), new Date(base));
    await fs.utimes(newDir, new Date(base + 60_000), new Date(base + 60_000));
    assert.equal(await lastRunDir(outDir), newDir);
  }));

test('lastRunDir returns null for empty or missing dir', async () => {
  assert.equal(await lastRunDir('C:\\definitely-not-a-real-dir-xyz'), null);
  await withRunDir(async (outDir) => {
    assert.equal(await lastRunDir(outDir), null);
  });
});

test('listConnectorStatuses returns all connectors', async () => {
  activeStub = installFetch([
    { url: /api\.github\.com\/user$/, body: { login: 'x' } },
    { url: 'https://oauth2.googleapis.com/token', method: 'POST', body: { access_token: 'a' } },
  ]);
  process.env.GITHUB_TOKEN = 't';
  process.env.GOOGLE_CLIENT_ID = 'c';
  process.env.GOOGLE_CLIENT_SECRET = 's';
  process.env.GOOGLE_REFRESH_TOKEN = 'r';
  const sts = await listConnectorStatuses({});
  assert.deepEqual(sts.map((s) => s.id), ['github', 'google-drive', 'webhook']);
  assert.equal(sts[0].status, 'connected');
  assert.equal(sts[1].status, 'connected');
  assert.equal(sts[2].status, 'connected');
});

test('unknown connector throws ConnectorError invalid', async () => {
  activeStub = installFetch([]);
  await assert.rejects(() => connectorStatus('nope'), (e) => e instanceof ConnectorError && e.code === 'invalid');
  await assert.rejects(
    () => runConnectorAction('github', 'bogus', {}),
    (e) => e instanceof ConnectorError && e.code === 'invalid',
  );
});

test('CONNECTORS export is exact shape', () => {
  assert.deepEqual(
    CONNECTORS.map(({ id, actions }) => ({ id, actions })),
    [
      { id: 'github', actions: ['create-repo', 'push-files', 'list-repos'] },
      { id: 'google-drive', actions: ['upload-files'] },
      { id: 'webhook', actions: ['send'] },
    ],
  );
});