/* Smoke test: full pipeline with mock clients (no network). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../extension/core/orchestrator.js';
import { MemoryStore } from '../extension/core/store.js';
import { zipFiles } from '../extension/core/zip.js';

function makeClient() {
  return {
    async providers() {
      return [
        { id: 'chatgpt', available: true },
        { id: 'gemini', available: true },
      ];
    },
    async chat({ message }) {
      if (message.includes('agent selection system')) {
        return { content: '{"selected":["chatgpt","gemini"],"reasoning":"smoke"}' };
      }
      if (message.includes('plan') && message.includes('task')) {
        return {
          content: JSON.stringify([
            { description: 'Analyze the problem', type: 'analysis' },
            { description: 'Write the solution code', type: 'code' },
          ]),
        };
      }
      if (message.includes('synthesize') || message.includes('Synthesize')) {
        return { content: 'Synthesis: combined result.' };
      }
      // Task execution: emit a file-tagged output.
      return {
        content:
          'Done.\n<file name="src/app.js">export const answer = 42;</file>\n<file name="README.md"># Smoke\n</file>',
      };
    },
  };
}

test('pipeline: full run with mock clients produces files + zip', async () => {
  const store = new MemoryStore();
  const events = [];
  const result = await runPipeline({
    goal: 'Build a tiny app',
    client: makeClient(),
    store,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
  assert.ok(result.tasks.length >= 2, 'tasks planned');
  assert.ok(result.files.length >= 2, 'files extracted');
  assert.ok(result.zipName.endsWith('.zip'), 'zip name set');
  assert.ok(events.some((e) => e.type === 'step' && e.step === 'done'), 'done step emitted');

  // Zip must be buildable from the collected files.
  const blob = await zipFiles(result.files);
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'zip local header');
});

test('pipeline: cancelled mid-run returns ok:false', async () => {
  const store = new MemoryStore();
  const ac = new AbortController();
  const client = makeClient();
  const origChat = client.chat;
  client.chat = async (opts) => {
    ac.abort();
    return origChat(opts);
  };
  const result = await runPipeline({
    goal: 'Cancel me',
    client,
    store,
    runSettings: { signal: ac.signal },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Cancelled');
});