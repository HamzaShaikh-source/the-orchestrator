# Harness interface contract (v1)

All modules are ESM (`"type": "module"`). Every builder MUST match these exact signatures.
No module imports another except through this contract. No chrome.* anywhere.

## store.js

```js
export class Store {
  constructor(dir)            // creates dir recursively; db file = dir/db.json
  async get(key, fallback)    // returns stored value or fallback
  async set(key, value)       // atomic write (tmp file + rename)
  async delete(key)
  async update(key, fn)       // fn(oldValue) -> newValue, then persist
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
```

## web2api-client.js

```js
export class Web2ApiError extends Error {
  constructor(message, { code, retryable, status } = {})
  // code: 'rate_limit' | 'unauthorized' | 'unconfigured' | 'timeout' | 'network' | 'provider' | 'bad_request'
  // retryable: boolean
}

export class Web2ApiClient {
  constructor({ baseUrl = 'http://127.0.0.1:8080', apiKey = '', timeoutMs = 600000 } = {})
  async health()                       // GET /healthz -> {status:'ok'}; throws Web2ApiError network
  async providers()                    // GET /api/providers -> [{id,label,available}]
  async chat({ provider, message, modelId='auto', webSearch=true, session=null, onDelta, signal })
  // -> { content: string, session: object|null, provider }
  // SSE parse: event delta -> onDelta(content) if provided; event done -> resolve; event error -> throw Web2ApiError provider retryable.
  // LONG CONTEXT: if message.length > 7500, split into ordered turns at paragraph boundaries
  //   under 7500 chars each; send turn 1 with session=null-chained local var, feed returned
  //   session into next turn; concatenate contents; return combined content + final session.
  //   Every HTTP call retried per retry policy below on retryable errors only.
}
export const RETRY_POLICY = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 30000 };
// backoff: base * 2^(attempt-1) + jitter, capped; respect retryable=false.
```

## agents.js

```js
// Agent registry — Web2API-backed only (deepseek/huggingface REMOVED).
// transport: 'web2api'. provider matches Web2API: chatgpt|gemini|perplexity.
// brainId export = 'chatgpt'.
export const AGENTS = [ /* ... */ ];
export const brainId = 'chatgpt';
export function getAgent(id)
export function allActiveAgents()
export function scoreAgent(agentId, taskType)
export function bestAgent(taskType)
export function analyzePrompt(prompt)   // port as-is
export function selectAgents(prompt)    // port as-is (keyword fallback); only returns ids present in AGENTS
// chat history helpers (file-backed, using Store instance passed in):
export async function listChats(store)
export async function getChat(store, id)
export async function saveChat(store, chat)
export async function deleteChat(store, id)
export async function createChat(store, prompt, title)
```

Default modelId per agent: chatgpt -> 'auto', gemini -> 'auto', perplexity -> 'auto'.
Strength tables: reuse original numeric strengths for shared task types; perplexity keeps research/citations, drops nothing.

## context.js — long-context budgeting

```js
// Hard char budget per request is 7500 (Web2API limit is 8000; margin for JSON).
export const TURN_BUDGET = 7500;
export function compactOutput(text, maxChars)
// If text fits, return as-is. Else preserve ALL <file ...>...</file> blocks in full,
// then fill remaining budget with head (60%) + tail (40%) of prose, marker '[...]'.
export function buildTaskContext({ task, goal, tasks, allOutputs, projectFiles, budget = TURN_BUDGET })
// Port of prompts.buildTaskPrompt with char budgeting: sections added in priority order
// (goal, role/task, project files, completed outputs, pending tasks, format rules),
// each section's completed-output slices shrink via compactOutput until total <= budget.
// Returns string. If impossible, drop completed-output section to summaries of 200 chars.
```

## prompts.js

```js
export function buildTaskPrompt(task, allTasks, allOutputs, goal, projectFiles = {})
// MUST delegate section packing to context.buildTaskContext (single source of budget truth).
export function buildSynthesisPrompt(goal, completedOutputs)
// self-contained deliverable rules + <file> wrapping instruction.
export async function reviewOutput(task, agent, output) // heuristic only, same as brainReviewOutput port
```

## file-harness.js — the file creator

