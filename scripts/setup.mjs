#!/usr/bin/env node
/* setup.mjs — prepare everything the Node harness needs, in one command.
 *
 *   node scripts/setup.mjs        # or: npm run setup
 *
 * Creates vendor/web2api/.venv (+ installs deps) and runs the test suite.
 * Node itself needs no packages: the harness and the extension are zero-dep.
 */
import path from 'node:path';
import { ROOT, ensureVenv, log, run, venvPython } from './lib/proc.mjs';

async function main() {
  log(`repo: ${ROOT}`);

  const python = ensureVenv();
  log(`python environment ready: ${python}`);

  const version = run(python, ['-c', 'import sys; print(sys.version.split()[0])'], { quiet: true });
  if (version.stdout) log(`python ${version.stdout.trim()}`);

  log('running the test suite ...');
  const tests = run(process.execPath, ['--test'], { cwd: ROOT });
  if (tests.status !== 0) {
    log('tests FAILED — see output above');
    process.exit(1);
  }
  log('all tests passed');
  log('');
  log('next steps');
  log('  npm run dev    start Web2API + the dashboard, then open http://127.0.0.1:3000/');
  log('  npm run ext    the self-contained extension (no server needed at all)');
}

main().catch((err) => {
  log(`setup failed: ${err.message}`);
  process.exit(1);
});