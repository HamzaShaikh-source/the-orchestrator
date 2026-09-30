/* proc.mjs — process + venv helpers shared by the launcher scripts.
 * Zero dependencies: Node built-ins only. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Repo root = two levels up from scripts/lib/ */
export const ROOT = path.resolve(HERE, '..', '..');
export const VENDOR = path.join(ROOT, 'vendor', 'web2api');
export const VENV = path.join(VENDOR, '.venv');
export const IS_WIN = process.platform === 'win32';

export function venvPython() {
  return IS_WIN
    ? path.join(VENV, 'Scripts', 'python.exe')
    : path.join(VENV, 'bin', 'python');
}

export function log(msg) {
  console.log(`[orchestrator] ${msg}`);
}

/* Run a command, tolerating Windows .exe/.cmd resolution and ENOENT. */
export function run(cmd, args, { cwd = ROOT, quiet = false } = {}) {
  const candidates = IS_WIN && !/\.[a-z0-9]+$/i.test(cmd) ? [cmd, `${cmd}.exe`, `${cmd}.cmd`] : [cmd];
  for (const c of candidates) {
    const r = spawnSync(c, args, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') continue;
    return r;
  }
  return { status: 1, error: Object.assign(new Error(`${cmd} not found`), { code: 'ENOENT' }) };
}

export function has(cmd) {
  const r = run(cmd, ['--version'], { quiet: true });
  return !r.error && r.status === 0;
}

/* Create + populate the vendored Web2API virtualenv if it is missing.
 * Prefers `uv` (fast, matches the repo's own docs); falls back to venv + pip.
 * Returns the interpreter path. */
export function ensureVenv() {
  const python = venvPython();
  if (fs.existsSync(python)) return python;

  log('first run: creating vendor/web2api/.venv ...');

  if (has('uv')) {
    log('using uv');
    let r = run('uv', ['venv', '.venv', '--python', '3.11'], { cwd: VENDOR });
    if (r.status !== 0) r = run('uv', ['venv', '.venv'], { cwd: VENDOR });
    if (r.status !== 0) throw new Error('uv venv failed');
    const i = run('uv', ['pip', 'install', '-e', '.', '--python', python], { cwd: VENDOR });
    if (i.status !== 0) throw new Error('uv pip install failed');
    return python;
  }

  const sys = IS_WIN ? 'python' : 'python3';
  log(`uv not found — falling back to ${sys} -m venv (this is slower)`);
  let r = run(sys, ['-m', 'venv', '.venv'], { cwd: VENDOR });
  if (r.status !== 0) throw new Error(`could not create virtualenv with ${sys}`);
  r = run(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: VENDOR, quiet: true });
  r = run(python, ['-m', 'pip', 'install', '-e', '.'], { cwd: VENDOR });
  if (r.status !== 0) throw new Error('pip install -e . failed');
  return python;
}

/* Poll an HTTP endpoint until it answers, or time out. */
export async function waitForHttp(url, { timeoutMs = 60000, intervalMs = 400, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}