# The Orchestrator

**Browser-Native AI Orchestration Engine** — Coordinate multiple free AI websites into a multi-agent pipeline. No API keys, no servers, no costs.

A Chrome extension that orchestrates **multiple AI agents** (DeepSeek, ChatGPT, Gemini, Perplexity, HuggingFace) to collaborate on tasks. Agents are controlled via browser automation — no API keys required.

> ⚠️ **Proof of concept / developer preview.** The core pipeline works, but content scripts are fragile (they depend on DOM structure of each AI's web UI). Expect to maintain selectors.

---

## Quick Start

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** → click **Load unpacked** → select this folder
3. Pin the extension, then open `chrome-extension://<extension-id>/multi-agent.html`
4. Type a goal like *"Create a landing page with CSS animations"* → click **▶ Run**

**Required:** Free accounts for the AI services you want to use (DeepSeek, ChatGPT, etc.). The login check step will verify each one before the pipeline starts.

---

## How It Works

```
User goal → AI selects best agents → Login check → Planner breaks into subtasks
  → Router assigns tasks to agents → Each agent executed via browser tab
  → Feedback loop cross-reviews outputs → Synthesis produces final result
```

**Key insight:** Each AI service runs in a real browser tab. Content scripts read/write the chat input/output fields automatically. No API keys, no backend.

---

## Features

- **Multi-agent orchestration** — Select 2–4 agents. The LLM-powered selector picks the best combination for your goal.
- **Pre-flight login check** — Before running, verifies every selected agent is logged in. Shows overlay with retry/cancel if not.
- **Intelligent routing** — Subtasks assigned to the best-suited agent (code → DeepSeek, writing → ChatGPT, research → Perplexity, etc.).
- **Balanced workload** — Every selected agent gets at least one task.
- **Cross-model feedback** — Agents critique and improve each other's outputs.
- **File-tagged output** — Code tasks produce `<file name="...">` tags. View and download as ZIP.
- **Chat history** — All runs saved with agent selections, conversation URLs, and results. Re-run historical chats.
- **Dark theme UI** — Built-in dashboard with progress tracking.

---

## Full Architecture Blueprint

See [`index.html`](./index.html) for the complete architectural vision, including pipeline design, agent selection strategies, fallback mechanisms, and future roadmap.

---

## Project Structure

```
├── index.html               # Full architecture blueprint & documentation
├── manifest.json            # Chrome extension manifest
├── background.js            # Service worker — tab management, messaging
├── shared.js                # Agent definitions, tab utilities, chat storage, login check
├── orchestrator.js          # Pipeline orchestration (select → login → plan → route → run → feedback → synthesize)
├── task-planner.js          # LLM-powered task decomposition
├── task-router.js           # Assigns tasks to best-fit agents
├── content-chatgpt.js       # Content script for ChatGPT
├── content-deepseek.js      # Content script for DeepSeek
├── content-gemini.js        # Content script for Gemini
├── content-perplexity.js    # Content script for Perplexity
├── content-huggingface.js   # Content script for HuggingFace
├── multi-agent.html/js      # Orchestration dashboard UI
├── dashboard.html/js        # Alternative dashboard
├── popup.html/js            # Quick popup UI
├── server.js                # HTTP server for zip download
├── agents.js                # Agent capability definitions
└── README.md
```

---

## Supported Agents

| Agent | Icon | Best at | Status |
|-------|------|---------|--------|
| **DeepSeek** | 🧠 | Code, reasoning, technical | ✅ Works |
| **ChatGPT** | 💬 | Writing, instructions, UI/UX | ✅ Works |
| **Gemini** | ✨ | Analysis, structured thinking | ⚠️ Submit button unreliable |
| **Perplexity** | 🔍 | Web research, citations | ✅ Works |
| **HuggingFace** | 🤗 | NLP, translation | ✅ Works |

---

## Known Limitations

- **Content scripts break on site updates** — Selectors are tied to each AI service's current DOM. When sites update, content scripts need updating.
- **Extension reload = refresh tabs** — Content scripts aren't re-injected on reload. Tabs opened before a reload need manual refreshing.
- **Slow** — Full pipeline takes 2–5 minutes per run.
- **Gemini submit is unreliable** — ChatGPT is the default selector/planner agent.
- **One-shot only** — No iterative refinement within tasks.

---

## Development

### Adding a new agent

1. Create `content-<agent>.js` with selectors for input, submit button, and response area
2. Add `checkLogin` action handler (see existing content scripts)
3. Add the agent to `agents.js` with capability scores (0–9)
4. Add `AGENT_LOGIN_URLS` entry in `shared.js`
5. Add the agent to UI templates in `multi-agent.js`

### Login check test

```javascript
// In DevTools on any agent's page:
await chrome.runtime.sendMessage({ action: 'checkLogin' });
// → { loggedIn: true } or { loggedIn: false }
```

---

## License

MIT
