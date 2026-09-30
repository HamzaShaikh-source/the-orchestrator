#!/usr/bin/env node
/* services.mjs — start everything the web dashboard needs, in one command.
 *
 *   node scripts/services.mjs        # or: npm run dev
 *
 * Boots, in order:
 *   1. Web2API backend      :8080  (auto-creates its venv on first run)
 *   2. Orchestrator server  :3000  (dashboard + SSE + connectors + cookie bridge)
 * then waits for both to answer and prints the URLs and the provider status.
 *
 * The Chrome "self-contained" path (extension/) needs NONE of this — load
 * extension/ unpacked and everything runs in the service worker.
 *
 * Teardown: Ctrl-C stops both children.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, VENDOR, ensureVenv, log, waitForHttp } from './lib/proc.mjs';

const W2A_PORT = process.env.WEB2API_PORT || '8080';
const W2A_HOST = process.env.WEB2API_HOST || '127.0.0.1';
const ORCH_PORT = process.env.ORCH_PORT || '3000';

const children = [];

function launch(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
  child.on('error', (err) => log(`${name} failed to launch: ${err.message}`));
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(code);
}

async function main() {
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  let python;
  try {
    python = ensureVenv();
  } catch (err) {
    log(`could not prepare the Python environment: ${err.message}`);
    log('The dashboard still starts, but providers stay offline until Web2API can run.');
    python = null;
  }

  if (python) {
    log(`starting Web2API on http://${W2A_HOST}:${W2A_PORT}`);
    launch('web2api', python,
      ['-m', 'uvicorn', 'web2api.server.app:app', '--host', W2A_HOST, '--port', W2A_PORT],
      VENDOR);
  }

  log(`starting Orchestrator dashboard on http://127.0.0.1:${ORCH_PORT}`);
  launch('server', process.execPath, [path.join(ROOT, 'harness', 'server.js')], ROOT);

  if (python) {
    try {
      await waitForHttp(`http://${W2A_HOST}:${W2A_PORT}/healthz`, { timeoutMs: 45000, label: 'Web2API' });
      log('Web2API is up');
      const res = await fetch(`http://${W2A_HOST}:${W2A_PORT}/api/providers`);
      const { providers } = await res.json();
      if (!providers.length) {
        log('no providers configured yet — log into ChatGPT / Gemini / Perplexity in your browser,');
        log('then load extension/ unpacked (chrome://extensions) to push cookies to the server.');
      } else {
        log(`providers available: ${providers.map((p) => p.id).join(', ')}`);
      }
    } catch (err) {
      log(`warning: ${err.message}`);
    }
  }

  log('--------------------------------------------------------------');
  log(`dashboard : http://127.0.0.1:${ORCH_PORT}/`);
  log(`web2api   : http://${W2A_HOST}:${W2A_PORT}${python ? '' : '  (not started)'}`);
  log('Ctrl-C to stop.');
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  shutdown(1);
});