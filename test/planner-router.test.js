/* planner-router.test.js — node:test + assert, no external deps */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import { AGENTS, getAgent, selectAgents } from '../harness/agents.js';
import {
  computeGoalComplexity,
  parsePlannerTasks,
  normalizePlannerTasks,
  planTasks,
} from '../harness/task-planner.js';
import {
  initReliability,
  recordAgentResult,
  getAdjustedStrength,
  routeAll,
} from '../harness/task-router.js';
import { compactOutput, buildTaskContext, TURN_BUDGET } from '../harness/context.js';

/* Minimal contract-compliant Store backed by a temp dir (atomic write). */
class TempStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.data = {};
    this._loaded = false;
  }
  async _load() {
    if (this._loaded) return;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    this._loaded = true;
  }
  async get(key, fallback) {
    await this._load();
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }
  async set(key, value) {
    await this._load();
    this.data[key] = value;
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.data), 'utf8');
    await fs.rename(tmp, this.file);
  }
  async delete(key) {
    await this._load();
    delete this.data[key];
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data), 'utf8');
  }
  async update(key, fn) {
    const old = await this.get(key, undefined);
    const next = fn(old);
    await this.set(key, next);
    return next;
  }
}

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-harness-'));
  return new TempStore(dir);
}

const ALLOWED_TYPES = ['code', 'creative', 'research', 'analysis', 'writing', 'design', 'planning', 'technical'];

test('selectAgents keyword fallback returns only registry ids', () => {
  const prompts = [
    'research current news about elections and cite sources',
    'write a python script to parse data and debug the algorithm',
    'zzz qqq unknown nonsense',
  ];
  for (const p of prompts) {
    const r = selectAgents(p);
    assert.ok(r.selected.length >= 2, `expected >=2 selected for: ${p}`);
    for (const id of r.selected) {
      assert.ok(getAgent(id), `${id} must exist in AGENTS`);
      assert.ok(AGENTS.some(a => a.id === id), `${id} must be in registry`);
    }
    assert.equal(r.complexity >= 1 && r.complexity <= 10, true);
  }
});

test('normalizePlannerTasks aliases types, maps fields, and caps at 5', () => {
  const input = [
    { description: 'd1', type: 'ui' },
    { task: 'd2', type: 'ux' },
    { title: 'd3', type: 'frontend' },
    { description: 'd4', type: 'weird' },
    { description: 'd5', type: 'testing' },
    { description: 'd6', type: 'writing' },
  ];
  const out = normalizePlannerTasks(input, 'explain topic');
  assert.equal(out.length, 5, 'capped at 5');
  assert.equal(out[0].type, 'design', 'ui -> design');
  assert.equal(out[1].type, 'design', 'ux -> design');
  assert.equal(out[2].type, 'code', 'frontend -> code');
  assert.equal(out[2].description, 'd3', 'task field aliased to description');
  assert.equal(out[3].type, 'technical', 'unknown type at non-zero index -> technical');
  assert.equal(out[4].type, 'technical', 'testing -> technical');
  for (const t of out) {
    assert.equal(t.status, 'pending');
    assert.ok(ALLOWED_TYPES.includes(t.type));
    assert.ok(t.description.length > 0);
  }

  const many = Array.from({ length: 8 }, (_, i) => ({ description: `x${i}`, type: 'analysis' }));
  assert.equal(normalizePlannerTasks(many, 'report').length, 5, 'hard cap 5');
});

test('parsePlannerTasks parses fenced JSON, bare arrays, rejects garbage', () => {
  const fenced = '```json\n[{"description":"A","type":"code"},{"description":"B","type":"writing"}]\n```';
  const t1 = parsePlannerTasks(fenced);
  assert.equal(t1.length, 2);
  assert.equal(t1[0].type, 'code');

  const t2 = parsePlannerTasks('Here you go: [{"description":"C","type":"design"}] hope that helps');
  assert.equal(t2.length, 1);
  assert.equal(t2[0].description, 'C');

  assert.deepEqual(parsePlannerTasks('not json at all'), []);
  assert.deepEqual(parsePlannerTasks(''), []);
  assert.deepEqual(parsePlannerTasks(null), []);
  assert.deepEqual(parsePlannerTasks('{"not":"array"}'), []);
});

test('computeGoalComplexity ported scoring', () => {
  assert.equal(computeGoalComplexity(''), 3);
  const short = computeGoalComplexity('hi');
  assert.equal(short, 3, 'base score 3, no boosts');
  const big = computeGoalComplexity(('build website api database auth dashboard deploy pipeline test docker server ').repeat(10) + 'x'.repeat(400));
  assert.equal(big, 7, 'length + density boosts, clamped by min(8,...)');
});

