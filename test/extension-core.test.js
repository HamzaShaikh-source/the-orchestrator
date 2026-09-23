/* extension-core.test.js — tests for the self-contained extension core.
   Pure ESM modules; no chrome APIs. Run: node --test test/extension-core.test.js */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

import { sha3_512 } from '../extension/core/sha3.js';
import { getConfig, getRequirementsToken, getAnswerToken, b64encode } from '../extension/core/proofofwork.js';
import { parseGeminiFrames, extractGeminiText } from '../extension/core/providers.js';
import { zipFiles } from '../extension/core/zip.js';
import { extractFiles, collectRunArtifacts, sanitizeRelPath } from '../extension/core/file-harness.js';
import { orderTasksByDependency, slugify } from '../extension/core/orchestrator.js';
import { MemoryStore } from '../extension/core/store.js';

/* ── SHA3-512 known-answer tests ── */

test('sha3-512: empty string KAT', () => {
  const hex = Buffer.from(sha3_512(new Uint8Array(0))).toString('hex');
  assert.equal(hex, 'a69f73cca23a9ac5c8b567dc185a756e97c982164fe25859e0d1dcc1475c80a615b2123af1f5f94c11e3e9402c3ac558f500199d95b6d3e301758586281dcd26');
});

test('sha3-512: "abc" KAT', () => {
  const hex = Buffer.from(sha3_512(new TextEncoder().encode('abc'))).toString('hex');
  assert.equal(hex, 'b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0');
});

test('sha3-512: long input (1KB) deterministic', () => {
  const input = new Uint8Array(1024).fill(0x61);
  const a = Buffer.from(sha3_512(input)).toString('hex');
  const b = Buffer.from(sha3_512(input)).toString('hex');
  assert.equal(a, b);
  assert.equal(a.length, 128);
});

/* ── Proof of work ── */

test('proofofwork: requirements token format', () => {
  const config = getConfig('test-agent');
  assert.equal(config.length, 18);
  const token = getRequirementsToken(config);
  assert.ok(token.startsWith('gAAAAAC'), 'requirements token prefix');
  assert.ok(token.length > 20);
});

test('proofofwork: answer token format + b64', () => {
  const config = getConfig('test-agent');
  const { token, solved } = getAnswerToken('seed', '0fffff', config);
  assert.ok(token.startsWith('gAAAAAB'), 'answer token prefix');
  assert.equal(typeof solved, 'boolean');
  const decoded = Buffer.from(token.slice(7), 'base64').toString('utf8');
  assert.ok(decoded.length > 0);
});

test('b64encode: known vector', () => {
  assert.equal(b64encode(new TextEncoder().encode('hello')), 'aGVsbG8=');
});

/* ── Gemini frame parser ── */

test('gemini: parse length-prefixed frames', () => {
  const frame = JSON.stringify([null, '["x"]']);
  const content = `)]}'\n\n${frame.length}\n${frame}\n\n`;
  const frames = parseGeminiFrames(content);
  assert.ok(Array.isArray(frames));
  assert.ok(frames.length >= 1);
});

test('gemini: extract text from nested candidate', () => {
  const inner = JSON.stringify([
    null,
    ['conv-id', 'resp-id'],
    null,
    null,
    [[['choice-id'], ['The answer text']]],
  ]);
  // Real frame is [null, null, inner]; chunk carries one frame per web2api's
  // own test (frames = [[None, None, inner]]), so extend yields one frame.
  const chunk = JSON.stringify([[null, null, inner]]);
  const content = `)]}'\n\n${chunk.length}\n${chunk}\n\n`;
  const frames = parseGeminiFrames(content);
  const text = extractGeminiText(frames);
  assert.equal(text, 'The answer text');
});

