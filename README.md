# The Orchestrator

**Browser-Native AI Orchestration Engine** — Coordinate multiple free AI websites into a multi-agent pipeline. No API keys, no servers, no costs.

A Chrome extension that orchestrates **multiple AI agents** (DeepSeek, ChatGPT, Gemini, Perplexity, HuggingFace) to collaborate on tasks. Agents are controlled via browser automation — no API keys required.

> ⚠️ **Proof of concept / developer preview.** The core pipeline works, but content scripts depend on each AI's web UI DOM structure. Expect to maintain selectors.

## ✨ New in v2.1

| Feature | What it does |
|---------|-------------|
| **Pipeline Flow Viz** | Animated flow diagram shows Brain → Execute → Review → Synthesize in real-time |
| **Agent Health Monitor** | Live indicator on each agent chip (green/red/gray for online/offline/unknown) |
| **Settings Panel** | ⚙️ gear icon — configure retries, poll speed, sound, notifications, animations |
| **🎉 Confetti Celebration** | Fireworks animation when pipeline completes |
| **⌨️ Shortcuts Modal** | Press `?` to see all keyboard shortcuts |
| **Task Animation** | Staggered tile appearance, smoother transitions |
| **Improved File Panel** | Grid/list toggle, one-click delete, inline edit, dedicated preview |
| **Enhanced Export** | Synthesis section has inline MD + HTML export buttons |
| **Better Mobile Layout** | Flow arrows rotate vertical on small screens, full-width settings |

## Quick Start

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** → click **Load unpacked** → select the `the-orchestrator` folder
3. Click the extension icon, or open:
   ```
   chrome-extension://<extension-id>/ui/multi-agent.html
   ```
4. Select AI agents by clicking their icons
5. Type a goal → click **▶ Run Pipeline**

**Required:** Free accounts for the AI services you want to use.

## How It Works

```
User goal → Login check → Planner breaks into subtasks
  → Router assigns tasks → All tasks execute in PARALLEL
  → Brain reviews → Synthesis produces final files
```

**Key insight:** Each AI runs in a real browser tab. Content scripts read/write chat fields automatically. No API keys, no backend.

## Features

- **Multi-agent orchestration** — Select 2–5 agents. Tasks routed by capability scores.
- **Pre-flight login check** — Verifies every agent is logged in before starting.
- **Parallel execution** — Every task gets its own browser tab, runs simultaneously.
- **File-tagged output** — Code produces `<file name="...">` tags. Download as ZIP.
- **Chat history** — All runs saved. Restore, re-run, compare.
- **Self-healing** — Content scripts use text-diff detection, not fragile CSS selectors.
- **Pipeline flow visualization** — Watch each stage animate in real-time.
- **Settings panel** — Configure retries, poll speed, notifications, animations.
- **Keyboard shortcuts** — `Ctrl+Enter` run, `Esc` stop, `?` shortcuts, `Ctrl+N` new chat.
- **Dark / Light theme** — Persisted to localStorage.
- **File management** — Grid/list view, copy, edit, delete, HTML preview, ZIP download.

## Project Structure

```
├── manifest.json            # Chrome extension manifest (MV3)
├── src/
│   ├── background.js        # Service worker
│   ├── shared.js            # Utilities, login check, tab management
│   ├── orchestrator.js      # Brain-centered pipeline orchestration
│   ├── agents.js            # Agent definitions, capability scores, chat history
│   ├── prompts.js           # Prompt builders
│   ├── task-planner.js      # Task decomposition
│   └── task-router.js       # Task-to-agent routing
├── content/                 # Content scripts (one per AI)
│   ├── deepseek.js
│   ├── chatgpt.js
│   ├── gemini.js
│   ├── perplexity.js
│   └── huggingface.js
├── ui/
│   ├── multi-agent.html     # Main dashboard (revamped v2.1)
│   ├── multi-agent.js       # Dashboard logic
│   ├── dashboard.html/js    # Alternative dashboard
│   └── popup.html/js        # Extension popup
├── icons/                   # Extension icons
└── README.md
```

## Supported Agents

| Agent | Icon | Best at | Status |
|-------|------|---------|--------|
| **DeepSeek** | 🧠 | Code, reasoning, technical | ✅ Works |
| **ChatGPT** | 💬 | Writing, instructions, UI/UX | ✅ Works |
| **Gemini** | ✨ | Analysis, structured thinking | ⚠️ Submit unreliable |
| **Perplexity** | 🔍 | Web research, citations | ✅ Works |
| **HuggingFace** | 🤗 | NLP, translation | ✅ Works |

## Known Limitations

- **Content scripts break on site updates** — Selectors need maintaining
- **Slow** — Full pipeline takes 2–5 minutes
- **Gemini submit is unreliable** — ChatGPT is default selector
- **One-shot only** — No iterative refinement within tasks

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Run pipeline |
| `Esc` | Stop pipeline |
| `Ctrl+N` | New chat |
| `?` | Toggle shortcuts |
| `G` | Open settings |

## License

MIT — built by [Hamza Shaikh](https://github.com/HamzaShaikh-source)
