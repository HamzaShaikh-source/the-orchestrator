# The Orchestrator

**Browser-Native AI Orchestration Engine** — Coordinate multiple free AI websites into a multi-agent pipeline. No API keys, no servers, no costs.

## What It Does

The Orchestrator is a planned Chrome extension that turns your browser into a distributed AI workstation. You type one high-level task — and it:

1. Sends your prompt to **DeepSeek** (the orchestrator), which breaks it down into sub-tasks
2. Assigns each sub-task to the best-suited AI (ChatGPT, Claude, Gemini, Perplexity, etc.)
3. Injects tailored prompts into each AI's web interface via browser automation
4. Reads and collects all responses
5. Optionally feeds results back to the orchestrator for a final synthesis

All using **free web accounts** — no API spending.

## Why This Approach

| Approach | Cost | Keys Needed | Server Required |
|---|---|---|---|
| Traditional APIs | Pay per token | Yes (one per service) | Yes (proxy for CORS) |
| **The Orchestrator** | **Free** | **None** | **No (all in browser)** |

## Architecture

```
Popup UI ──► Background Worker ──► DeepSeek (orchestrator)
                    │                      │
                    ▼                      ▼
              ChatGPT tab ◄── parses tasks & dispatches
              Claude tab ◄── sub-prompts to each
              Gemini tab ◄── reads responses
              ...tabs
                    │
                    ▼
              Collector ──► Consolidated results
```

## Current Status

**Pre-Alpha / Planning Phase.** This repository contains the full blueprint document (`index.html`) covering:

- System architecture & component design
- Step-by-step execution flow (25+ detailed steps)
- Chrome extension file manifest (80+ files)
- Prompt engineering for the orchestrator model
- Browser extension structure (Manifest V3)
- PC access strategy via Native Messaging
- Security model & privacy guarantees
- Implementation phases (0–6) with timeline
- Challenges & mitigations
- Future scope

## Repository Structure

```
the-orchestrator/
├── index.html          # Full blueprint & documentation
├── README.md           # This file
└── ...                 # (implementation files coming in future phases)
```

## Vision

Give every user the power of a multi-agent AI system — the kind that normally requires expensive API subscriptions — using nothing more than a browser and free accounts. Democratizing AI orchestration.
