# The Orchestrator

**Browser-Native AI Orchestration Engine** — Coordinate multiple free AI websites into a multi-agent pipeline. No API keys, no servers, no costs.

## ✨ v2.1 — Production Release

| Improvement | What changed |
|-------------|-------------|
| **🔒 Hidden tab execution** | All AI agents run in a minimized Chrome window — zero tab popping |
| **⚡ 1-second sync** | Progress updates every 1000ms exactly |
| **🧠 Smarter agent routing** | Tracks agent reliability; load-balances tasks; auto-fallback on failure |
| **🛡 Production error handling** | Auto-reconnect (30s timeout), tab crash recovery, output size limits (50KB) |
| **📁 Better file detection** | Extracts bare ```code blocks too, not just `<file>` tags |
| **🔄 Dependency ordering** | Tasks ordered: analysis → design → code → writing → technical |
| **🔋 Service worker keepalive** | Background worker stays alive every 20s (no unexpected shutdowns) |
| **🩺 Agent health monitor** | Live green/red dots on each agent chip, refreshes every 30s |
| **🎉 Confetti + notifications** | Visual celebration + sound + browser notification on completion |
| **⚙️ Settings panel** | Configure retries, poll speed, sound, notifications, animation speed |

## Quick Start

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** → click **Load unpacked** → select the folder
3. Open: `chrome-extension://<extension-id>/ui/multi-agent.html`
4. Select AI agents → type a goal → click **▶ Run Pipeline**

## How It Works

```
Goal → Login check → Brain plans tasks → Route to agents by capability
  → ALL tasks run in PARALLEL in hidden tabs (1s sync)
  → Brain synthesizes → Extract files → Download ZIP
```

## Architecture

```
src/
├── shared.js         # Hidden tabs, 1s poll, output limits, keepalive
├── orchestrator.js   # Pipeline: dependency ordering, cleanup, retry
├── agents.js         # Agent definitions, capability scores, chat history
├── prompts.js        # Prompt builders
├── task-planner.js   # LLM-powered task decomposition
├── task-router.js    # Reliability tracking, load balancing
└── background.js     # Service worker with keepalive

content/              # Content scripts (one per AI)
├── deepseek.js       # Brain agent (text-diff detection)
├── chatgpt.js
├── gemini.js
├── perplexity.js
└── huggingface.js

ui/
└── multi-agent.html/js  # Production dashboard
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Run pipeline |
| `Esc` | Stop pipeline |
| `Ctrl+N` | New chat |
| `?` | Toggle shortcuts |
| `G` | Open settings |

## License

MIT
