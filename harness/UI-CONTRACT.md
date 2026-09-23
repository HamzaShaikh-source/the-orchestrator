# UI + Connectors contract (v1)

Extends harness/INTERFACES.md. ESM. No external npm deps (Node 24 built-ins only: http, fs, path, crypto, child_process allowed).

## Event stream (already emitted by orchestrator — UI consumes these)

```
{type:'step', step:'providers'|'agent-selection'|'planning'|'ordering'|'confirm-tasks'|'running'|'synthesis'|'files'|'saving'|'done'|'retry', ...}
{type:'agents', agents:[ids], reasoning}
{type:'plan-start', goal}
{type:'plan-done', count}
{type:'task-start', taskId, agentId, description, taskType}
{type:'task-delta', taskId, agentId, text}          // throttled ≥200 chars
{type:'task-done', taskId, agentId, task}
{type:'task-error', taskId, agentId, error, attempt}
{type:'agent-failover', taskId, from, to}
{type:'confirm', tasks}
```

## connectors.js

```js
export const CONNECTORS = [
  { id: 'github',      name: 'GitHub',       icon: '🐙', actions: ['create-repo', 'push-files', 'list-repos'] },
  { id: 'google-drive', name: 'Google Drive', icon: '📁', actions: ['upload-files'] },
  { id: 'webhook',     name: 'Webhook',      icon: '🔗', actions: ['send'] },
];

export async function connectorStatus(id, { store } = {})
// -> { id, name, icon, status: 'connected'|'needs-setup'|'error', detail: string, actions }
// github:   connected if env GITHUB_TOKEN set (validate: GET https://api.github.com/user with Bearer, 200)
//           needs-setup if token missing. error if token invalid (401/403).
// google-drive: connected if GOOGLE_CLIENT_ID+GOOGLE_CLIENT_SECRET+GOOGLE_REFRESH_TOKEN set AND
//           refresh exchange to access token succeeds (POST https://oauth2.googleapis.com/token,
//           grant_type=refresh_token). needs-setup if any missing. error if exchange fails.
// webhook:  connected always (detail: 'POST JSON to any URL').

export async function runConnectorAction(id, action, args, { store, outDir } = {})
// github create-repo {name, private?}      -> POST /user/repos {name, private, auto_init:false}; ok {repo:{full_name, html_url}}
// github push-files {repo, files?}         -> files default = last run's files dir (outDir/<latest>/files).
//   For each file: PUT /repos/{repo}/contents/{path} {message:'Orchestrator run', content: base64, branch?}
//   If file exists, GET existing sha first and include it (update). ok {pushed:[{path, status:'created'|'updated'}], repo}
// github list-repos {per_page?}            -> GET /user/repos?per_page=20&sort=updated; ok {repos:[{full_name, html_url, private}]}
// google-drive upload-files {folderId?}    -> files from last run's files dir. For each: refresh token,
//   POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart (multipart: metadata JSON
//   {name, parents:[folderId]?} + file bytes). ok {uploaded:[{name, id, webViewLink}], folderId}
// webhook send {url, payload?}             -> POST JSON (payload defaults to last run manifest summary). ok {status, ok}
// All throw ConnectorError {message, code:'auth'|'api'|'not-found'|'invalid'} on failure.
// Never log tokens. Never write tokens to disk.
export class ConnectorError extends Error {}

export async function listConnectorStatuses({ store } = {}) // Promise.all over CONNECTORS
export function lastRunDir(outDir) // newest subdir of outDir by mtime; null if none
```

## server.js

