# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-31

### Added

- Unified `session` field on `POST /api/chat` for conversation memory across Perplexity, ChatGPT, and Gemini.
- ChatGPT thread extraction: `conversation_id` and `parent_message_id` returned in `done` SSE events.
- Request-scoped Gemini session state (fixes shared-client thread bleed).
- Expanded Gemini model list with model selection via web API headers.
- Web search support for ChatGPT (`system_hints`) and Gemini (search grounding payload).
- Perplexity file upload via base64 `files` attachments on chat requests.
- Optional Perplexity `sources` list (`web`, `scholar`, `social`) on chat requests.

### Changed

- All providers now return `session` in `done` SSE events.
- Perplexity `follow_up` remains supported as a deprecated alias for `session`.

## [1.0.0] - 2026-05-28

### Added

- Unified Python clients for Perplexity, ChatGPT, and Gemini using browser session cookies.
- Auth loaders for local JSON files and environment variables.
- FastAPI REST server with SSE streaming (`web2api-serve`).
- Connectivity check CLIs: `web2api-test-perplexity`, `web2api-test-chatgpt`, `web2api-test-gemini`.
- Cookie extraction guide in `docs/COOKIES.md`.
- Example script at `examples/unified_chat.py`.

### Security

- Optional API key protection for REST endpoints via `WEB2API_API_KEY`.

[1.1.0]: https://github.com/AbdullahArean/web2api/releases/tag/v1.1.0
[1.0.0]: https://github.com/AbdullahArean/web2api/releases/tag/v1.0.0
