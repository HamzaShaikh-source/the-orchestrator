/* Integration: full runPipeline with stub Web2API client — no network, no cookies */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runPipeline } from '../harness/orchestrator.js';
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
        content = 'Plain task output from ' + provider + '.';
      }
      onDelta?.(content);
      return { content, session: { conversation_id: `s-${calls.length}` }, provider };
    },
  };
}

test('full pipeline: plan -> parallel route -> execute -> synthesis -> files -> zip', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-int-'));
  const store = new Store(path.join(tmp, 'state'));
  const outDir = path.join(tmp, 'run');
  await fs.mkdir(outDir, { recursive: true });

  const events = [];
  const result = await runPipeline({
    goal: 'Build a simple landing page',
    projectFiles: {},
    outDir,
    autoConfirm: true,
    runSettings: { retries: 1, maxAgents: 3 },
    onEvent: (e) => events.push(e.type),
    client: makeStubClient(),
    store,
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.tasks.length >= 2, 'planned tasks');
  assert.ok(result.tasks.every((t) => t.status === 'done'), 'all tasks done');
  assert.ok(result.synthesis.length > 0, 'synthesis produced');

  /* file creator wrote extracted files */
  assert.ok(result.files.length >= 1, 'files extracted');
  for (const f of result.files) {
    const abs = path.join(outDir, 'files', f.name);
    const body = await fs.readFile(abs, 'utf8');
    assert.ok(body.length > 0, `${f.name} non-empty`);
    assert.ok(!abs.includes('..'), 'no traversal');
  }

  /* zip valid */
  assert.ok(result.zipPath, 'zip path set');
  const zipBuf = await fs.readFile(result.zipPath);
  assert.equal(zipBuf[0], 0x50); /* P */
  assert.equal(zipBuf[1], 0x4b); /* K */

  /* event stream contains the expected phases */
  for (const step of ['step', 'task-start', 'task-done']) {
    assert.ok(events.includes(step), `event ${step} emitted`);
  }

  /* chat record persisted */
  const chats = await store.get('multiAgentChats', []);
  assert.ok(chats.length === 1 && chats[0].status === 'done', 'chat saved');

  await fs.rm(tmp, { recursive: true, force: true });
});

test('pipeline fails fast with clear error when no providers', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-int2-'));
  const client = {
    async providers() { return []; },
    async chat() { throw new Error('should not be called'); },
  };
  await assert.rejects(
    () => runPipeline({
      goal: 'x',
      outDir: tmp,
      client,
      store: new Store(path.join(tmp, 'state')),
    }),
    (err) => err.code === 'unconfigured'
  );
  await fs.rm(tmp, { recursive: true, force: true });
});
