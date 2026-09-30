# The Orchestrator

**Multi-Agent AI Orchestration Engine** — point ChatGPT, Gemini and Perplexity at one goal and get a coordinated pipeline: plan → route → parallel execution → synthesis → real files on disk.

No API keys. No paid SDKs. It uses the browser sessions you already have.

---

## Two ways to run it

| | **Chrome extension** (self-contained) | **Node harness** (CLI + web dashboard) |
|---|---|---|
| Install | Load `extension/` unpacked | `npm run dev` |
| Needs Python server | ❌ | ✅ (vendored, auto-installed) |
| Needs npm packages | ❌ zero deps | ❌ zero deps |
| Runs in | Chrome service worker | Node + local Web2API backend |
| Best for | just using it | automating it / scripting it |

The extension is the **self-contained** path: the whole pipeline (planning, parallel agents, synthesis, file generation, ZIP) executes inside the Chrome service worker using your existing browser cookies. Nothing to install, nothing to start.

---

## Option A — Self-contained Chrome extension

```bash
npm run ext        # prints the exact path to load
```

1. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/`
2. Click the extension icon → **Open dashboard**
3. Make sure you're logged into `chatgpt.com`, `gemini.google.com` and/or `perplexity.ai` in that browser
4. Type a goal → **Run**

Cookies never leave your machine. Works in any Chromium browser (Chrome, Brave, Edge, Vivaldi).

## Option B — Node harness

```bash
npm run dev        # starts Web2API (:8080) + dashboard (:3000)
```

`npm run dev` creates `vendor/web2api/.venv` and installs its Python dependencies on first run, then boots both servers and prints the provider status. Open <http://127.0.0.1:3000/>.

Then either drive the dashboard, or use the CLI:

```bash
node harness/index.js --goal "Build a landing page with a contact form"
```

To activate providers without touching cookie files by hand, load `extension/` unpacked — when the local server is running it also pushes captured cookies to it (`POST /api/cookies`) and hot-reloads Web2API, so providers go live instantly. Manual setup is documented in [`vendor/web2api/docs/COOKIES.md`](vendor/web2api/docs/COOKIES.md).

### Requirements

- **Node.js ≥ 20** (the harness and extension are zero-dependency — no `npm install` needed)
- **Python ≥ 3.11** and either **`uv`** (preferred) or `python -m venv` — only for Option B
- A logged-in browser session for at least one provider

### npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Web2API + dashboard together |
| `npm run web2api` | Web2API backend only |
| `npm run serve` | dashboard server only |
| `npm start` | CLI (`--goal "..."`) |
| `npm run ext` | load-unpacked instructions for the extension |
| `npm run setup` | create the Python venv + run the test suite |
| `npm test` | `node --test` |

---

## How it works

```
Goal → provider check → brain selects agents → brain plans typed subtasks
  → capability routing (load-balanced) → ALL agents run in PARALLEL
  → brain synthesizes → <file> blocks extracted → traversal-safe writes → ZIP
```

Both front-ends share the same pipeline design:

- **Brain planning** — ChatGPT decomposes the goal into typed subtasks.
- **True parallelism** — tasks run in parallel across agents (sequential *within* an agent to respect rate limits).
- **Long-context handling** — 7500-char turn budget; long prompts split into chained conversation turns; completed outputs compacted before reuse.
- **File creator harness** — extracts `<file name="...">` blocks (plus bare fenced-code fallback), sanitizes paths (traversal-proof), detects cross-agent conflicts, zips the run.
- **Resilience** — retry with exponential backoff + jitter, non-retryable fast-fail, agent failover, reliability tracking, per-agent session memory.

## Architecture

```
extension/                 # self-contained path — runs in the browser, no server
├── manifest.json          # MV3, service worker
├── background.js          # dashboard hub, run lifecycle, ZIP download
├── core/
│   ├── providers.js       # ChatGPT / Gemini / Perplexity clients (SSE, cookies)
│   ├── proofofwork.js     # ChatGPT sentinel proof-of-work solver
│   ├── sha3.js            # SHA3-512 (for the PoW)
│   ├── orchestrator.js    # the pipeline
│   ├── task-planner.js    # LLM task decomposition
│   ├── task-router.js     # reliability + load balancing + failover
│   ├── context.js         # long-context budgeting
│   ├── file-harness.js    # <file> extraction, safe paths, conflicts
│   ├── zip.js             # pure-JS ZIP writer
│   └── store.js           # chrome.storage abstraction
├── dashboard.html/.css/.js
└── popup.html/.css/.js

harness/                   # Node path
├── index.js               # CLI
├── server.js              # dashboard server: static UI + SSE + run/connector/cookie APIs
├── orchestrator.js        # the pipeline (same design)
├── web2api-client.js      # SSE client, retry/backoff, turn splitting, session chaining
├── connectors.js          # GitHub / Google Drive / Webhook
├── agents.js  context.js  prompts.js  task-planner.js  task-router.js
├── file-harness.js        # extraction, safe writes, conflicts, pure-Node ZIP
└── store.js               # atomic JSON KV store

scripts/                   # cross-platform launchers (Node, zero-dep)
ui/dashboard.*             # Claude-style dashboard for the Node server
vendor/web2api/            # vendored Web2API backend (FastAPI, cookie-based SSE)
src/, content/, ui/legacy  # legacy v2 browser-extension code (unused)
```

## Connectors (Node harness)

| Connector | Actions | Auth |
|---|---|---|
| GitHub | `create-repo`, `push-files`, `list-repos` | `GITHUB_TOKEN` |
| Google Drive | `upload-files` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Webhook | `send` | — |

Tokens come from environment variables only — never committed, never logged.

## CLI reference

```
node harness/index.js --goal "<text>" [options]
  --agents chatgpt,gemini   restrict agents
  --out runs/               run directory (files/ + zip)
  --confirm                 require confirmation before executing
  --base-url http://127.0.0.1:8080
  --api-key KEY             if the server requires one
  --max-agents 4  --retries 2
  --file path               include a project file (repeatable)
  --list-agents             show the agent registry
  --health                  check Web2API connectivity
```

Exit codes: `0` ok · `1` pipeline error · `2` bad usage · `3` Web2API unavailable.

## Tests

```bash
npm test        # node --test
```

108 tests covering: SSE parsing, long-message turn splitting, retry/backoff semantics, planner, router, file harness (extraction, traversal-safety, conflict detection, ZIP integrity), store, server routes, cookie ingestion, connectors, the extension core (SHA3 KATs, proof-of-work, Gemini frame parsing), a full pipeline smoke test, and a **true end-to-end test** that drives the real HTTP client against a stub server speaking the Web2API SSE contract (`test/e2e-live-pipeline.test.js`).

## Notes & caveats

- **Provider auth is your browser session.** Cookies are unofficial and session-based: they expire and are sometimes IP-bound. Re-capture when a provider stops responding. Never commit `*.local.json`.
- **ChatGPT** additionally needs its Bearer token for full API access; the extension picks it up from `localStorage` when available (best effort). **Gemini** and **Perplexity** are cookie-only.
- Verified working end-to-end against a stub that speaks the exact Web2API SSE protocol. Talking to the *real* ChatGPT/Gemini/Perplexity endpoints requires a logged-in browser session, which cannot be synthesised — see the notes above.
- DeepSeek and HuggingFace agents were removed — Web2API has no API path for them.
- The legacy v2 extension (`src/`, `content/`, `ui/legacy`, root `manifest.json`) is kept for reference only.

## License

MIT