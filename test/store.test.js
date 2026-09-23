import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, sleep } from '../harness/store.js';

async function withTmpDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-store-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('set/get/delete CRUD with fallback', () =>
  withTmpDir(async (dir) => {
    const store = new Store(dir);
    assert.equal(await store.get('missing', 'fallback'), 'fallback');

    await store.set('obj', { n: 1 });
    assert.deepEqual(await store.get('obj'), { n: 1 });

    await store.set('obj', 42);
    assert.equal(await store.get('obj'), 42);

    await store.set('nullKey', null);
    assert.equal(await store.get('nullKey', 'fb'), null);

    await store.delete('obj');
    assert.equal(await store.get('obj', null), null);

    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'db.json'), 'utf8'));
    assert.ok(!('obj' in raw));
    assert.ok('nullKey' in raw);
  }));

test('constructor creates directory recursively', async () => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-store-'));
  const nested = path.join(parent, 'a', 'b', 'c');
  try {
    const store = new Store(nested);
    await store.set('k', 'v');
    const again = new Store(nested);
    assert.equal(await again.get('k'), 'v');
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test('persists across Store instances', () =>
  withTmpDir(async (dir) => {
    const a = new Store(dir);
    await a.set('plan', ['t1', 't2']);
    const b = new Store(dir);
    assert.deepEqual(await b.get('plan'), ['t1', 't2']);
  }));

test('update transforms value and passes undefined for missing key', () =>
  withTmpDir(async (dir) => {
    const store = new Store(dir);
    let seen;
    await store.update('count', (old) => {
      seen = old;
      return (old ?? 0) + 1;
    });
    assert.equal(seen, undefined);
    assert.equal(await store.get('count'), 1);

    await store.update('count', (old) => old + 1);
    assert.equal(await store.get('count'), 2);

    const fresh = new Store(dir);
    assert.equal(await fresh.get('count'), 2);
  }));

test('concurrent updates are atomic (serialized read-modify-write)', () =>
  withTmpDir(async (dir) => {
    const store = new Store(dir);
    await store.set('n', 0);
    await Promise.all(Array.from({ length: 20 }, () => store.update('n', (v) => v + 1)));
    assert.equal(await store.get('n'), 20);

    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'db.json'), 'utf8'));
    assert.equal(raw.n, 20);
  }));

test('atomic write leaves only db.json (no tmp leftovers)', () =>
  withTmpDir(async (dir) => {
    const store = new Store(dir);
    await Promise.all([
      store.set('x', 1),
      store.set('y', 2),
      store.delete('x'),
      store.update('z', () => 'zval'),
    ]);
    const files = await fsp.readdir(dir);
    assert.deepEqual(files.sort(), ['db.json']);
    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'db.json'), 'utf8'));
    assert.equal(raw.y, 2);
    assert.equal(raw.z, 'zval');
  }));

test('sleep resolves after delay', async () => {
  const start = Date.now();
  await sleep(30);
  assert.ok(Date.now() - start >= 25);
});
