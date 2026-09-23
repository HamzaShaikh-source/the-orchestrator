#!/usr/bin/env node
/* index.js — CLI entry point per harness/INTERFACES.md */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Web2ApiClient, Web2ApiError } from './web2api-client.js';
import { Store } from './store.js';
import { runPipeline } from './orchestrator.js';
import { AGENTS } from './agents.js';

const USAGE = `Usage: orchestrator [options]
  --goal "<text>"       user goal (required unless stdin is piped)
  --agents a,b,c        restrict agents (chatgpt,gemini,perplexity)
  --out <dir>           run dir; default runs/
  --confirm             require interactive confirmation before running
  --base-url <url>      Web2API base URL; default http://127.0.0.1:8080
  --api-key <key>       Web2API API key (if required by server)
  --max-agents <n>      max agents to select; default 4
  --retries <n>         retries per task; default 2
  --file <path>         project file (repeatable; read into context)
  --list-agents         print agent registry table and exit
  --health              print providers JSON from Web2API and exit
  -h, --help            show this help
Env: WEB2API_BASE_URL and WEB2API_API_KEY override the flags.
Exit codes: 0 ok, 1 pipeline error, 2 bad usage, 3 Web2API unavailable.`;

const trim = (s, n) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, n) + '…' : text;
};

function printAgentTable() {
  console.log('ID         NAME        PROVIDER    ACTIVE');
  console.log('----       ----        --------    ------');
  for (const a of AGENTS) {
    console.log(
      `${String(a.id).padEnd(10)} ${String(a.name).padEnd(11)} ${String(a.provider || a.id || '-').padEnd(11)} ${a.active === false ? 'no' : 'yes'}`,
    );
  }
}