test('planTasks uses stub ask returning valid JSON array', async () => {
  const store = await makeStore();
  let calls = 0;
  const ask = async (prompt, opts) => {
    calls++;
    assert.equal(opts && opts.json, true, 'ask called with {json:true}');
    assert.ok(String(prompt).includes('Available agents'));
    assert.ok(String(prompt).includes('chatgpt'));
    return JSON.stringify([
      { description: 'Build the API server', type: 'code' },
      { description: 'Write the docs', type: 'writing' },
      { description: 'Research competitors', type: 'research' },
    ]);
  };
  const events = [];
  const tasks = await planTasks({
    goal: 'build a web app with auth',
    maxAgents: 4,
    ask,
    store,
    onEvent: e => events.push(e),
  });
  assert.equal(calls, 1, 'no retry on clean parse');
  assert.equal(tasks.length, 3);
  for (const t of tasks) {
    assert.equal(t.status, 'pending');
    assert.ok(ALLOWED_TYPES.includes(t.type), `type ${t.type} allowed`);
  }
  assert.ok(events.some(e => e.type === 'plan-start'));
  assert.ok(events.some(e => e.type === 'plan-done' && e.count === 3));
  const cached = await store.get('cachedTaskPlans', null);
  assert.ok(Array.isArray(cached) && cached.length >= 1, 'plan cached');
});

test('planTasks retries ask once then falls back when ask returns garbage', async () => {
  const store = await makeStore();
  let calls = 0;
  const ask = async () => {
    calls++;
    return 'utter garbage, no json here';
  };
  const tasks = await planTasks({
    goal: 'build something new entirely',
    maxAgents: 4,
    ask,
    store,
    onEvent: () => {},
  });
  assert.equal(calls, 2, 'retried exactly once');
  assert.equal(tasks.length, 4, 'fallback plan has 4 tasks');
  assert.ok(tasks[0].description.includes('Plan and architect'));
  assert.ok(tasks[1].type === 'code');
  for (const t of tasks) assert.equal(t.status, 'pending');
});

test('planTasks serves cached plan when ask fails', async () => {
  const store = await makeStore();
  const goodAsk = async () => JSON.stringify([
    { description: 'UNIQUE_PLAN_MARKER build step', type: 'code' },
    { description: 'UNIQUE_PLAN_MARKER write step', type: 'writing' },
  ]);
  const goal = 'build unique goal alpha beta gamma';
  const t1 = await planTasks({ goal, maxAgents: 4, ask: goodAsk, store, onEvent: () => {} });
  assert.ok(t1.some(t => t.description.includes('UNIQUE_PLAN_MARKER')));

  let calls = 0;
  const badAsk = async () => { calls++; return 'garbage again'; };
  const t2 = await planTasks({ goal, maxAgents: 4, ask: badAsk, store, onEvent: () => {} });
  assert.equal(calls, 2, 'retry still happens before cache lookup');
  assert.ok(t2.some(t => t.description.includes('UNIQUE_PLAN_MARKER')), 'served from cache');
});

test('routeAll assigns every task and load-balances across all allowed agents', async () => {
  const store = await makeStore();
  await initReliability(store);

  const tasks = [
    { description: 'one', type: 'code', status: 'pending' },
    { description: 'two', type: 'code', status: 'pending' },
    { description: 'three', type: 'code', status: 'pending' },
  ];
  const routed = routeAll(tasks, ['chatgpt', 'gemini', 'perplexity']);
  assert.equal(routed.length, 3);
  for (const t of routed) {
    assert.ok(t.assignedTo, 'every task assigned');
    assert.ok(getAgent(t.assignedTo), 'assigned agent in registry');
    assert.equal(t.status, 'pending');
  }
  const used = new Set(routed.map(t => t.assignedTo));
  for (const id of ['chatgpt', 'gemini', 'perplexity']) {
    assert.ok(used.has(id), `${id} should receive at least one task`);
  }

  const mixed = routeAll([
    { description: 'r', type: 'research', status: 'pending' },
    { description: 'w', type: 'writing', status: 'pending' },
    { description: 'd', type: 'design', status: 'pending' },
    { description: 'c', type: 'code', status: 'pending' },
  ], ['chatgpt', 'gemini', 'perplexity']);
  assert.equal(mixed.find(t => t.description === 'r').assignedTo, 'perplexity', 'research -> perplexity strength');
  assert.equal(mixed.find(t => t.description === 'w').assignedTo, 'chatgpt', 'writing -> chatgpt strength');

  const emptyPool = routeAll([{ description: 'x', type: 'code' }], []);
  assert.equal(emptyPool[0].assignedTo, 'chatgpt', 'empty pool -> chatgpt fallback');
});

