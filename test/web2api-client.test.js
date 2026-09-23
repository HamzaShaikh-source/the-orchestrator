import test from 'node:test';
import assert from 'node:assert/strict';
import { Web2ApiClient, Web2ApiError, RETRY_POLICY, splitTurns } from '../harness/web2api-client.js';

const realFetch = global.fetch;

function withFetch(t, impl) {
  global.fetch = impl;
  t.after(() => {
    global.fetch = realFetch;
  });
}

function fastRetry(t) {
  const saved = { ...RETRY_POLICY };
  RETRY_POLICY.baseDelayMs = 5;
  RETRY_POLICY.maxDelayMs = 10;
  t.after(() => Object.assign(RETRY_POLICY, saved));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events) {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function chunkedSseResponse(parts) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('SSE parse: multi-event stream across chunk boundaries', async (t) => {
  let calls = 0;
  withFetch(t, async (url, init) => {
    calls += 1;
    assert.ok(String(url).endsWith('/api/chat'));
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.provider, 'chatgpt');
    assert.equal(body.message, 'Hello');
    assert.equal(body.model_id, 'auto');
    assert.equal(body.web_search, true);
    assert.equal(body.session, null);
    return chunkedSseResponse([
      'event: del',
      'ta\ndata: {"content":"Hel"}\n\nevent: delta\ndata: {"content":"Hello"}\n\n',
      'event: done\ndata: {"content":"Hello world","session":{"conversation_id":"c1"}}\n\n',
    ]);
  });

  const client = new Web2ApiClient();
  const deltas = [];
  const result = await client.chat({
    provider: 'chatgpt',
    message: 'Hello',
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(calls, 1);
  assert.deepEqual(deltas, ['Hel', 'Hello']);
  assert.equal(result.content, 'Hello world');
  assert.deepEqual(result.session, { conversation_id: 'c1' });
  assert.equal(result.provider, 'chatgpt');
});

test('long message: splits at paragraphs, chains sessions, concatenates content', async (t) => {
  const paragraphs = Array.from({ length: 5 }, (_, i) => `paragraph ${i} ${'x'.repeat(2000)}`);
  const message = paragraphs.join('\n\n');
  assert.ok(message.length > 7500);

  const bodies = [];
  withFetch(t, async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const n = bodies.length;
    return sseResponse([
      { event: 'delta', data: { content: `part${n}` } },
      { event: 'done', data: { content: `part${n}`, session: { step: n } } },
    ]);
  });

  const inputSession = { seed: true };
  const client = new Web2ApiClient();
  const result = await client.chat({
    provider: 'chatgpt',
    message,
    session: inputSession,
  });

  assert.ok(bodies.length >= 2, `expected multiple turns, got ${bodies.length}`);
  for (const body of bodies) {
    assert.ok(body.message.length <= 7500, `turn exceeds budget: ${body.message.length}`);
  }
  assert.equal(bodies.map((b) => b.message).join(''), message);

  assert.deepEqual(bodies[0].session, inputSession);
  for (let i = 1; i < bodies.length; i += 1) {
    assert.deepEqual(bodies[i].session, { step: i });
  }

  assert.equal(result.content, bodies.map((_, i) => `part${i + 1}`).join(''));
  assert.deepEqual(result.session, { step: bodies.length });
  assert.equal(result.provider, 'chatgpt');
});

test('splitTurns: short message stays single turn; long no-paragraph text hard-splits', () => {
  assert.deepEqual(splitTurns('short'), ['short']);
  const long = 'y'.repeat(16000);
  const turns = splitTurns(long, 7500);
  assert.equal(turns.length, 3);
  assert.equal(turns.join(''), long);
  for (const turn of turns) assert.ok(turn.length <= 7500);
});

test('retry: 429 then success', async (t) => {
  fastRetry(t);
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    if (calls === 1) return new Response('rate limited', { status: 429 });
    return sseResponse([{ event: 'done', data: { content: 'ok', session: null } }]);
  });

  const client = new Web2ApiClient();
  const result = await client.chat({ provider: 'gemini', message: 'hi' });
  assert.equal(result.content, 'ok');
  assert.equal(result.session, null);
  assert.equal(calls, 2);
});

