# The Orchestrator — Chrome extension

The **self-contained** path. The entire multi-agent pipeline runs inside the MV3
service worker: no Python, no local server, no npm packages, no API keys.

## Install

```bash
npm run ext     # prints the folder path
```

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Click the toolbar icon → **Open dashboard**

Works in any Chromium browser — Chrome, Brave, Edge, Vivaldi.

## Use

1. Log into `chatgpt.com`, `gemini.google.com` and/or `perplexity.ai` in that browser
2. Open the dashboard, type a goal, hit **Run**
3. Watch the task board and activity feed; grab the generated files as a ZIP

The dashboard shows per-provider login status, live task phases
(Thinking → Writing/Searching → Done/Error), streaming output, and the file manifest.

## How it works

`core/providers.js` talks to each provider's web endpoint directly using
`fetch(..., { credentials: 'include' })` — your existing session cookies, granted
by `host_permissions`. No cookie copying and no auth files.

| Provider | Transport |
|---|---|
| ChatGPT | `backend-api/conversation` SSE + sentinel proof-of-work (`core/proofofwork.js`, `core/sha3.js`) |
| Gemini | `StreamGenerate` (`batchexecute` framing, parsed in `core/providers.js`) |
| Perplexity | `rest/sse/perplexity_ask` SSE |

`core/orchestrator.js` is the pipeline: provider check → brain selects agents →
brain plans typed subtasks → capability routing → **parallel** execution across
agents → synthesis → `<file>` extraction → in-memory ZIP (`core/zip.js`).

## Optional: the local server

If you also run the Node harness (`npm run dev`), this extension keeps working
exactly as above — it does not need the server. Note that this extension does
**not** push cookies to that server: the Node path has its own `POST /api/cookies`
bridge which is not currently wired to this extension, so the `:3000` dashboard
needs its own credentials (see `vendor/web2api/docs/COOKIES.md`).

## Permissions

| Permission | Why |
|---|---|
| `cookies` | read provider login status in the popup |
| `storage` | keep run history and reliability stats |
| `downloads` | save the generated ZIP |
| `tabs` | open the dashboard tab |
| `host_permissions` | talk to the provider endpoints with your session |

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Access denied" | Not logged into that provider in this browser |
| Provider shows as unavailable | The login probe failed — reload the provider tab and re-run |
| Gemini "Could not extract SNlM0e" | Google session expired — log in again |
| ChatGPT sentinel error | Sentinel token stale — reload `chatgpt.com` and retry |

## Tests

The core modules are chrome-free and covered by `test/extension-core.test.js`:

```bash
npm test
```