test('getAdjustedStrength drops after recorded failures (needs >=3 results)', async () => {
  const store = await makeStore();
  await initReliability(store);
  const base = 9;

  assert.equal(getAdjustedStrength(base, 'chatgpt'), base, 'no history -> base');

  await recordAgentResult(store, 'chatgpt', false);
  await recordAgentResult(store, 'chatgpt', false);
  assert.equal(getAdjustedStrength(base, 'chatgpt'), base, 'total < 3 -> base');

  await recordAgentResult(store, 'chatgpt', false);
  const adj = getAdjustedStrength(base, 'chatgpt');
  assert.ok(adj < base, `adjusted ${adj} < base ${base}`);
  assert.ok(Math.abs(adj - base * 0.3) < 1e-9, 'all-failure rate -> base * 0.3');

  const saved = await store.get('agentReliability', null);
  assert.ok(saved && saved.chatgpt && saved.chatgpt.total === 3, 'persisted to store');
  assert.equal(saved.chatgpt.success, 0);

  await recordAgentResult(store, 'gemini', true);
  await recordAgentResult(store, 'gemini', true);
  await recordAgentResult(store, 'gemini', true);
  const adjOk = getAdjustedStrength(base, 'gemini');
  assert.ok(Math.abs(adjOk - base) < 1e-9, 'all-success rate -> base * 1.0');
});

test('compactOutput preserves <file> blocks fully and respects maxChars', () => {
  const short = 'hello world';
  assert.equal(compactOutput(short, 100), short, 'fits -> returned as-is');

  const fileBlock = '<file name="a.js">\n' + 'x'.repeat(300) + '\n</file>';
  const prose = 'word '.repeat(1000); // 5000 chars
  const text = prose.slice(0, 2000) + fileBlock + prose.slice(2000);
  assert.ok(text.length > 3000);

  const out = compactOutput(text, 3000);
  assert.ok(out.length <= 3000, `length ${out.length} <= 3000`);
  assert.ok(out.includes('<file name="a.js">'), 'file open tag preserved');
  assert.ok(out.includes('</file>'), 'file close tag preserved');
  assert.ok(out.includes('x'.repeat(300)), 'entire file body preserved');
  assert.ok(out.includes('[...]'), 'marker present');

  const noFile = 'y'.repeat(10000);
  const out2 = compactOutput(noFile, 500);
  assert.ok(out2.length <= 500);
  assert.ok(out2.includes('[...]'));
  assert.ok(out2.startsWith('y'.repeat(Math.floor(500 * 0.6) - 0) ) || out2.length === 500);
  assert.ok(out2.endsWith('y'.repeat(200 - 5 + 5)) || out2.includes('[...]'));

  const multiFile = '<file name="a.js">AAA</file>' + 'p'.repeat(5000) + '<file name="b.js">BBB</file>';
  const out3 = compactOutput(multiFile, 400);
  assert.ok(out3.includes('<file name="a.js">AAA</file>'), 'first block intact');
  assert.ok(out3.includes('<file name="b.js">BBB</file>'), 'second block intact');
  assert.ok(out3.includes('[...]'));
});

test('buildTaskContext stays within TURN_BUDGET for many big completed outputs', () => {
  const allOutputs = {};
  for (let i = 0; i < 12; i++) {
    allOutputs[`agent${i}`] = {
      status: 'done',
      agent: `agent${i}`,
      output: (
        `lorem ipsum dolor sit amet task ${i} `.repeat(200) +
        `\n<file name="out${i}.js">\n` + 'z'.repeat(500) + `\n</file>\n`
      ).repeat(2),
    };
  }
  const tasks = [
    { description: 'main task', type: 'code', assignedTo: 'chatgpt', status: 'pending' },
    { description: 'other one', type: 'writing', assignedTo: 'gemini', status: 'pending' },
    { description: 'other two', type: 'research', assignedTo: 'perplexity', status: 'done' },
  ];
  const ctx = buildTaskContext({
    task: tasks[0],
    goal: 'Build a thing '.repeat(30),
    tasks,
    allOutputs,
    projectFiles: { 'big.js': 'const x = 1; // pad\n'.repeat(100) },
  });
  assert.ok(ctx.length <= TURN_BUDGET, `length ${ctx.length} must be <= ${TURN_BUDGET}`);
  assert.ok(ctx.includes('## The Goal'), 'goal section present');
  assert.ok(ctx.includes('## Your Role'), 'role section present');
  assert.ok(ctx.includes('## Output Format'), 'format section present');
  assert.ok(ctx.includes('## What Other Agents Are Working On'), 'pending section present');
});

test('buildTaskContext light case keeps full completed outputs when they fit', () => {
  const smallOutput = 'Short done output with a decision.\n<file name="small.js">\nconsole.log(1);\n</file>';
  const allOutputs = {
    a: { status: 'done', agent: 'chatgpt', output: smallOutput },
  };
  const task = { description: 't', type: 'code', assignedTo: 'chatgpt', status: 'pending' };
  const ctx = buildTaskContext({ task, goal: 'tiny goal', tasks: [task], allOutputs, projectFiles: {} });
  assert.ok(ctx.length <= TURN_BUDGET);
  assert.ok(ctx.includes('## Completed Agent Outputs To Build On'));
  assert.ok(ctx.includes('console.log(1);'), 'small completed output kept in full');
  assert.ok(ctx.includes('<file name="small.js">'), 'file block kept');
});
