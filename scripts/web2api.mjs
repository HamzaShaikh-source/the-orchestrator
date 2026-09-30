#!/usr/bin/env node
/* web2api.mjs — self-contained launcher for the vendored Web2API backend.
 *
 * One command, any platform, any working directory:
 *   node scripts/web2api.mjs            # or: npm run web2api
 *
 * It (1) creates vendor/web2api/.venv and installs deps if missing, then
 * (2) launches uvicorn with cwd=vendor/web2api — which is the directory
 * Web2API resolves its auth files from (vendor/web2api/auth/*.local.json).
 *
 * Ports: WEB2API_PORT (default 8080), WEB2API_HOST (default 127.0.0.1).
 */
import { spawn } from 'node:child_process';
import { VENDOR, ensureVenv, log } from './lib/proc.mjs';

const port = process.env.WEB2API_PORT || '8080';
const host = process.env.WEB2API_HOST || '127.0.0.1';

function main() {
  let python;
  try {
    python = ensureVenv();
  } catch (err) {
    log(`could not prepare the Python environment: ${err.message}`);
    log('Install Python 3.11+ (or uv) and re-run.');
    process.exit(1);
  }

  log(`starting Web2API on http://${host}:${port}`);
  log(`auth dir: ${VENDOR}/auth  (drop *.local.json here, or use the Chrome bridge)`);

  const child = spawn(
    python,
    ['-m', 'uvicorn', 'web2api.server.app:app', '--host', host, '--port', port],
    { cwd: VENDOR, stdio: 'inherit' },
  );

  child.on('error', (err) => {
    log(`failed to launch uvicorn: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try { child.kill(sig); } catch { /* already gone */ }
    });
  }
}

main();