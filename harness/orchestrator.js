/* orchestrator.js — Web2API pipeline per harness/INTERFACES.md (v1) */
import path from 'node:path';
import { RETRY_POLICY, Web2ApiError } from './web2api-client.js';
import { brainId, getAgent, allActiveAgents, selectAgents, createChat, saveChat } from './agents.js';
import { compactOutput } from './context.js';
import { buildTaskPrompt, buildSynthesisPrompt, reviewOutput } from './prompts.js';
import { planTasks } from './task-planner.js';
import { initReliability, recordAgentResult, getAdjustedStrength, routeAll } from './task-router.js';
import { collectRunArtifacts, zipDir } from './file-harness.js';
import { sleep } from './store.js';

export class CancelError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelError';
  }
}

const AGENT_SELECT_PROMPT = `You are an agent selection system. Given a user goal, select the best combination of AI agents:

- chatgpt: Creative writing, instructions, UI/UX
- gemini: Analysis, structured thinking, multimodal
- perplexity: Web research, fact-checking, citations

Return ONLY valid JSON with no markdown:
{"selected":["agent1","agent2",...,"agentN"],"reasoning":"one sentence"}

Select 2-3 agents. Use ONLY the ids: chatgpt, gemini, perplexity. User goal:`;

const DEFAULT_RUN_SETTINGS = { retries: 2, maxAgents: 4 };
const MAX_SYNTHESIS_CHARS = 6000;

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';
}

/* Provider id for an agent: explicit provider field, else agent id (matches Web2API ids) */
function agentProviderOf(a) {
  return a?.provider || a?.id;
}

/* ── Error mapping ── */
export function friendlyError(err, agentName = 'agent') {
  const code = err instanceof Web2ApiError ? err.code : null;
  if (code === 'rate_limit') return { message: 'Rate limited by AI provider. Waiting before retry…', type: 'warning', retryable: true };
  if (code === 'unauthorized') return { message: 'Access denied — check WEB2API_API_KEY or log in to the Web2API server.', type: 'error', retryable: false };
  if (code === 'timeout') return { message: `${agentName} took too long. Try a simpler task.`, type: 'warning', retryable: true };
  if (code === 'network') return { message: 'Network error — check that the Web2API server is running.', type: 'error', retryable: true };
  if (code === 'unconfigured') return { message: 'Provider not configured on the Web2API server.', type: 'error', retryable: false };

  const errText = (err?.message || err || '').toLowerCase();
  if (errText.includes('429') || errText.includes('rate limit') || errText.includes('too many requests')) {
    return { message: 'Rate limited by AI provider. Waiting before retry…', type: 'warning', retryable: true };
  }
  if (errText.includes('403') || errText.includes('forbidden') || errText.includes('unauthorized')) {
    return { message: 'Access denied — check your API permissions or login status.', type: 'error', retryable: false };
  }
  if (errText.includes('err_name_not_resolved') || errText.includes('err_connection_refused') || errText.includes('socket hang up') || errText.includes('fetch failed')) {
    return { message: 'Network error — check your internet connection.', type: 'error', retryable: true };
  }
  if (errText.includes('timeout') || errText.includes('poll')) return { message: `${agentName} took too long. Try a simpler task.`, type: 'warning', retryable: true };
  if (errText.includes('cancel')) return { message: 'Cancelled.', type: 'info', retryable: false };
  return { message: `${agentName}: ${err?.message || err}`, type: 'error', retryable: false };
}

