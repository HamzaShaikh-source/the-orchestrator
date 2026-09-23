# Cookie Bridge contract (v2)

Extends harness/UI-CONTRACT.md. Goal: user installs a Chrome extension → cookies auto-captured → local server writes Web2API auth files → providers live instantly. No manual cookie extraction.

## Web2API auth file formats (targets — verified from vendor/web2api/web2api/auth/)

- `auth/cookies.local.json` (perplexity): FLAT `{ "cookieName": "value", ... }`
- `auth/chatgpt.local.json`: `{ "cookies": {name:value}, "headers": {...}, "account_id": "" }`
- `auth/gemini.local.json`: `{ "cookies": {name:value}, "headers": {}, "build_label": "" }`
- Auth dir resolution: env `WEB2API_AUTH_DIR` > `cwd/auth` > package auth. Server runs with cwd=vendor/web2api → `vendor/web2api/auth/`.
- Web2API caches clients at first use → needs reload after writing files.

## Server additions (harness/server.js)

```
POST /api/cookies  { provider: 'perplexity'|'chatgpt'|'gemini', cookies: {name:value}, headers?: {}, account_id?: '', token: '<uuid>' }
  - Token pairing: first successful call stores token in <stateDir>/server-token.json (atomic write).
    Later calls must send matching token in body.token, else 401 {error:'token-mismatch'}.
  - Validate: provider in set; cookies is object of string values (non-empty object required);
    body ≤ 1MB. 400 on invalid.
  - Write auth file (atomic tmp+rename, JSON pretty 2-space):
      perplexity -> cookies.local.json = cookies (flat)
      chatgpt    -> chatgpt.local.json = {cookies, headers: headers||{}, account_id: account_id||''}
      gemini     -> gemini.local.json = {cookies, headers: {}, build_label: ''}
  - After write: best-effort POST <WEB2API_BASE_URL>/api/reload (2s timeout, ignore failure).
  - Broadcast SSE {type:'cookies', provider, ok:true}.
  - Response {ok:true, provider, file:'cookies.local.json'|'chatgpt.local.json'|'gemini.local.json', reloaded:bool}

POST /api/cookies/reset  { token }  -> clears server-token.json if token matches (else 401). {ok:true}

GET /api/cookies/status  -> { providers: [ {id:'perplexity'|'chatgpt'|'gemini', configured: bool (auth file exists), file: name|null} ],
                              serverToken: bool (pairing active), web2api: {reachable: bool, providers: [ids]} }
  - web2api reachability: GET <WEB2API_BASE_URL>/api/providers, 2s timeout, best-effort.

GET /api/state  -> ADD: providers: [ids from Web2API /api/providers, best-effort, cached 10s], cookies: [{id, configured}]
```

## Web2API patch (vendor/web2api/web2api/server/app.py)

Add endpoint (near /api/providers):

```python
@app.post("/api/reload", dependencies=[Depends(require_api_key)])
def reload_clients() -> dict[str, str]:
    global _pplx_client, _chatgpt_client, _gemini_client
    with _pplx_lock:
        _pplx_client = None
    with _chatgpt_lock:
        _chatgpt_client = None
    with _gemini_lock:
        _gemini_client = None
    return {"status": "ok"}
```

## extension/ (Chrome MV3, new directory)

```
extension/
├── manifest.json        MV3
├── background.js        service worker
├── popup.html           status UI
├── popup.css
├── popup.js
└── content-chatgpt.js   grabs access token from localStorage (best effort)
```

manifest.json:
- name "The Orchestrator — Cookie Bridge", version 1.0.0, manifest_version 3
- permissions: ["cookies", "storage"]
- host_permissions: https://chatgpt.com/*, https://gemini.google.com/*, https://www.perplexity.ai/*, http://127.0.0.1:3000/*, http://localhost:3000/*
- background.service_worker: background.js
- action.default_popup: popup.html
- content_scripts: [{matches:["https://chatgpt.com/*"], js:["content-chatgpt.js"], run_at:"document_idle"}]
- No icons (Chrome shows default puzzle piece).

