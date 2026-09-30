/* e2e-live-pipeline.test.js — TRUE end-to-end test of the Node harness.
 *
 * Unlike test/pipeline-smoke.test.js (which injects a fake client object), this
 * test drives the REAL Web2ApiClient over REAL HTTP against a local stub server
 * that speaks the exact Web2API SSE contract:
 *
 *   POST /api/chat   ->  event: delta / event: done
 *   GET  /api/providers
 *   GET  /healthz
 *   POST /api/reload
 *
 * That proves the whole harness chain (client -> SSE parse -> orchestrator ->
 * planner -> router -> file harness -> disk writes -> pure-node ZIP -> manifest)
 * works end to end with no browser cookies and no external services.
 *
 * It does NOT prove provider parsing/authentication against the real ChatGPT /
 * Gemini / Perplexity endpoints — that needs a logged-in browser session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Web2ApiClient } from '../harness/web2api-client.js';
import { runPipeline } from '../harness/orchestrator.js';
import { Store } from '../harness/store.js';

const PLAN_FIXTURE = JSON.stringify([
  { description: 'Analyse the requested dashboard', type: 'analysis' },
  { description: 'Implement the dashboard code', type: 'code' },
]);

function sse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/* Stub that mimics vendor/web2api's FastAPI app closely enough for the client. */
function startStubServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname === '/api/providers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers: [
        { id: 'chatgpt', label: 'ChatGPT', available: true },
        { id: 'gemini', label: 'Gemini', available: true },
        { id: 'perplexity', label: 'Perplexity', available: true },
      ] }));
      return;
    }

    if (url.pathname === '/api/reload') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const message = String(body.message || '');
      calls.push({ provider: body.provider, message });

      // Route by the same discriminators the real brain prompts use.
      let content;
      if (message.includes('agent selection system')) {
        content = '{"selected":["chatgpt","gemini"],"reasoning":"stub"}';
      } else if (message.includes('specific subtasks for this goal')) {
        content = PLAN_FIXTURE;
      } else if (message.includes('Generate a single self-contained HTML file')) {
        content = 'Synthesis done.\n<file name="index.html"><h1>Dashboard</h1></file>';
      } else {
        content = `Worked on: ${message.slice(0, 40)}\n`
          + '<file name="src/app.js">export const answer = 42;</file>\n'
          + '<file name="README.md"># Orchestrator e2e</file>';
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Stream in two deltas, then the done payload — exercises the SSE parser.
      const half = Math.max(1, Math.floor(content.length / 2));
      res.write(sse('delta', { content: content.slice(0, half) }));
      res.write(sse('delta', { content: content.slice(half) }));
      res.write(sse('done', { content, session: { turn: calls.length } }));
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('e2e: full harness pipeline over real HTTP + real SSE + real SSE-streaming client', async () => {
  const { server, calls, baseUrl } = await startStubServer();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-e2e-'));
  const outDir = path.join(tmp, 'run');

  try {
    const client = new Web2ApiClient({ baseUrl, timeoutMs: 15000 });
    const store = new Store(path.join(tmp, '.state'));
    const events = [];

    // Pre-flight parity with the CLI.
    const providers = await client.providers();
    assert.equal(providers.length, 3, 'stub advertises 3 providers');

    const result = await runPipeline({
      goal: 'Build a dashboard app',
      projectFiles: { 'notes.txt': 'existing note' },
      outDir,
      autoConfirm: true,
      runSettings: { retries: 1, maxAgents: 4 },
      onEvent: (e) => events.push(e),
      client,
      store,
    });

    assert.equal(result.ok, true, `pipeline ok (error: ${result.error})`);

    // Every stage must have run.
    const steps = events.filter((e) => e.type === 'step').map((e) => e.step);
    for (const wanted of ['providers', 'agent-selection', 'planning', 'ordering', 'running', 'synthesis', 'files', 'done']) {
      assert.ok(steps.includes(wanted), `stage "${wanted}" ran (got: ${steps.join(',')})`);
    }

    // Tasks were planned, routed and completed.
    assert.ok(result.tasks.length >= 2, 'at least 2 tasks planned');
    assert.ok(result.tasks.every((t) => t.assignedTo), 'every task routed to an agent');
    assert.equal(result.tasks.filter((t) => t.status === 'done').length, result.tasks.length, 'all tasks done');

    // The brain was asked to select agents + plan + synthesise; specialists ran tasks.
    const providersHit = new Set(calls.map((c) => c.provider));
    assert.ok(providersHit.has('chatgpt'), 'brain (chatgpt) was called');
    assert.ok(providersHit.has('gemini'), 'second agent was called');

    // Files were extracted from agent output and written to disk.
    assert.ok(result.files.length >= 2, `files extracted (got ${result.files.length})`);
    const written = await fsp.readdir(path.join(outDir, 'files'));
    assert.ok(written.includes('app.js') || written.length > 0, 'files landed on disk');

    // Zip was produced and is a structurally valid ZIP.
    assert.ok(result.zipPath && result.zipPath.endsWith('.zip'), 'zip path set');
    const zip = await fsp.readFile(result.zipPath);
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'valid local file header signature');

    // Synthesis ran (brain was invoked with the synthesis prompt).
    assert.ok(calls.some((c) => c.message.includes('Generate a single self-contained HTML file')), 'synthesis prompt sent');
    assert.ok(String(result.synthesis || '').length > 0, 'synthesis produced output');
  } finally {
    server.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('e2e: client maps a provider error event to a retryable Web2ApiError', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/chat')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse('error', { message: 'provider blew up' }));
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // No retry wrapper here — call the streaming path directly through chat().
    const client = new Web2ApiClient({ baseUrl, timeoutMs: 5000 });
    await assert.rejects(
      () => client.chat({ provider: 'gemini', message: 'hi' }),
      (err) => {
        assert.equal(err.name, 'Web2ApiError');
        assert.equal(err.code, 'provider');
        assert.ok(err.message.includes('provider blew up'));
        return true;
      },
    );
  } finally {
    server.close();
  }
});