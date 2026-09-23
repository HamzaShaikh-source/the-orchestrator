# The Orchestrator

**Multi-Agent AI Orchestration Engine** — coordinate ChatGPT, Gemini, and Perplexity into a parallel multi-agent pipeline over a REST API. No browser tabs, no content scripts, no extension required.

## v3.0 — Web2API Harness

| Change | What happened |
|--------|---------------|
| **🔌 REST transport** | Tab-driving replaced with [Web2API](https://github.com/AbdullahArean/Web2API) (vendored in `vendor/web2api`) — cookie-based REST + SSE for ChatGPT, Gemini, Perplexity |
| **🧵 True parallelism** | Tasks run in parallel across agents (sequential within an agent to respect rate limits) |
| **📚 Long-context handling** | 7500-char turn budget per request; long prompts split into chained conversation turns; completed outputs compacted (all `<file>` blocks preserved) before being fed to later agents |
| **📁 File creator harness** | Extracts `<file name="...">` blocks (plus bare fenced-code fallback), sanitizes paths (traversal-proof), writes to `runs/<run>/files/`, detects cross-agent conflicts, zips the run |
| **🛡 Production resilience** | Retry with exponential backoff + jitter, non-retryable error fast-fail, agent failover on attempt 3, reliability tracking, per-agent session memory |
| **🧠 Orchestration** | Brain (ChatGPT) plans tasks → capability routing with load balancing → dependency ordering → synthesis → file collection |

## Quick Start

```bash
# 1. Start the Web2API server (needs provider cookies — see below)
cd vendor/web2api
python -m venv .venv
.venv\Scripts\pip install -e .
.venv\Scripts\python -m uvicorn web2api.server.app:app --host 127.0.0.1 --port 8080

# 2. Configure at least one provider's session cookies
#    vendor/web2api/docs/COOKIES.md — copy auth/*.local.json.example and fill in
#    (or set PERPLEXITY_COOKIES / CHATGPT_AUTH / GEMINI_AUTH env vars)

# 3. Run the harness
node harness/index.js --goal "Build a landing page with a contact form"
```

## Cookie Bridge (no manual cookie extraction)

Install the Chrome extension once — it auto-captures ChatGPT/Gemini/Perplexity session cookies and feeds them to the local server. No cookie copying, no auth files to edit.

```bash
npm run ext          # prints load-unpacked instructions
# chrome://extensions → Developer mode → Load unpacked → extension/
```

- On install the extension generates a pairing token, captures cookies for all providers you're logged into, and POSTs them to `http://127.0.0.1:3000/api/cookies`.
- The server writes Web2API auth files (`vendor/web2api/auth/*.local.json`) and hot-reloads the Web2API backend — providers go live instantly.
- Popup shows per-provider status (Logged in · Sent / Not sent / Not logged in) + server connectivity.
- ChatGPT access token is grabbed from localStorage when available (best effort); Gemini/Perplexity are cookie-only.
- Tokens/cookies travel only to your local server. Never committed, never logged.

## Dashboard UI (Claude-style)

Live web dashboard — dark theme, activity feed, per-task status pills (Thinking… / Reading… / Writing… / Searching… / Synthesizing… / Done / Error), streaming output, file manifest + ZIP download, connector panel.

```bash
npm run serve          # http://127.0.0.1:3000
```

- `POST /api/run` starts a pipeline; progress streams over SSE (`/api/events`).
- Files tab: download run ZIP, push to GitHub, upload to Drive.

## Connectors

| Connector | Status check | Actions | Env |
|---|---|---|---|
| GitHub | `GET /user` with token | create-repo, push-files, list-repos | `GITHUB_TOKEN` |
| Google Drive | OAuth refresh exchange | upload-files | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Webhook | always | send JSON to any URL | — |

Connector status shows in the dashboard sidebar (Connected / Needs setup / Error). Tokens come from env vars only — never committed, never logged.

## CLI

```
node harness/index.js --goal "<text>" [options]
  --agents chatgpt,gemini        restrict agents
  --out runs/                    run directory (files/ + zip)
  --confirm                      require confirmation before executing
  --base-url http://127.0.0.1:8080
  --api-key KEY                  if the server requires one
  --max-agents 4  --retries 2
  --file path                    include a project file (repeatable)
  --list-agents                  show agent registry
  --health                       check Web2API connectivity
```

Exit codes: `0` ok · `1` pipeline error · `2` bad usage · `3` Web2API unavailable.

## Architecture

```
harness/
├── index.js            # CLI entry
├── server.js           # Dashboard server: static UI + SSE event stream + run/connector APIs
├── connectors.js       # GitHub / Google Drive / Webhook connectors (env-token auth)
├── orchestrator.js     # Pipeline: providers → selection → plan → route → parallel exec → synthesis → files
├── web2api-client.js   # SSE client, retry/backoff, long-message turn splitting, session chaining
├── agents.js           # Agent registry (chatgpt/gemini/perplexity), capability scoring
├── context.js          # Long-context budgeting: compactOutput, buildTaskContext (7500-char budget)
├── prompts.js          # Task/synthesis prompt builders
├── task-planner.js     # LLM task decomposition (brain) with cache + fallback
├── task-router.js      # Reliability tracking, load balancing, failover scoring
├── file-harness.js     # <file> extraction, safe writes, conflict detection, pure-Node ZIP
└── store.js            # Atomic JSON KV store (replaces chrome.storage)

vendor/web2api/         # Web2API backend (FastAPI, SSE, cookie-based)
src/, content/, ui/     # Legacy v2 browser-extension code (unused by the harness)
```

## How It Works

```
Goal → Web2API health check → Brain selects agents → Brain plans tasks
  → route by capability (load-balanced) → ALL agents run in PARALLEL
  → Brain synthesizes → file creator extracts <file> blocks → writes + zips run
```

## Tests

```bash
node --test        # 48 tests: client SSE/splitting/retry, planner, router, file harness, full pipeline
```

## Notes

- DeepSeek and HuggingFace agents were removed — Web2API has no API path for them.
- Cookies are unofficial/session-based: they expire and may be IP-bound. Never commit `*.local.json`.
- The legacy Chrome extension (`src/`, `content/`, `ui/`, `manifest.json`) is kept for reference; the harness is the supported path.

## License

MIT