```js
export function extractFiles(text)
// Primary: /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi
// Fallback: bare fenced ```lang\n...``` blocks when no <file> tags present;
//   name inferred: ext guess from lang (js/py/css/html/md/json), else snippet-<n>.txt
// Returns [{ name, content }]. Dedupe by name (later wins).

export function sanitizeRelPath(name)
// Strip leading slashes, reject/repair '..' segments, replace illegal Windows chars
//  [<>:"|?*] with '_', collapse '\\', max 200 chars, throw on empty after clean.
//  NEVER escapes outDir.

export async function writeFiles(files, outDir)
// mkdir -p outDir; for each: resolve path, assert resolved startsWith resolved outDir + sep;
//  write utf-8. Returns [{ name, path, bytes, status:'written'|'skipped-identical' }]
// Identical existing content -> skipped-identical (no mtime churn).

export async function collectRunArtifacts({ runDir, text, extraTexts = [] })
// extract from one or many texts, write to runDir/files/, return manifest
//  { files: [...writeFiles result], conflicts: [{name, from:[labels]}] }
// conflicts = same name extracted from >1 agent output with differing content.

export async function zipDir(dir, zipPath)
// Pure-Node zip (store method, no deps) OR tiny built-in ZIP writer — no external npm deps allowed.
// Returns zipPath.
```

## task-planner.js

```js
export function computeGoalComplexity(goal)          // port as-is
export async function planTasks({ goal, maxAgents, ask /* fn(prompt, {json:true}) -> string */, store, onEvent })
// ask() is injected by orchestrator (wraps Web2ApiClient.chat with brain agent).
// Prompt + parsePlannerTasks + normalizePlannerTasks + cache (store key 'cachedTaskPlans') ported as-is.
// Fallback plan identical to original.
```

## task-router.js

```js
export async function initReliability(store)   // port, store key 'agentReliability'
export async function recordAgentResult(store, agentId, success)
export function getAdjustedStrength(baseScore, agentId)
export function routeAll(tasks, allowedAgents) // port as-is
```

## orchestrator.js

```js
export async function runPipeline({
  goal,
  selectedAgents = null,      // null -> AI selection via brain (selectAgents fallback)
  projectFiles = {},          // name -> content
  outDir,                     // absolute run dir; files land in outDir/files, zip at outDir/<slug>.zip
  autoConfirm = true,         // skip interactive confirm (CLI has --confirm flag)
  runSettings = { retries: 2, maxAgents: 4 },
  onEvent = () => {},         // onEvent({type, ...payload}) for UI/log streaming
  client,                     // Web2ApiClient instance (injected)
  store,                      // Store instance (injected)
})
// -> { ok, tasks, agentOutputs, synthesis, files, zipPath, error? }
//
// Pipeline (port of original flow, tabs removed):
// 0. client.providers() -> filter active agents to available providers; if none -> throw.
// 1. agent selection (brain ask or keyword fallback)
// 2. planTasks via injected ask()
// 3. orderTasksByDependency + routeAll (port)
// 4. autoConfirm or wait confirm via onEvent
// 5. PARALLEL across agents, sequential within agent (Promise.all over agent queues).
//    Each task: buildTaskPrompt -> client.chat (session per agent kept in-memory map
//    for long-context chaining) -> retry w/ backoff (RETRY_POLICY, max from runSettings.retries+1)
//    -> failover to better agent on attempt 3 (findBetterAgent port) -> recordAgentResult.
//    onEvent progress: task-start, task-delta, task-done, task-error, agent-failover.
// 6. synthesis: brain chat with buildSynthesisPrompt over compacted completed outputs.
// 7. file harness: collectRunArtifacts over all outputs + synthesis -> write -> zip.
// 8. save chat record via store; cleanup; return result.
// Cancel: AbortSignal via runSettings.signal -> throw CancelError (exported).
export class CancelError extends Error {}
```

## index.js — CLI

```js
#!/usr/bin/env node
// args: --goal "<text>" (required unless stdin piped)
//       --agents chatgpt,gemini   --out runs/   --confirm (require prompt)
//       --base-url http://127.0.0.1:8080  --api-key KEY  --max-agents 4 --retries 2
//       --file path (repeatable, read into projectFiles)  --list-agents  --health
// Flow: parse args -> health/providers check (clear error if server down or no providers)
//  -> runPipeline with onEvent logger (step, task status, deltas trimmed to 80 cols)
//  -> print manifest: tasks, files written, zip path, errors.
// Exit codes: 0 ok, 1 pipeline error, 2 bad usage, 3 Web2API unavailable.
```

## Logging convention
`[Module] message` via console — orchestrator, Planner, Router, Client, Files.
Never log cookie/auth material or full prompts >200 chars.