function logEvent(e) {
  switch (e.type) {
    case 'step':
      console.log(`[step] ${e.step}${e.step === 'retry' ? ` #${e.attempt} task=${e.taskId}` : ''}`);
      break;
    case 'agents':
      console.log(`[agents] ${e.agents.join(', ')} (${e.reasoning})`);
      break;
    case 'task-start':
      console.log(`[task] start  ${e.agentId}: ${trim(e.description, 70)}`);
      break;
    case 'task-delta': {
      if (!e.text) break;
      console.log(`[delta] ${trim(e.text, 80)}`);
      break;
    }
    case 'task-done':
      console.log(`[task] done   ${e.agentId}: ${trim(e.task, 70)}`);
      break;
    case 'task-error':
      console.log(`[task] error  ${e.agentId}: ${trim(e.error, 70)}`);
      break;
    case 'agent-failover':
      console.log(`[failover] ${e.from} -> ${e.to} (task ${e.taskId})`);
      break;
    case 'synthesis':
      console.log(`[synthesis] ${e.phase || 'running'}`);
      break;
    default:
      break;
  }
}

function printManifest(r) {
  console.log('\n=== Manifest ===');
  console.log('Tasks:');
  r.tasks.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.status}] ${t.assignedTo || 'unassigned'}  ${trim(t.description, 60)}`);
  });
  console.log('Files:');
  if (r.files && r.files.length) {
    for (const f of r.files) {
      console.log(`  ${f.name} (${f.bytes} B) [${f.status}]`);
    }
  } else {
    console.log('  (none)');
  }
  if (r.conflicts && r.conflicts.length) {
    console.log('Conflicts:');
    for (const c of r.conflicts) {
      console.log(`  ${c.name} — differing content from: ${c.from.join(', ')}`);
    }
  }
  console.log(`Zip: ${r.zipPath}`);
  const errors = r.tasks.filter((t) => t.status === 'error');
  if (errors.length || r.error) {
    console.log('Errors:');
    if (r.error) console.log(`  ${r.error}`);
    for (const t of errors) console.log(`  [${t.assignedTo}] ${trim(t.description, 50)}`);
  }
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let values;
  let positionals = [];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        goal: { type: 'string' },
        agents: { type: 'string' },
        out: { type: 'string', default: 'runs' },
        confirm: { type: 'boolean', default: false },
        'base-url': { type: 'string' },
        'api-key': { type: 'string' },
        'max-agents': { type: 'string', default: '4' },
        retries: { type: 'string', default: '2' },
        file: { type: 'string', multiple: true },
        'list-agents': { type: 'boolean', default: false },
        health: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    console.error(`[CLI] ${err.message}\n${USAGE}`);
    process.exit(2);
  }

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (values['list-agents']) {
    printAgentTable();
    process.exit(0);
  }

  const baseUrl = process.env.WEB2API_BASE_URL || values['base-url'] || 'http://127.0.0.1:8080';
  const apiKey = process.env.WEB2API_API_KEY || values['api-key'] || '';
  const client = new Web2ApiClient({ baseUrl, apiKey });

  if (values.health) {
    try {
      const providers = await client.providers();
      console.log(JSON.stringify(providers, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`[CLI] Web2API unavailable at ${baseUrl}: ${err.message || err}`);
      process.exit(3);
    }
  }

  let goal = values.goal || positionals.join(' ').trim();
  if (!goal && !process.stdin.isTTY) {
    goal = (await readStdin()).trim();
  }
  if (!goal) {
    console.error(`[CLI] No goal provided.\n${USAGE}`);
    process.exit(2);
  }

  const maxAgents = Number(values['max-agents']);
  const retries = Number(values.retries);
  if (!Number.isFinite(maxAgents) || maxAgents < 1 || !Number.isFinite(retries) || retries < 0) {
    console.error('[CLI] --max-agents must be >= 1 and --retries >= 0.');
    process.exit(2);
  }

  /* Pre-flight: server reachable + at least one provider */
  try {
    const providers = await client.providers();
    const any = providers.some((p) => p.available !== false);
    if (!any) {
      console.error('[CLI] Web2API is up but no providers are available.');
      process.exit(3);
    }
    console.log(`[CLI] Web2API ${baseUrl} — ${providers.filter((p) => p.available !== false).length} provider(s) available`);
  } catch (err) {
    console.error(`[CLI] Web2API unavailable at ${baseUrl}: ${err.message || err}`);
    process.exit(3);
  }

  const projectFiles = {};
  for (const fp of values.file || []) {
    try {
      const content = await readFile(fp, 'utf8');
      projectFiles[path.basename(fp)] = content;
    } catch (err) {
      console.error(`[CLI] Cannot read --file ${fp}: ${err.message}`);
      process.exit(2);
    }
  }

  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const store = new Store(path.join(outDir, '.state'));

  const selectedAgents = values.agents ? values.agents.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const runSettings = {
    retries,
    maxAgents,
    signal: null,
  };
  let autoConfirm = !values.confirm;
  if (values.confirm && !process.stdin.isTTY) {
    console.error('[CLI] --confirm needs an interactive terminal; proceeding without confirmation.');
    autoConfirm = true;
  } else if (values.confirm) {
    runSettings.confirm = async (tasks) => {
      console.log(`[confirm] ${tasks.length} task(s) planned:`);
      tasks.forEach((t, i) => console.log(`  ${i + 1}. [${t.type}] ${t.assignedTo}: ${trim(t.description, 60)}`));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Proceed? [y/N] ');
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    };
  }

  const result = await runPipeline({
    goal,
    selectedAgents,
    projectFiles,
    outDir,
    autoConfirm,
    runSettings,
    onEvent: logEvent,
    client,
    store,
  });

  printManifest(result);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  if (err instanceof Web2ApiError && ['network', 'timeout', 'unconfigured'].includes(err.code)) {
    console.error(`[CLI] Web2API unavailable: ${err.message}`);
    process.exit(3);
  }
  console.error(`[CLI] Pipeline error: ${err.message || err}`);
  process.exit(1);
});