/* file-harness tests — node:test, dependency-free module */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  extractFiles,
  sanitizeRelPath,
  writeFiles,
  collectRunArtifacts,
  zipDir,
} from '../harness/file-harness.js';

async function tmpDir() {
  return mkdtemp(path.join(os.tmpdir(), 'fh-'));
}

test('extractFiles: primary <file> mode with double and single quotes', () => {
  const out = extractFiles('<file name="a.js">const a = 1;</file>\n<file name=\'b.css\'>body{}</file>');
  assert.equal(out.length, 2);
  const a = out.find((f) => f.name === 'a.js');
  assert.ok(a);
  assert.equal(a.content, 'const a = 1;');
  assert.ok(out.find((f) => f.name === 'b.css' && f.content === 'body{}'));
});

test('extractFiles: fenced-code fallback when no <file> tags', () => {
  const out = extractFiles('Here is code:\n```js\nconst x = 1;\n```\nand python:\n```python\nprint(1)\n```\nand unknown:\n```\nplain\n```');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((f) => f.name), ['snippet-1.js', 'snippet-2.py', 'snippet-3.txt']);
  assert.equal(out[0].content, 'const x = 1;');
  assert.equal(out[1].content, 'print(1)');
});

test('extractFiles: <file> tags present, fences ignored', () => {
  const out = extractFiles('<file name="index.html">pick this</file>\n```js\nnot this\n```');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'index.html');
  assert.equal(out[0].content, 'pick this');
});

test('extractFiles: dedupe by name, later wins', () => {
  const out = extractFiles('<file name="x.js">v1</file> text <file name="x.js">v2</file>');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'x.js');
  assert.equal(out[0].content, 'v2');
});

test('extractFiles: JSON lang maps and empty input', () => {
  assert.equal(extractFiles('```json\n{"a":1}\n```')[0].name, 'snippet-1.json');
  assert.deepEqual(extractFiles(''), []);
  assert.deepEqual(extractFiles('no fences here'), []);
});

test('sanitizeRelPath: rejects traversal', () => {
  assert.throws(() => sanitizeRelPath('../evil'), /traversal/);
  assert.throws(() => sanitizeRelPath('a/../../b'), /traversal/);
  assert.throws(() => sanitizeRelPath('..'), /traversal/);
});

test('sanitizeRelPath: strips absolute and collapses backslashes', () => {
  assert.equal(sanitizeRelPath('/etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeRelPath('//foo'), 'foo');
  assert.equal(sanitizeRelPath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(sanitizeRelPath('sub/./x.txt'), 'sub/x.txt');
});

test('sanitizeRelPath: replaces illegal Windows chars', () => {
  assert.equal(sanitizeRelPath('a<b>c:d|e?f*g.txt'), 'a_b_c_d_e_f_g.txt');
  assert.equal(sanitizeRelPath('C:\\Program Files'), 'C_/Program Files');
});

test('sanitizeRelPath: length cap and empties', () => {
  assert.ok(sanitizeRelPath('x'.repeat(500)).length <= 200);
  assert.throws(() => sanitizeRelPath(''));
  assert.throws(() => sanitizeRelPath('   '));
  assert.throws(() => sanitizeRelPath('///'));
});

test('writeFiles: traversal attempt throws', async () => {
  const dir = await tmpDir();
  try {
    await assert.rejects(writeFiles([{ name: '../evil.txt', content: 'x' }], dir), /traversal|escapes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFiles: writes files; identical rewrite is skipped', async () => {
  const dir = await tmpDir();
  try {
    const first = await writeFiles([{ name: 'nested/a/b/c.txt', content: 'hello' }], dir);
    assert.equal(first[0].status, 'written');
    assert.equal(first[0].bytes, 5);
    const onDisk = await readFile(path.join(dir, 'nested', 'a', 'b', 'c.txt'), 'utf8');
    assert.equal(onDisk, 'hello');

    const second = await writeFiles([{ name: 'nested/a/b/c.txt', content: 'hello' }], dir);
    assert.equal(second[0].status, 'skipped-identical');

    const third = await writeFiles([{ name: 'nested/a/b/c.txt', content: 'changed' }], dir);
    assert.equal(third[0].status, 'written');
    assert.equal(await readFile(path.join(dir, 'nested', 'a', 'b', 'c.txt'), 'utf8'), 'changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zipDir: produces a valid STORE zip', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello world');
    await writeFile(path.join(dir, 'b.txt'), 'second file content');
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'sub', 'c.md'), '# nested');
    const zipPath = path.join(dir, 'out.zip');

    const returned = await zipDir(dir, zipPath);
    assert.equal(returned, zipPath);

    const buf = await readFile(zipPath);
    assert.ok(buf.length > 0, 'zip not empty');
    assert.ok(
      buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      'missing local file header magic PK\\x03\\x04',
    );
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    assert.ok(buf.includes(eocd), 'missing EOCD magic PK\\x05\\x06');

    const contentSum = (await readFile(path.join(dir, 'a.txt'))).length
      + (await readFile(path.join(dir, 'b.txt'))).length
      + (await readFile(path.join(dir, 'sub', 'c.md'))).length;
    assert.ok(buf.length > contentSum, 'zip size should exceed sum of file contents');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectRunArtifacts: conflict detection and later-wins', async () => {
  const dir = await tmpDir();
  try {
    const runDir = path.join(dir, 'run');
    const manifest = await collectRunArtifacts({
      runDir,
      text: '<file name="app.js">v1</file>',
      extraTexts: [
        { label: 'gemini', text: '<file name="app.js">v2</file>' },
        { label: 'perplexity', text: '<file name="readme.md"># readme</file>' },
      ],
    });

    assert.equal(manifest.files.length, 2);
    assert.equal(manifest.conflicts.length, 1);
    assert.equal(manifest.conflicts[0].name, 'app.js');
    assert.ok(manifest.conflicts[0].from.includes('main'));
    assert.ok(manifest.conflicts[0].from.includes('gemini'));

    const written = await readFile(path.join(runDir, 'files', 'app.js'), 'utf8');
    assert.equal(written, 'v2', 'later input wins');
    assert.equal(await readFile(path.join(runDir, 'files', 'readme.md'), 'utf8'), '# readme');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectRunArtifacts: identical content across labels is not a conflict', async () => {
  const dir = await tmpDir();
  try {
    const manifest = await collectRunArtifacts({
      runDir: path.join(dir, 'run2'),
      text: { label: 'chatgpt', text: '<file name="same.txt">identical</file>' },
      extraTexts: [{ label: 'perplexity', text: '<file name="same.txt">identical</file>' }],
    });
    assert.equal(manifest.conflicts.length, 0);
    assert.equal(manifest.files.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});