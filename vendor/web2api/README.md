# Web2API

Unified Python library and REST API for **Perplexity**, **ChatGPT**, and **Gemini** using browser session cookies.

**Author:** [Abdullah Ibne Hanif Arean](https://abdullaharean.com)  
**Affiliation:** Junior AI Researcher, [The KOW Company](https://thekowcompany.com) · B.Sc. CSE, University of Dhaka

Web2API wraps unofficial web clients into a standalone open-source package for cookie-based access to major AI chat providers.

## Features

- Cookie-based clients for Perplexity, ChatGPT, and Gemini
- Unified auth loading from local JSON files or environment variables
- FastAPI REST server with SSE streaming and OpenAPI docs at `/docs`
- Per-provider conversation memory via round-trip `session` on `/api/chat`
- Perplexity file upload via base64 attachments in chat requests
- Web search toggles for Perplexity, ChatGPT, and Gemini
- Expanded Gemini model list with request-scoped model selection
- CLI connectivity checks for each provider

## Requirements

- Python 3.9 or newer
- Valid browser session cookies for the providers you want to use

## Install

```bash
git clone https://github.com/AbdullahArean/web2api.git
cd web2api
python3 -m venv .venv
source .venv/bin/activate
pip install .
```

For development:

```bash
pip install -e ".[dev,test]"
```

## Auth setup

See **[docs/COOKIES.md](docs/COOKIES.md)** for step-by-step cookie extraction instructions, including DevTools screenshots for ChatGPT and Gemini.

Quick start:

```bash
cp auth/cookies.local.json.example auth/cookies.local.json
cp auth/chatgpt.local.json.example auth/chatgpt.local.json
cp auth/gemini.local.json.example auth/gemini.local.json
```

Fill in your browser session data, then verify connectivity:

```bash
web2api-test-perplexity
web2api-test-chatgpt
web2api-test-gemini
```

You can also copy [`.env.example`](.env.example) to `.env` and configure environment variables instead of local JSON files.

## Python usage

```python
from web2api import perplexity, chatgpt, gemini
from web2api.auth import load_perplexity_cookies, load_chatgpt_auth, load_gemini_auth

# Perplexity
pplx = perplexity.Client(load_perplexity_cookies())
print(pplx.search("What is Web2API?", mode="auto")["answer"])

# ChatGPT
gpt = chatgpt.Client(load_chatgpt_auth())
print(gpt.chat("Hello!", stream=False))

# Gemini
gem = gemini.Client(load_gemini_auth())
print(gem.chat("Hello!", stream=False))
```

Factory helper:

```python
from web2api.auth import get_client

client = get_client("gemini")
print(client.chat("Hello!", stream=False))
```

Example script:

```bash
python examples/unified_chat.py
```

## REST API

Start the server:

```bash
web2api-serve --host 0.0.0.0 --port 8080
```

Interactive API documentation is available at `http://127.0.0.1:8080/docs`.

**Production:** always set an API key before exposing the server to a network:

```bash
export WEB2API_API_KEY=your-secret-key
```

When `WEB2API_API_KEY` is unset, `/api/*` routes are unauthenticated and intended for local development only.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness check |
| GET | `/api/providers` | List configured providers |
| GET | `/api/health?provider=` | Provider health/status |
| GET | `/api/models?provider=` | Available models |
| POST | `/api/chat` | SSE streaming chat |

### Example requests

```bash
curl http://127.0.0.1:8080/api/providers

curl "http://127.0.0.1:8080/api/health?provider=gemini"

curl -N -X POST http://127.0.0.1:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"gemini","message":"Say hi","model_id":"gemini-2.5-flash"}'
```

### Conversation memory (`session`)

Each provider keeps its own backend thread. Send the `session` object from the previous `done` event on follow-up messages. Omit `session` (or send `null`) to start a new thread.

| Provider | Session shape |
|----------|---------------|
| Perplexity | Full backend follow-up payload (`backend_uuid`, `attachments`, …) |
| ChatGPT | `{ "conversation_id": "...", "parent_message_id": "..." }` |
| Gemini | `{ "conversation_id": "...", "response_id": "...", "choice_id": "..." }` |

Verification example:

```bash
# Message 1 — save session from the done event
curl -N -X POST http://127.0.0.1:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"chatgpt","message":"My name is Alex"}'

# Message 2 — pass session back
curl -N -X POST http://127.0.0.1:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"chatgpt","message":"What is my name?","session":{"conversation_id":"...","parent_message_id":"..."}}'
```

Perplexity still accepts the legacy `follow_up` field as an alias for `session`.

### File upload (Perplexity)

Attach up to 10 files (10 MB each) as base64-encoded objects:

```bash
curl -N -X POST http://127.0.0.1:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "perplexity",
    "message": "Summarize this file",
    "files": [{"filename": "notes.txt", "content_base64": "aGVsbG8="}]
  }'
```

### Web search

Set `"web_search": true` (default for Perplexity) to enable provider-native search:

- **Perplexity** — uses web sources; optionally pass `"sources": ["web", "scholar", "social"]`
- **ChatGPT** — enables search via `system_hints`
- **Gemini** — enables Google Search grounding in the request payload

With API key:

```bash
curl -H "Authorization: Bearer your-secret-key" http://127.0.0.1:8080/api/providers
```

SSE response format:

```
event: delta
data: {"content": "Hello!"}

event: done
data: {"content": "Hello!", "session": {...}}
```

Perplexity `done` events also include `follow_up` (deprecated alias of `session`) for backward compatibility.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `WEB2API_AUTH_DIR` | Override auth file directory (default: `./auth`) |
| `PERPLEXITY_COOKIES` | JSON string of Perplexity cookies |
| `CHATGPT_AUTH` | JSON string of ChatGPT auth object |
| `GEMINI_AUTH` | JSON string of Gemini auth object |
| `WEB2API_API_KEY` | Require Bearer token on `/api/*` routes |

See [`.env.example`](.env.example) for a template.

## Testing

Unit tests (no live credentials required):

```bash
pip install -e ".[test]"
pytest
```

Integration checks (require configured auth):

```bash
web2api-test-perplexity
web2api-test-chatgpt
web2api-test-gemini
```

## Project layout

```
web2api/
├── auth/                  # Local auth files (gitignored)
├── docs/COOKIES.md        # Cookie extraction guide
├── examples/              # Usage examples
├── tests/                 # Unit tests
└── web2api/
    ├── perplexity/
    ├── chatgpt/
    ├── gemini/
    ├── auth/              # Loaders and path helpers
    └── server/            # FastAPI REST API
```

## Security and disclaimer

- These are **unofficial** APIs that reverse-engineer provider web sessions.
- You are responsible for complying with each provider's terms of service.
- Session cookies expire and may be IP-bound.
- Never commit `*.local.json` auth files or share cookies publicly.
- Rotate credentials immediately if exposed.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE).

## Author

**Abdullah Ibne Hanif Arean** — [abdullaharean.com](https://abdullaharean.com)

AI researcher specializing in natural language processing and 3D computer vision.
