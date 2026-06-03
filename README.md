# The Orchestrator

**Browser-Native AI Orchestration Engine** — Coordinate multiple free AI websites into a multi-agent pipeline. No API keys, no servers, no costs.

A Chrome extension that orchestrates **multiple AI agents** (DeepSeek, ChatGPT, Gemini, Perplexity, HuggingFace) to collaborate on tasks. Agents are controlled via browser automation — no API keys required.

> ⚠️ **Proof of concept / developer preview.** The core pipeline works, but content scripts are fragile (they depend on DOM structure of each AI's web UI). Expect to maintain selectors.

---

## Quick Start

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** → click **Load unpacked** → select the `the-orchestrator` folder
3. Click the extension icon in the toolbar, or open the dashboard:
   ```
   chrome-extension://<extension-id>/ui/multi-agent.html
   ```
   (Find your extension ID on `chrome://extensions` under "The Orchestrator")
4. Select which AI agents to use by clicking their icons
5. Type a goal like *"Create a landing page with CSS animations"* → click **▶ Run Pipeline**

**Required:** Free accounts for the AI services you want to use (DeepSeek, ChatGPT, etc.).

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
├── manifest.json            # Chrome extension manifest
├── multi-agent.html         # Redirects → ui/multi-agent.html
├── dashboard.html           # Redirects → ui/dashboard.html
│
├── src/                     # Core source code
│   ├── background.js        # Service worker — tab management, messaging
│   ├── shared.js            # Utilities, login check, tab management
│   ├── orchestrator.js      # Brain-centered pipeline orchestration
│   ├── agents.js            # Agent definitions, capability scores, chat history
│   ├── task-planner.js      # LLM-powered task decomposition
│   ├── task-router.js       # Assigns tasks to best-fit agents
│   └── server.js            # HTTP server for zip download
│
├── content/                 # Content scripts (one per AI service)
│   ├── deepseek.js
│   ├── chatgpt.js
│   ├── gemini.js
│   ├── perplexity.js
│   └── huggingface.js
│
├── ui/                      # Frontend pages
│   ├── multi-agent.html     # Main orchestration dashboard
│   ├── multi-agent.js
│   ├── dashboard.html/js    # Alternative dashboard
│   ├── popup.html/js        # Extension popup
│
├── icons/                   # Extension icons
├── docs/                    # Architecture documentation
├── README.md
└── LICENSE
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