test('non-retryable 401 stops after 1 attempt', async (t) => {
  fastRetry(t);
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    return jsonResponse({ detail: 'Invalid or missing API key.' }, 401);
  });

  const client = new Web2ApiClient({ apiKey: 'bad' });
  await assert.rejects(
    client.chat({ provider: 'chatgpt', message: 'hi' }),
    (err) => {
      assert.ok(err instanceof Web2ApiError);
      assert.equal(err.code, 'unauthorized');
      assert.equal(err.retryable, false);
      assert.equal(err.status, 401);
      assert.match(err.message, /API key/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('SSE error event -> Web2ApiError provider retryable', async (t) => {
  fastRetry(t);
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    return sseResponse([{ event: 'error', data: { message: 'boom' } }]);
  });

  const client = new Web2ApiClient();
  await assert.rejects(
    client.chat({ provider: 'chatgpt', message: 'x' }),
    (err) => {
      assert.ok(err instanceof Web2ApiError);
      assert.equal(err.code, 'provider');
      assert.equal(err.retryable, true);
      assert.equal(err.message, 'boom');
      return true;
    },
  );
  assert.equal(calls, RETRY_POLICY.maxAttempts);
});

test('503 "not configured" -> unconfigured, not retried', async (t) => {
  fastRetry(t);
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    return jsonResponse({ detail: 'ChatGPT is not configured.' }, 503);
  });

  const client = new Web2ApiClient();
  await assert.rejects(
    client.chat({ provider: 'chatgpt', message: 'x' }),
    (err) => {
      assert.ok(err instanceof Web2ApiError);
      assert.equal(err.code, 'unconfigured');
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('network failure -> Web2ApiError network retryable', async (t) => {
  fastRetry(t);
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return sseResponse([{ event: 'done', data: { content: 'recovered', session: null } }]);
  });

  const client = new Web2ApiClient();
  const result = await client.chat({ provider: 'perplexity', message: 'hi' });
  assert.equal(result.content, 'recovered');
  assert.equal(calls, 2);
});

test('external signal abort -> cancelled, not retryable', async (t) => {
  fastRetry(t);
  let calls = 0;
  withFetch(t, async (url, init) => {
    calls += 1;
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  });

  const controller = new AbortController();
  const client = new Web2ApiClient();
  const promise = client.chat({
    provider: 'chatgpt',
    message: 'hi',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Web2ApiError);
    assert.equal(err.code, 'cancelled');
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('health() returns {status:"ok"}', async (t) => {
  withFetch(t, async (url) => {
    assert.ok(String(url).endsWith('/healthz'));
    return jsonResponse({ status: 'ok' });
  });
  const client = new Web2ApiClient({ baseUrl: 'http://example.test/' });
  assert.deepEqual(await client.health(), { status: 'ok' });
});

test('health() network failure -> Web2ApiError network', async (t) => {
  withFetch(t, async () => {
    throw new TypeError('fetch failed');
  });
  const client = new Web2ApiClient();
  await assert.rejects(client.health(), (err) => {
    assert.ok(err instanceof Web2ApiError);
    assert.equal(err.code, 'network');
    assert.equal(err.retryable, true);
    return true;
  });
});

test('providers() parses JSON body to array, sends auth header', async (t) => {
  withFetch(t, async (url, init) => {
    assert.ok(String(url).endsWith('/api/providers'));
    assert.equal(init.headers.Authorization, 'Bearer secret');
    return jsonResponse({
      providers: [
        { id: 'chatgpt', label: 'ChatGPT', available: true },
        { id: 'gemini', label: 'Gemini', available: false },
      ],
    });
  });
  const client = new Web2ApiClient({ apiKey: 'secret' });
  const list = await client.providers();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'chatgpt');
  assert.equal(list[1].available, false);
});