test('gemini: fallback regex extracts text from flattened frame', () => {
  // If the chunk is a bare frame, extend flattens it; the \u003cp\u003e
  // fallback regex must still recover the text (mirrors parser.py).
  // Inner string carries single-backslash \u003c escapes, as on the wire.
  const inner =
    '[null,["conv-id","resp-id"],null,null,[[["choice-id"],["\\u003cp\\u003eFallback text\\u003c/p\\u003e"]]]]';
  const chunk = JSON.stringify([null, null, inner]);
  const content = `)]}'\n\n${chunk.length}\n${chunk}\n\n`;
  const frames = parseGeminiFrames(content);
  const text = extractGeminiText(frames);
  assert.equal(text, 'Fallback text');
});

/* ── ZIP writer ── */

test('zip: roundtrip single file', async () => {
  const blob = await zipFiles([{ name: 'hello.txt', content: 'Hello, world!' }]);
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local header signature');
  const nameLen = buf.readUInt16LE(26);
  const compLen = buf.readUInt32LE(18);
  const name = buf.subarray(30, 30 + nameLen).toString('utf8');
  assert.equal(name, 'hello.txt');
  const compressed = buf.subarray(30 + nameLen, 30 + nameLen + compLen);
  const inflated = inflateRawSync(compressed).toString('utf8');
  assert.equal(inflated, 'Hello, world!');
});

test('zip: roundtrip nested + unicode', async () => {
  const blob = await zipFiles([
    { name: 'src/app.js', content: 'console.log("héllo");' },
    { name: 'README.md', content: '# Test\n' },
  ]);
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const nameLen = buf.readUInt16LE(26);
  const compLen = buf.readUInt32LE(18);
  const name = buf.subarray(30, 30 + nameLen).toString('utf8');
  assert.equal(name, 'src/app.js');
  const inflated = inflateRawSync(buf.subarray(30 + nameLen, 30 + nameLen + compLen)).toString('utf8');
  assert.equal(inflated, 'console.log("héllo");');
});

/* ── File extraction ── */

test('extractFiles: file tags', () => {
  const files = extractFiles('<file name="index.html">\n<h1>Hi</h1>\n</file>\n<file name="app.js">\nconsole.log(1);\n</file>');
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'index.html');
  assert.ok(files[0].content.includes('<h1>Hi</h1>'));
});

test('extractFiles: fenced snippets fallback', () => {
  const files = extractFiles('```js\nconst x = 1;\n```\n```html\n<p>y</p>\n```');
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'snippet-1.js');
  assert.equal(files[1].name, 'snippet-2.html');
});

test('sanitizeRelPath: traversal rejected', () => {
  assert.throws(() => sanitizeRelPath('../evil.txt'));
  assert.throws(() => sanitizeRelPath('a/../../b'));
  assert.equal(sanitizeRelPath('a\\b\\c.txt'), 'a/b/c.txt');
});

test('collectRunArtifacts: conflict detection', () => {
  const { files, conflicts } = collectRunArtifacts({
    text: { label: 'agent1', text: '<file name="a.txt">one</file>' },
    extraTexts: [{ label: 'agent2', text: '<file name="a.txt">two</file>' }],
  });
  assert.equal(files.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].name, 'a.txt');
  assert.deepEqual(conflicts[0].from.sort(), ['agent1', 'agent2']);
});

/* ── Orchestrator helpers ── */

test('orderTasksByDependency: analysis before code', () => {
  const tasks = [
    { id: 't1', type: 'code' },
    { id: 't2', type: 'analysis' },
    { id: 't3', type: 'design' },
  ];
  const ordered = orderTasksByDependency(tasks);
  assert.equal(ordered[0].type, 'analysis');
  assert.equal(ordered[1].type, 'design');
  assert.equal(ordered[2].type, 'code');
});

test('slugify: sanitizes goal', () => {
  assert.equal(slugify('Build a Landing Page!'), 'build-a-landing-page');
  assert.equal(slugify(''), 'run');
});

/* ── Store ── */

test('MemoryStore: get/set/remove', async () => {
  const store = new MemoryStore();
  assert.equal(await store.get('k', 'd'), 'd');
  await store.set('k', { a: 1 });
  assert.deepEqual(await store.get('k'), { a: 1 });
  await store.remove('k');
  assert.equal(await store.get('k', null), null);
});