background.js:
- On install (chrome.runtime.onInstalled): generate token = crypto.randomUUID(), save chrome.storage.local {token, serverUrl:'http://127.0.0.1:3000'}, then captureAll().
- captureAll(): for each provider, chrome.cookies.getAll({domain}) → build payload → POST serverUrl/api/cookies {provider, cookies, headers?, account_id?, token}. Domain per provider: chatgpt.com, google.com (gemini), perplexity.ai.
  - perplexity: cookies = all cookies from perplexity.ai (flat name→value).
  - gemini: filter google.com cookies to known keys: SID, HSID, SSID, APISID, SAPISID, __Secure-1PSID, __Secure-3PSID, __Secure-1PSIDTS, __Secure-3PSIDTS, __Secure-1PAPISID, __Secure-3PAPISID, NID, COMPASS. Skip empty values.
  - chatgpt: all cookies from chatgpt.com; headers = {}; if chrome.storage.local has accessToken (from content script), headers.authorization = `Bearer ${token}`.
- chrome.runtime.onMessage: {type:'capture'} → captureAll() → sendResponse({ok, results}); {type:'status'} → sendResponse({serverUrl, token, serverReachable, providers:[{id, loggedIn (cookie count > 0), sent (last POST ok)}]}); {type:'set-server-url', url} → save + re-capture.
- Server reachability: GET serverUrl/api/state with 2s timeout (AbortController), catch → false.
- Log via console.log with [Bridge] prefix. Never log cookie values.
- fetch to http://127.0.0.1:3000 from service worker is allowed via host_permissions.

content-chatgpt.js:
- At document_idle, try localStorage keys in order: 'accessToken', 'oai-access-token', 'accessTokenExpiresAt' (skip). If a non-empty string found, chrome.runtime.sendMessage({type:'access-token', token: value}). Wrap in try/catch (localStorage may throw on some pages).

popup.html/css/js (dark, matches dashboard):
- Header: "The Orchestrator — Cookie Bridge", server status pill (Connected/Offline).
- Provider rows: ChatGPT / Gemini / Perplexity — status: "Logged in · Sent" (green), "Logged in · Not sent" (amber), "Not logged in" (gray). Click row → opens provider site in new tab (https://chatgpt.com/, https://gemini.google.com/, https://www.perplexity.ai/).
- Buttons: "Capture & send now" (re-capture), "Open dashboard" (chrome.tabs.create serverUrl/), server URL input (small, editable, saved via set-server-url).
- Note text: "Log into the provider sites in this browser, then capture. Cookies are sent only to your local server."
- Style: #1e1e1e bg, #2a2a2a panels, #ececec text, #d97757 accent, 13px, rounded 8px, status pills with dot. Width ~340px.
- popup.js: on open → sendMessage status → render; buttons wire to messages; refresh on 'capture' completion.

## Tests (test/server.test.js additions)

- POST /api/cookies first call (any token) → 200, file written (perplexity flat; chatgpt nested with headers/account_id; gemini nested), server-token.json created.
- Second call with different token → 401 token-mismatch; with matching token → 200.
- Invalid provider → 400. Empty cookies → 400.
- GET /api/cookies/status → configured:true after write, web2api.reachable:false (no server on test port — use WEB2API_BASE_URL pointing at a dead port, 2s timeout... use a port that refuses fast, e.g. 127.0.0.1:1).
- POST /api/cookies/reset with wrong token → 401; with right token → 200, file cleared.
- Use temp dirs for stateDir + authDir (pass authDir via env WEB2API_AUTH_DIR or createServer option authDir — prefer createServer option {authDir} defaulting to <root>/vendor/web2api/auth; tests pass temp dir).
- Existing 78 tests must still pass.

## Dashboard (small edit, done by main thread after agents)

- Sidebar: add "PROVIDERS" section above CONNECTORS: per provider (ChatGPT/Gemini/Perplexity) pill Configured/Not configured from /api/state cookies; click → opens extension/README.md instructions inline (or link). Keep minimal.

## package.json

- script "ext": "echo 'Load unpacked: chrome://extensions → Developer mode → Load unpacked → extension/'" (informational only).

## Logging
[Bridge] / [Cookies] prefixes. Never log cookie values or tokens.