/* orchestrator.js v2.1 — Production pipeline: dependency ordering, cleanup, error recovery */

const AGENT_SELECT_PROMPT = `You are an agent selection system. Given a user goal, select the best combination of AI agents:

- deepseek: Code, reasoning, technical
- chatgpt: Creative writing, instructions, UI/UX
- gemini: Analysis, structured thinking, multimodal
- perplexity: Web research, fact-checking, citations
- huggingface: Specialized NLP, translation, summarization

Return ONLY valid JSON with no markdown:
{"selected":["agent1","agent2",...,"agentN"],"reasoning":"one sentence"}

Select 2-4 agents. User goal:`;

const BRAIN_ID = 'deepseek';
const DEFAULT_RUN_SETTINGS = { retries: 2, maxAgents: 4 };

/* ── Agent Selection ── */
async function aiSelectAgents(goal, usedTabs) {
  const selector = getAgent(BRAIN_ID);
  if (!selector) return null;

  const prompt = AGENT_SELECT_PROMPT + ` ${goal}`;
  console.log(`[Selector] Asking ${selector.name} to select agents`);

  let tab = usedTabs[selector.id];
  if (!tab || !(await tabAlive(tab.id))) {
    tab = await openHiddenTab(selector.url);
    usedTabs[selector.id] = tab;
  }
  await waitTab(tab.id);
  await sleep(4000);

  if (!(await waitForContentScript(tab.id))) {
    delete usedTabs[selector.id];
    return null;
  }

  let r = await send(tab.id, { action: 'inject', text: prompt });
  if (r?.error) { delete usedTabs[selector.id]; return null; }
  await sleep(1000);
  r = await send(tab.id, { action: 'submit' });
  if (r?.error) { delete usedTabs[selector.id]; return null; }

  const raw = await poll(tab.id, prompt, 60);
  if (!raw || raw === '\u26a0\ufe0f Timeout') { delete usedTabs[selector.id]; return null; }

  try {
    const parsed = JSON.parse(raw);
    if (parsed.selected && Array.isArray(parsed.selected) && parsed.selected.length >= 2) {
      const valid = parsed.selected.filter(id => getAgent(id));
      if (valid.length >= 2) return { selected: valid, reasoning: parsed.reasoning || '' };
    }
  } catch {
    const match = raw.match(/\{"selected":\[[\s\S]*?"reasoning":"[\s\S]*?"\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        const valid = parsed.selected.filter(id => getAgent(id));
        if (valid.length >= 2) return { selected: valid, reasoning: parsed.reasoning || '' };
      } catch {}
    }
  }
  return null;
}

/* ── Tab helpers ── */
async function ensureTab(agent, usedTabs, manualUrls, taskKey) {
  const key = taskKey || agent.id;
  let tab = usedTabs[key];
  if (tab && (await tabAliveWithRetry(tab.id))) {
    /* Brief activation to ensure content script is responsive */
    await pokeTab(tab.id);
    return tab;
  }
  tab = await getOrCreateTab(agent, manualUrls[agent.id]);
  usedTabs[key] = tab;
  return tab;
}

/* ── Error messages ── */
function friendlyError(err, agentName) {
  const errText = (err?.message || err || '').toLowerCase();
  if (errText.includes('429') || errText.includes('rate limit') || errText.includes('too many requests')) {
    return { message: 'Rate limited by AI provider. Waiting before retry…', type: 'warning', retryable: true };
  }
  if (errText.includes('403') || errText.includes('forbidden') || errText.includes('unauthorized')) {
    return { message: 'Access denied — check your API permissions or login status.', type: 'error', retryable: false };
  }
  if (errText.includes('crashed') || errText.includes('aw snap') || errText.includes('unresponsive')) {
    return { message: 'Browser tab crashed — will reopen and retry.', type: 'warning', retryable: true };
  }
  if (errText.includes('ERR_NAME_NOT_RESOLVED') || errText.includes('ERR_CONNECTION_REFUSED')) {
    return { message: 'Network error — check your internet connection.', type: 'error', retryable: true };
  }
  if (errText.includes('out of memory') || errText.includes('heap limit') || errText.includes('JavaScript heap')) {
    return { message: 'Browser out of memory. Try closing other tabs.', type: 'error', retryable: false };
  }
  if (errText.includes('content_script')) return { message: `${agentName} page needs refresh. Open ${agentName} manually and reload.`, type: 'error', retryable: true };
  if (errText.includes('submit')) return { message: `${agentName} send button not found. The UI may have changed.`, type: 'error', retryable: true };
  if (errText.includes('inject')) return { message: `Could not type into ${agentName}.`, type: 'error', retryable: true };
  if (errText.includes('timeout') || errText.includes('poll')) return { message: `${agentName} took too long. Try a simpler task.`, type: 'warning', retryable: true };
  if (errText.includes('cancel')) return { message: 'Cancelled.', type: 'info', retryable: false };
  return { message: `${agentName}: ${err?.message || err}`, type: 'error', retryable: false };
}

function findBetterAgent(task, currentAgent) {
  if (!task || !task.type) return null;
  const pool = allActiveAgents().filter(a => a.id !== currentAgent.id);
  if (!pool.length) return null;
  const normalizedType = task.type;
  const currentScore = currentAgent.strengths[normalizedType] || currentAgent.strengths.code || 1;
  const currentAdjusted = getAdjustedStrength(currentScore, currentAgent.id);
  let best = null, bestAdjusted = 0;
  for (const a of pool) {
    const baseScore = a.strengths[normalizedType] || a.strengths.code || 1;
    const adjusted = getAdjustedStrength(baseScore, a.id);
    if (adjusted > bestAdjusted) {
      bestAdjusted = adjusted;
      best = a;
    }
  }
  return best && bestAdjusted > currentAdjusted ? best : null;
}

/* ── Task execution with retry and dependency ordering ── */

/* Determine task dependency order based on types */
function orderTasksByDependency(tasks) {
  if (!tasks || tasks.length <= 1) return tasks;
  const order = ['analysis', 'design', 'code', 'creative', 'writing', 'technical', 'research'];
  return [...tasks].sort((a, b) => {
    const ai = order.indexOf(a.type), bi = order.indexOf(b.type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

async function runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, allAgentOutputs, goal, projectFiles = {}, taskKey, runSettings = DEFAULT_RUN_SETTINGS) {
  const maxRetries = Math.max(1, Math.min(5, Number(runSettings.retries) || DEFAULT_RUN_SETTINGS.retries));
  const outputKey = taskKey || agent.id;
  let lastError = null;
  let failoverDone = false;
  const preCheckTab = usedTabs[taskKey || agent.id];
  if (!preCheckTab || !(await tabAlive(preCheckTab.id))) {
    console.log(`[Orch] Tab for ${agent.name} not alive before task, will reopen`);
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (multiCancelled) throw new CancelError();
    if (attempt === 3 && !failoverDone) {
      const betterAgent = findBetterAgent(task, agent);
      if (betterAgent) {
        console.log(`[Orch] Failover: ${agent.name} -> ${betterAgent.name} for ${task.type} task`);
        agent = betterAgent;
        failoverDone = true;
      }
    }
    if (attempt > 1) {
      console.log(`[Orch] Retry #${attempt} for ${agent.name}`);
      const key = taskKey || agent.id;
      const oldTab = usedTabs[key];
      if (oldTab?.id) try { await chrome.tabs.remove(oldTab.id); } catch {}
      delete usedTabs[key];
    }

    try {
      const tab = await ensureTab(agent, usedTabs, manualUrls, taskKey);
      await waitTab(tab.id);
      await sleep(3000);

      /* Brief activation ensures the off-screen popup tab fully renders
       * and its content script is responsive. Chrome needs a moment of
       * active focus for JS-heavy sites like ChatGPT/Gemini. */
      await pokeTab(tab.id);
      await sleep(500);

      if (!(await waitForContentScript(tab.id))) {
        throw new Error('content_script_not_detected');
      }

      /* Build instruction directly — no brainWriteTaskPrompt.
       * The brain write step was causing response contamination (planner JSON
       * leaking into specialist instructions). buildTaskPrompt produces clean,
       * direct instructions without extra polling. */
      const instruction = buildTaskPrompt({ ...task, projectFiles }, tasks, allAgentOutputs, goal);

      /* Specialist executes */
      console.log(`[Brain] ${agent.name} executing: ${task.description.slice(0, 50)}`);
      await setMultiState({ step: 'brain-executing', brainPhase: `${agent.name} executing task...`, agentOutputs: { ...agentOutputs } });

      /* Activate tab right before interaction. */
      await pokeTab(tab.id);
      let r = await send(tab.id, { action: 'inject', text: instruction });
      if (r?.error) throw new Error(`inject: ${r.error}`);
      await sleep(1500);

      await pokeTab(tab.id);
      r = await send(tab.id, { action: 'submit' });
      if (r?.error) throw new Error(`submit: ${r.error}`);

      /* Code/creative/writing tasks need more patience */
      const pollSeconds = ['code', 'creative', 'writing'].includes(task.type) ? 300 : 120;
      const specialistOutput = await pollWithProgress(tab.id, task.description, pollSeconds, outputKey, agentOutputs, agent.id);
      if (multiCancelled) throw new CancelError();

      if (!specialistOutput || specialistOutput === '\u26a0\ufe0f Timeout') {
        throw new Error('timeout: no response from agent');
      }

      /* Heuristic review */
      const finalOutput = await brainReviewOutput(task, agent, specialistOutput);

      agentOutputs[outputKey] = { output: finalOutput, status: 'done', task: task.description, agent: agent.name, agentId: agent.id };
      task.status = 'done';
      await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
      await updateAgentConv(agent.id, tab.id);
      await recordAgentResult(agent.id, true);
      return;

    } catch (err) {
      if (err instanceof CancelError) throw err;
      lastError = err;
      console.error(`[Orch] Attempt ${attempt}/${maxRetries} failed:`, err.message);
      if (attempt < maxRetries) {
        agentOutputs[outputKey] = { output: '', status: 'retrying', error: `Retry ${attempt}...`, task: task.description, agent: agent.name, agentId: agent.id };
        await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
      }
    }
  }

  const errorInfo = friendlyError(lastError, agent.name);
  agentOutputs[outputKey] = { output: '', status: 'error', error: errorInfo.message, task: task.description, agent: agent.name, agentId: agent.id };
  task.status = 'error';
  await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
  await recordAgentResult(agent.id, false);
}

/* ── Poll with progress ── */
async function pollWithProgress(tabId, prompt, maxSec, outputKey, agentOutputs, agentId) {
  let last = '';
  let stable = 0;
  let maxLen = 0;
  let readFailures = 0;
  const isCancelled = () => cancelled || multiCancelled;

  for (let i = 0; i < maxSec; i++) {
    if (isCancelled()) throw new CancelError();
    const r = await send(tabId, { action: 'read' });
    if (r?.error) {
      readFailures++;
      if (readFailures >= 10) throw new Error(r.error);
      await sleep(1000);
      continue;
    }
    readFailures = 0;
    const cur = (r?.text || '').trim();
    if (!cur || PLACEHOLDER_RE.test(cur) || isEcho(cur, prompt)) {
      stable = 0; last = ''; await sleep(1000); continue;
    }

    if (cur.length > maxLen) {
      maxLen = cur.length;
      stable = 0;
      last = cur;
    } else if (cur === last) {
      stable++;
      const required = Math.min(20, Math.max(5, Math.floor(cur.length / 200)));
      if (stable >= required && cur.length > 10) return cur;
    } else {
      stable = 0;
      last = cur;
    }

    /* Push progress to UI */
    if (cur.length > 20 && agentOutputs) {
      const existing = agentOutputs[outputKey] || {};
      agentOutputs[outputKey] = { ...existing, output: cur, status: 'streaming', agentId: agentId || existing.agentId };
      const state = await getMultiState();
      if (state.agentOutputs) {
        state.agentOutputs[outputKey] = agentOutputs[outputKey];
        await setMultiState({ agentOutputs: { ...state.agentOutputs } });
      }
    }

    await sleep(1000);
  }
  if (last && !PLACEHOLDER_RE.test(last) && last.length > 10 && !isEcho(last, prompt)) return last;
  return '\u26a0\ufe0f Timeout';
}

/* ── Main pipeline ── */
async function runMulti(goal, manualUrls = {}, selectedAgents = null, chatId = null, projectFiles = {}, runSettings = DEFAULT_RUN_SETTINGS) {
  if (multiRunning) {
    await setMultiState({ step: 'error', error: 'Pipeline already running.' });
    return;
  }

  console.log('=== THE ORCHESTRATOR v2.1 — Production pipeline ===');
  multiRunning = true;
  multiCancelled = false;
  startKeepalive();

  let heartbeatInterval;
  try {
    const usedTabs = {};
    const settings = { ...DEFAULT_RUN_SETTINGS, ...(runSettings || {}) };
    let finalAgents = selectedAgents;

    /* ── 0a. Login Check ── */
    if (finalAgents && finalAgents.length > 0) {
      await setMultiState({ step: 'login-check', goal, selectedAgents: finalAgents, tasks: [], agentOutputs: {}, synthesis: '' });
      const loginResult = await runLoginCheck(finalAgents);
      if (!loginResult.allDone) {
        await setMultiState({ step: 'login-check', loginCheck: { ...loginResult, status: 'failed' } });
        multiRunning = false; stopKeepalive(); return;
      }
    } else {
      await setMultiState({ step: 'login-check', goal, selectedAgents: [], tasks: [], agentOutputs: {}, synthesis: '' });
      const selectorCheck = await runLoginCheck([BRAIN_ID]);
      if (!selectorCheck.allDone) {
        await setMultiState({ step: 'login-check', loginCheck: { ...selectorCheck, status: 'failed', error: 'Brain agent must be logged in.' } });
        multiRunning = false; stopKeepalive(); return;
      }
      await setMultiState({ step: 'agent-selection' });
      const aiResult = await aiSelectAgents(goal, usedTabs);
      if (aiResult) {
        finalAgents = aiResult.selected.slice(0, settings.maxAgents);
        await setMultiState({ selectedAgents: finalAgents, agentReasoning: aiResult.reasoning });
      } else {
        const { selected } = selectAgents(goal);
        finalAgents = selected.slice(0, settings.maxAgents);
        await setMultiState({ selectedAgents: finalAgents, agentReasoning: 'keyword fallback' });
      }
      const remaining = finalAgents.filter(id => id !== BRAIN_ID);
      if (remaining.length > 0) {
        await setMultiState({ step: 'login-check', selectedAgents: finalAgents });
        const loginResult = await runLoginCheck(remaining);
        if (!loginResult.allDone) {
          await setMultiState({ step: 'login-check', loginCheck: { ...loginResult, status: 'failed' } });
          multiRunning = false; stopKeepalive(); return;
        }
      }
    }
    if (multiCancelled) throw new CancelError();

    await setMultiState({ sharedContext: { goal, files: Object.keys(projectFiles), agentSummaries: {} } });

    heartbeatInterval = setInterval(async () => {
      for (const [key, tab] of Object.entries(usedTabs)) {
        if (!(await tabAlive(tab.id))) {
          const agent = getAgent(key.replace(/-\d+$/, ''));
          if (agent) {
            console.log(`[Heartbeat] Reopening tab for ${agent.name}`);
            const newTab = await openHiddenTab(agent.url);
            usedTabs[key] = newTab;
          }
        }
      }
    }, 5000);

    /* ── 1. Brain creates the task plan ── */
    await setMultiState({ step: 'planning' });
    let tasks = await planTasks(goal, usedTabs, settings.maxAgents);
    if (multiCancelled) throw new CancelError();

    /* ── 2. Route with dependency ordering ── */
    tasks = orderTasksByDependency(tasks);
    tasks = routeAll(tasks, finalAgents);
    if (multiCancelled) throw new CancelError();

    /* ── 2b. User confirmation with timeout ── */
    await setMultiState({ tasks, step: 'confirm-tasks' });
    const confirmTimeout = 300000;
    const confirmStart = Date.now();
    let confirmed = false;
    while (Date.now() - confirmStart < confirmTimeout) {
      if (multiCancelled) throw new CancelError();
      const state = await getMultiState();
      if (state.tasksConfirmed === true) { confirmed = true; break; }
      if (state.tasksConfirmed === false) {
        await setMultiState({ step: 'cancelled' }); multiRunning = false; stopKeepalive(); return;
      }
      await sleep(500);
    }
    if (multiCancelled) throw new CancelError();

    /* ── 3. Execute: SEQUENTIAL per agent (parallel across agents) ── */
    const agentOutputs = {};
    await setMultiState({ tasks: [...tasks], step: 'running' });

    /* Group tasks by assigned agent so we never open two tabs for the same
     * agent simultaneously. This avoids rate-limit conflicts and cross-tab
     * interference (especially for slower code-generation tasks). */
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
      for (const { task, taskIndex } of agentTasks) {
        if (multiCancelled) throw new CancelError();
        task.status = 'in-progress';
        await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs }, brainPhase: `${agent.name} starting...` });

        try {
          const taskKey = `${agent.id}-${taskIndex}`;
          await runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, agentOutputs, goal, projectFiles, taskKey, settings);
        } catch (err) {
          if (err instanceof CancelError) throw err;
          task.status = 'error';
        }
      }
    });

    await Promise.all(agentPromises);
    if (multiCancelled) throw new CancelError();

    /* ── 4. Final brain synthesis ── */
    await setMultiState({ step: 'synthesis', brainPhase: 'Brain synthesizing final output...' });

    let finalSynthesis = '';
    /* Filter to only COMPLETED outputs with content */
    const completedOutputs = Object.entries(agentOutputs).filter(([, d]) => d.status === 'done' && d.output && d.output.length > 50);
    
    if (completedOutputs.length > 0) {
      /* Clean prompt — NO specialist summaries. Feeding DeepSeek raw specs
       * causes corrupted CSS (duplicated rules, floating declarations). */
      const synthPrompt = `Generate a single self-contained HTML file for: ${goal}

Rules:
- All CSS in <style>, all JS in <script>
- Semantic HTML5, responsive, production-ready
- Wrap the file in <file name="filename.ext"> and </file> tags`;

      const synthTab = usedTabs[BRAIN_ID];
      if (synthTab && (await tabAlive(synthTab.id)) && (await waitForContentScript(synthTab.id))) {
        /* CRITICAL: Reset the brain tab BEFORE sending the synthesis prompt.
         * This clears any old planner/brainWrite response text from the page,
         * so the synthesis response is detected cleanly. */
        await send(synthTab.id, { action: 'reset' });
        await pokeTab(synthTab.id);
        let r = await send(synthTab.id, { action: 'inject', text: synthPrompt });
        if (!r?.error) {
          await sleep(1000);
          r = await send(synthTab.id, { action: 'submit' });
          if (!r?.error) {
            /* Use plain poll() NOT pollWithProgress() — pollWithProgress pushes
             * to agentOutputs which makes DeepSeek appear as a "streaming" agent. */
            const raw = await poll(synthTab.id, synthPrompt, 120);
            if (raw && raw !== '\u26a0\ufe0f Timeout') finalSynthesis = raw;
          }
        }
      }
      /* Fallback: concatenate all completed specialist outputs directly */
      if (!finalSynthesis) {
        finalSynthesis = completedOutputs.map(([id, d]) => d.output).join('\n\n');
        /* Extract file tags if present */
        const fileBlocks = finalSynthesis.match(/<file[\s\S]*?<\/file>/g);
        if (fileBlocks) finalSynthesis = fileBlocks.join('\n');
      }
    }

    await setMultiState({ synthesis: finalSynthesis, step: 'done', brainPhase: '' });

    /* Save to chat */
    if (chatId) {
      try {
        const chat = await getChat(chatId);
        if (chat) {
          chat.agentConvs = {};
          for (const [agentId, tab] of Object.entries(usedTabs)) {
            const url = await getTabUrl(tab.id);
            if (url) chat.agentConvs[agentId] = url;
          }
          chat.status = 'done';
          chat.selectedAgents = finalAgents;
          chat.results = { tasks, agentOutputs, synthesis: finalSynthesis };
          await saveChat(chat);
        }
      } catch (e) { console.error('Failed to save chat:', e); }
    }

    console.log('=== Pipeline complete ===');
  } catch (err) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (err instanceof CancelError) {
      console.log('=== Pipeline cancelled ===');
      await setMultiState({ step: 'cancelled' }); return;
    }
    console.error('Pipeline failed:', err);
    await setMultiState({ step: 'error', error: friendlyError(err, 'the pipeline').message });
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    multiRunning = false;
    setMultiState({ tasksConfirmed: null });
    /* Cleanup hidden window */
    setTimeout(() => cleanupHiddenWindow(), 5000);
    stopKeepalive();
  }
}