/* ── Dependency ordering (port) ── */
export function orderTasksByDependency(tasks) {
  if (!tasks || tasks.length <= 1) return tasks;
  const order = ['analysis', 'design', 'code', 'creative', 'writing', 'technical', 'research'];
  return [...tasks].sort((a, b) => {
    const ai = order.indexOf(a.type);
    const bi = order.indexOf(b.type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

/* ── Failover (port) ── */
export function findBetterAgent(task, currentAgent, pool) {
  if (!task || !task.type) return null;
  const candidates = (pool || []).filter((a) => a && a.id !== currentAgent.id);
  if (!candidates.length) return null;
  const normalizedType = task.type;
  const currentScore = currentAgent.strengths?.[normalizedType] || currentAgent.strengths?.code || 1;
  const currentAdjusted = getAdjustedStrength(currentScore, currentAgent.id);
  let best = null;
  let bestAdjusted = 0;
  for (const a of candidates) {
    const baseScore = a.strengths?.[normalizedType] || a.strengths?.code || 1;
    const adjusted = getAdjustedStrength(baseScore, a.id);
    if (adjusted > bestAdjusted) {
      bestAdjusted = adjusted;
      best = a;
    }
  }
  return best && bestAdjusted > currentAdjusted ? best : null;
}

function backoffDelay(attempt) {
  const exp = RETRY_POLICY.baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * RETRY_POLICY.baseDelayMs);
  return Math.min(RETRY_POLICY.maxDelayMs, exp + jitter);
}

function parseSelectedAgents(raw, availableSet) {
  if (!raw) return null;
  const clean = (parsed) => {
    if (!parsed || !Array.isArray(parsed.selected) || !parsed.selected.length) return null;
    const valid = parsed.selected.filter((id) => getAgent(id) && availableSet.has(id));
    const minNeeded = Math.min(2, availableSet.size);
    if (valid.length < minNeeded) return null;
    return { selected: valid, reasoning: parsed.reasoning || '' };
  };
  try {
    const parsed = JSON.parse(raw);
    const r = clean(parsed);
    if (r) return r;
  } catch {
    /* fall through to regex */
  }
  const match = raw.match(/\{"selected":\[[\s\S]*?"reasoning":"[\s\S]*?"\}/);
  if (match) {
    try {
      return clean(JSON.parse(match[0]));
    } catch {
      return null;
    }
  }
  return null;
}

export async function runPipeline({
  goal,
  selectedAgents = null,
  projectFiles = {},
  outDir,
  autoConfirm = true,
  runSettings = {},
  onEvent = () => {},
  client,
  store,
}) {
  const settings = { ...DEFAULT_RUN_SETTINGS, ...(runSettings || {}) };
  const signal = settings.signal || null;
  const emit = (e) => {
    try { onEvent(e); } catch { /* listener errors must not kill the pipeline */ }
  };
  const checkCancelled = () => {
    if (signal && signal.aborted) throw new CancelError();
  };
  const agentProvider = agentProviderOf;
  const brainProvider = () => agentProvider(getAgent(brainId)) || brainId;

  const brainSessions = new Map();
  const agentSessions = new Map();
  const askBrain = async (prompt, opts = {}) => {
    const session = brainSessions.get('brain') || null;
    const res = await client.chat({
      provider: brainProvider(),
      message: prompt,
      modelId: 'auto',
      session,
      ...(signal ? { signal } : {}),
    });
    if (res.session) brainSessions.set('brain', res.session);
    return res.content || '';
  };

  let tasks = [];
  let agentOutputs = {};
  let synthesis = '';
  let finalAgents = [];
  let files = [];
  let conflicts = [];
  let zipPath = null;

  try {
    await initReliability(store);
    console.log(`[Orchestrator] Pipeline start: ${goal.slice(0, 100)}`);

    /* ── 0. Providers ── */
    emit({ type: 'step', step: 'providers' });
    const providers = await client.providers();
    checkCancelled();
    const availableSet = new Set(providers.filter((p) => p.available !== false).map((p) => p.id));
    const activePool = allActiveAgents().filter((a) => availableSet.has(agentProvider(a)));
    if (!activePool.length) {
      throw new Web2ApiError('No Web2API providers available', { code: 'unconfigured', retryable: false });
    }

    /* ── 1. Agent selection ── */
    emit({ type: 'step', step: 'agent-selection' });
    if (selectedAgents && selectedAgents.length) {
      finalAgents = selectedAgents.map((id) => getAgent(id)).filter(Boolean);
      emit({ type: 'agents', agents: finalAgents.map((a) => a.id), reasoning: 'user-specified' });
    } else {
      try {
        const raw = await askBrain(AGENT_SELECT_PROMPT + ` ${goal}`);
        const parsed = parseSelectedAgents(raw, availableSet);
        if (parsed) {
          finalAgents = parsed.selected.map((id) => getAgent(id)).filter(Boolean);
        } else {
          throw new Error('unparseable selection');
        }
      } catch (err) {
        if (err instanceof CancelError) throw err;
        const { selected } = selectAgents(goal);
        finalAgents = selected.map((id) => getAgent(id)).filter(Boolean);
      }
      finalAgents = finalAgents.slice(0, settings.maxAgents);
      if (!finalAgents.length) {
        throw new Web2ApiError('No agents available to run the goal', { code: 'unconfigured', retryable: false });
      }
    }

    /* ── 2. Planning ── */
    emit({ type: 'step', step: 'planning' });
    tasks = await planTasks({ goal, maxAgents: settings.maxAgents, ask: askBrain, store, onEvent: emit });
    checkCancelled();
    if (!tasks || !tasks.length) throw new Error('Planner returned no tasks');
    tasks.forEach((t, i) => { if (!t.id) t.id = `task-${i + 1}`; });

    /* ── 3. Order + route ── */
    emit({ type: 'step', step: 'ordering' });
    tasks = orderTasksByDependency(tasks);
    tasks = routeAll(tasks, finalAgents.map((a) => a.id));

    /* ── 4. Confirm ── */
    emit({ type: 'step', step: 'confirm-tasks' });
    if (!autoConfirm) {
      emit({ type: 'confirm', tasks });
      if (typeof settings.confirm === 'function') {
        const ok = await settings.confirm(tasks);
        if (!ok) {
          return { ok: false, error: 'Cancelled by user', step: 'cancelled', tasks, agentOutputs, synthesis, files, zipPath, conflicts };
        }
      }
    }
    checkCancelled();

    /* ── 5. Execute: parallel across agents, sequential within agent ── */
    emit({ type: 'step', step: 'running' });
    const tasksByAgent = {};
    tasks.forEach((task, taskIndex) => {
      const agentId = task.assignedTo || 'unknown';
      if (!tasksByAgent[agentId]) tasksByAgent[agentId] = [];
      tasksByAgent[agentId].push({ task, taskIndex });
    });

    const agentPromises = Object.entries(tasksByAgent).map(async ([agentId, agentTasks]) => {
      const agent = getAgent(agentId);
      if (!agent) {
        agentTasks.forEach(({ task }) => { task.status = 'error'; });
        return;
      }
      for (const { task } of agentTasks) {
        checkCancelled();
        task.status = 'in-progress';
        emit({ type: 'task-start', taskId: task.id, agentId, description: task.description, taskType: task.type });
        await runTaskOnAgent({ task, agent, goal, projectFiles, tasks, agentOutputs, agentSessions, client, store, activePool, onEvent: emit, signal, settings });
        checkCancelled();
      }
    });
    await Promise.all(agentPromises);
    checkCancelled();

    /* ── 6. Synthesis ── */
    emit({ type: 'step', step: 'synthesis' });
    synthesis = await synthesize({ goal, agentOutputs, client, brainSessions, signal });
    checkCancelled();

    /* ── 7. Files: collect + zip ── */
    emit({ type: 'step', step: 'files' });
    const doneOutputs = Object.entries(agentOutputs)
      .filter(([, d]) => d.status === 'done' && d.output)
      .map(([id, d]) => ({ label: d.agent || id, text: d.output }));
    let manifest;
    if (doneOutputs.length) {
      const extras = [...doneOutputs.slice(1)];
      if (synthesis && synthesis.trim()) extras.push({ label: 'synthesis', text: synthesis });
      manifest = await collectRunArtifacts({ runDir: outDir, text: doneOutputs[0], extraTexts: extras });
    } else {
      manifest = await collectRunArtifacts({ runDir: outDir, text: synthesis ? { label: 'synthesis', text: synthesis } : '', extraTexts: [] });
    }
    files = manifest.files;
    conflicts = manifest.conflicts;
    zipPath = path.join(outDir, `${slugify(goal)}-${Date.now()}.zip`);
    await zipDir(path.join(outDir, 'files'), zipPath);

    /* ── 8. Save chat record ── */
    emit({ type: 'step', step: 'saving' });
    try {
      const chat = await createChat(store, goal, goal.slice(0, 60));
      await saveChat(store, {
        ...chat,
        status: 'done',
        selectedAgents: finalAgents.map((a) => a.id),
        results: { tasks, agentOutputs, synthesis },
        zipPath,
        files,
        conflicts,
      });
    } catch (e) {
      console.error(`[Orchestrator] Failed to save chat: ${e.message}`);
    }

    emit({ type: 'step', step: 'done' });
    console.log('[Orchestrator] Pipeline complete');
    return { ok: true, tasks, agentOutputs, synthesis, files, zipPath, conflicts, selectedAgents: finalAgents.map((a) => a.id) };
  } catch (err) {
    if (err instanceof CancelError) {
      console.log('[Orchestrator] Pipeline cancelled');
      return { ok: false, error: 'Cancelled', step: 'cancelled', tasks, agentOutputs, synthesis, files, zipPath, conflicts };
    }
    if (err instanceof Web2ApiError) throw err;
    const info = friendlyError(err, 'the pipeline');
    console.error(`[Orchestrator] Pipeline failed: ${info.message}`);
    return { ok: false, error: info.message, step: 'error', tasks, agentOutputs, synthesis, files, zipPath, conflicts };
  }
}

/* ── Single task execution with retry/backoff/failover ── */
async function runTaskOnAgent({ task, agent, goal, projectFiles, tasks, agentOutputs, agentSessions, client, store, activePool, onEvent: emit, signal, settings }) {
  const maxAttempts = Math.max(1, Math.min(5, (Number(settings.retries) || DEFAULT_RUN_SETTINGS.retries) + 1));
  let currentAgent = agent;
  let lastError = null;
  let failoverDone = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal && signal.aborted) throw new CancelError();

    if (attempt === 3 && !failoverDone) {
      const better = findBetterAgent(task, currentAgent, activePool);
      if (better) {
        console.log(`[Orchestrator] Failover: ${currentAgent.id} -> ${better.id} for ${task.type} task`);
        emit({ type: 'agent-failover', taskId: task.id, from: currentAgent.id, to: better.id });
        currentAgent = better;
        failoverDone = true;
      }
    }

    if (attempt > 1) {
      emit({ type: 'step', step: 'retry', taskId: task.id, attempt });
      await sleep(backoffDelay(attempt - 1));
      if (signal && signal.aborted) throw new CancelError();
    }

    try {
      let acc = '';
      let emitted = 0;
      const onDelta = (chunk) => {
        acc += chunk;
        if (acc.length - emitted >= 200) {
          emit({ type: 'task-delta', taskId: task.id, agentId: currentAgent.id, text: acc.slice(emitted).trim() });
          emitted = acc.length;
        }
      };

      const prompt = buildTaskPrompt({ ...task, projectFiles }, tasks, agentOutputs, goal, projectFiles);
      const session = agentSessions.get(currentAgent.id) || null;
      const res = await client.chat({
        provider: agentProviderOf(currentAgent),
        modelId: currentAgent.modelId || 'auto',
        message: prompt,
        session,
        onDelta,
        ...(signal ? { signal } : {}),
      });
      if (res.session) agentSessions.set(currentAgent.id, res.session);

      const full = res.content || acc;
      if (full.length > emitted) {
        emit({ type: 'task-delta', taskId: task.id, agentId: currentAgent.id, text: full.slice(emitted).trim() });
      }

      const output = await reviewOutput(task, currentAgent, full);
      if (!output || !String(output).trim()) throw new Error('empty output from agent');

      agentOutputs[task.id] = {
        output: String(output),
        status: 'done',
        task: task.description,
        agent: currentAgent.name,
        agentId: currentAgent.id,
      };
      task.status = 'done';
      task.assignedTo = currentAgent.id;
      emit({ type: 'task-done', taskId: task.id, agentId: currentAgent.id, task: task.description });
      await recordAgentResult(store, currentAgent.id, true);
      return;
    } catch (err) {
      if (err instanceof CancelError) throw err;
      lastError = err;
      console.error(`[Orchestrator] Attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (err instanceof Web2ApiError && err.retryable === false) break;
      if (attempt < maxAttempts) {
        emit({ type: 'task-delta', taskId: task.id, agentId: currentAgent.id, text: '' });
      }
    }
  }

  const errorInfo = friendlyError(lastError, currentAgent.name);
  agentOutputs[task.id] = {
    output: '',
    status: 'error',
    error: errorInfo.message,
    task: task.description,
    agent: currentAgent.name,
    agentId: currentAgent.id,
  };
  task.status = 'error';
  emit({ type: 'task-error', taskId: task.id, agentId: currentAgent.id, error: errorInfo.message, attempt: maxAttempts });
  await recordAgentResult(store, currentAgent.id, false);
}

/* ── Synthesis (brain) with fallback ── */
async function synthesize({ goal, agentOutputs, client, brainSessions, signal }) {
  const completed = Object.entries(agentOutputs).filter(([, d]) => d.status === 'done' && d.output && d.output.length > 50);
  if (!completed.length) return '';
  const prompt = buildSynthesisPrompt(goal, completed.map(([, d]) => compactOutput(String(d.output), Math.max(400, Math.floor(MAX_SYNTHESIS_CHARS / completed.length)))));

  try {
    const session = brainSessions.get('brain') || null;
    const res = await client.chat({
      provider: getAgent(brainId)?.provider || brainId,
      modelId: 'auto',
      message: prompt,
      session,
      ...(signal ? { signal } : {}),
    });
    if (res.session) brainSessions.set('brain', res.session);
    if (res.content && res.content.trim()) return res.content;
  } catch (err) {
    if (err instanceof CancelError) throw err;
    console.error(`[Orchestrator] Synthesis failed, using concatenation fallback: ${err.message}`);
  }

  let fallback = completed.map(([, d]) => d.output).join('\n\n');
  const fileBlocks = fallback.match(/<file[\s\S]*?<\/file>/g);
  if (fileBlocks) fallback = fileBlocks.join('\n');
  return fallback;
}