```js
export function createServer({ client, store, outDir, port = 3000, host = '127.0.0.1' })
// -> { server, broadcast, state }  (http.Server)
// Routes:
//   GET /                       -> ui/dashboard.html
//   GET /ui/*                   -> static from <root>/ui/ (html/css/js only)
//   GET /api/state              -> { running, lastRun: {goal, ok, files, zipPath, conflicts, error} | null,
//                                   agents: [{id,name,icon,color,active}], providers: [ids] }
//   GET /api/events             -> SSE (text/event-stream). On connect send {type:'hello', state}.
//                                  broadcast() writes `data: <json>\n\n` to all open clients.
//   POST /api/run {goal, agents?, files?} -> starts runPipeline in background (rejects 409 if running).
//                                  files: [{name, content}] -> projectFiles. Returns {ok:true, runId}.
//                                  Pipeline onEvent wired to broadcast(). runSettings.signal = AbortController.
//   POST /api/cancel            -> abort current run. Returns {ok:true}.
//   GET  /api/connectors        -> listConnectorStatuses
//   POST /api/connectors/:id/refresh -> re-check one status
//   POST /api/connectors/:id/action {action, ...args} -> runConnectorAction; broadcast {type:'connector', id, action, ok, result|error}
//   GET  /api/zip?run=<dirname> -> serve <outDir>/<dirname>/*.zip (first zip found). Path traversal-proof:
//                                  dirname must match /^[a-z0-9-]+$/ else 400.
//   GET  /api/runs              -> [{dir, goal, ts, files:[names], zip}] from outDir subdirs (read manifest.json if present)
// runPipeline result is written to <outDir>/<runDir>/manifest.json (server does this after completion:
//   {goal, ok, tasks, files, conflicts, zipPath, error, ts}).
// Also export async function main() — CLI entry: reads env ORCH_PORT (default 3000), ORCH_OUT_DIR (default ./runs),
//   WEB2API_BASE_URL, WEB2API_API_KEY; creates Store(outDir/../state or ./harness/state), Web2ApiClient, starts server,
//   prints URLs. `node harness/server.js` runs main().
```

## ui/dashboard.html + ui/dashboard.css + ui/dashboard.js

Claude-style dark dashboard. Single page, no frameworks, no external CDNs (offline-capable). Fetch API + EventSource.

Layout:
- Top bar: app name "The Orchestrator", live status pill (Idle / Running / Done / Error), connectors toggle, cancel button (visible while running).
- Left sidebar (260px): AGENTS section — one row per agent (icon, name, status dot: idle/green when done/red on error, current task label). CONNECTORS section — rows with icon, name, status pill (Connected / Needs setup / Error), click row → connector panel.
- Main column:
  - Goal composer: textarea + Run button + agent multi-select chips (default all).
  - Task board: cards per task (type badge, agent chip, description, status pill). Status pill phases (Claude-style):
    - task-start → "Thinking…" (animated dots)
    - first task-delta → "Writing…" (or "Searching…" for perplexity agent)
    - synthesis step → "Synthesizing…"
    - task-done → "Done" (green), task-error → "Error" (red, tooltip with message)
  - Activity feed (timeline, right of task board or below): entries like "ChatGPT is thinking…", "Gemini wrote 1.2 KB", "Perplexity searching…", "Brain synthesizing…", "Files written: 3", "Pushed to GitHub". Auto-scroll, newest at bottom, subtle fade-in.
  - Output panel: select a task → streaming monospace text (task-delta appends). Tabs: Output / Files.
  - Files tab: table (name, bytes, status) + Download ZIP button (GET /api/zip?run=...) + connector quick actions (Push to GitHub, Upload to Drive) that POST to connector action endpoints.
- Connector panel (modal or slide-over): per connector — status, detail, action buttons with small forms (repo name, private toggle; folderId optional; webhook URL + payload). Results/toasts shown inline.
- Style: dark (#1e1e1e bg, #2a2a2a panels, #ececec text, accent #d97757 Claude-orange or #e8a87c), system font stack, 13px base, rounded 8px cards, subtle borders (#3a3a3a), status pills with 2px animated dot (CSS keyframes pulse), monospace (ui-monospace) for output/files. No emoji except connector icons. Responsive: sidebar collapses under 900px.
- JS: EventSource('/api/events') → reducer updating state; render() functions per section; keep last 200 activity entries; task-delta throttled append (batch via requestAnimationFrame); errors surfaced as toasts. On load: GET /api/state + /api/connectors.
- Accessibility: buttons have aria-labels, status pills have aria-live="polite" on the top-bar pill.

## package.json additions

```json
"scripts": { "serve": "node harness/server.js" }
```

## Tests

- test/server.test.js: createServer with stub client + temp dirs + ephemeral port. Assert: GET / serves html; GET /api/state shape; POST /api/run with stub client → SSE receives task-start/task-done (connect EventSource-equivalent via fetch ReadableStream before POST); manifest.json written after run; GET /api/zip serves PK bytes; traversal dirname rejected; POST /api/cancel while running → ok; connectors endpoints return array.
- test/connectors.test.js: monkey-patch global.fetch. github status connected/needs-setup/error; create-repo; push-files (create + update with sha); list-repos; drive upload (token refresh + multipart upload); webhook send; lastRunDir picks newest.
- Run: node --test (all existing + new must pass).

## Logging
[Server] / [Connector:github] / [Connector:google-drive] / [Connector:webhook] prefixes. Never log tokens/headers.