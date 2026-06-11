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
  const msg = (err?.message || err || '').toLowerCase();
  if (msg.includes('content_script')) return `${agentName} page needs refresh. Open ${agentName} manually and reload.`;
  if (msg.includes('submit')) return `${agentName} send button not found. The UI may have changed.`;
  if (msg.includes('inject')) return `Could not type into ${agentName}.`;
  if (msg.includes('timeout') || msg.includes('poll')) return `${agentName} took too long. Try a simpler task.`;
  if (msg.includes('cancel')) return 'Cancelled.';
  return `${agentName}: ${err?.message || err}`;
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

async function runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, allAgentOutputs, goal, projectFiles = {}, taskKey) {
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (multiCancelled) throw new CancelError();
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

      /* Get instruction.
       * Skip brain writing when:
       * 1. All tasks go to the same agent (brain not needed)
       * 2. The target agent IS the brain (no need to self-instruct) */
      const assignedAgents = tasks.map(t => t.assignedTo).filter(Boolean);
      const allSameAgent = assignedAgents.length > 0 && assignedAgents.every(a => a === assignedAgents[0]);
      const targetIsBrain = agent.id === BRAIN_ID;
      let instruction;
      if (!allSameAgent && !targetIsBrain) {
        console.log(`[Brain] Writing task assignment for ${agent.name}...`);
        await setMultiState({ step: 'brain-writing', brainPhase: `Brain preparing task for ${agent.name}...`, agentOutputs: { ...agentOutputs } });
        instruction = await brainWriteTaskPrompt(task, agent, tasks, allAgentOutputs, goal, usedTabs, projectFiles);
        /* CRITICAL: Reset the brain tab so its previous response is NOT
         * detected as the task output when we poll later. */
        if (usedTabs[BRAIN_ID]) {
          await send(usedTabs[BRAIN_ID].id, { action: 'reset' });
        }
      } else {
        instruction = buildTaskPrompt(task, tasks, allAgentOutputs, goal);
      }

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

      const specialistOutput = await pollWithProgress(tab.id, task.description, 120, agent.id, agentOutputs);
      if (multiCancelled) throw new CancelError();

      if (!specialistOutput || specialistOutput === '\u26a0\ufe0f Timeout') {
        throw new Error('timeout: no response from agent');
      }

      /* Heuristic review */
      const finalOutput = await brainReviewOutput(task, agent, specialistOutput);

      agentOutputs[agent.id] = { output: finalOutput, status: 'done', task: task.description, agent: agent.name };
      task.status = 'done';
      await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
      await updateAgentConv(agent.id, tab.id);
      return;

    } catch (err) {
      if (err instanceof CancelError) throw err;
      lastError = err;
      console.error(`[Orch] Attempt ${attempt}/${maxRetries} failed:`, err.message);
      if (attempt < maxRetries) {
        agentOutputs[agent.id] = { output: '', status: 'retrying', error: `Retry ${attempt}...`, task: task.description, agent: agent.name };
        await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
      }
    }
  }

  const friendly = friendlyError(lastError, agent.name);
  agentOutputs[agent.id] = { output: '', status: 'error', error: friendly, task: task.description, agent: agent.name };
  task.status = 'error';
  await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
}

/* ── Poll with progress ── */
async function pollWithProgress(tabId, prompt, maxSec, agentId, agentOutputs) {
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
      const existing = agentOutputs[agentId] || {};
      agentOutputs[agentId] = { ...existing, output: cur, status: 'streaming' };
      const state = await getMultiState();
      if (state.agentOutputs) {
        state.agentOutputs[agentId] = agentOutputs[agentId];
        await setMultiState({ agentOutputs: { ...state.agentOutputs } });
      }
    }

    await sleep(1000);
  }
  if (last && !PLACEHOLDER_RE.test(last) && last.length > 10 && !isEcho(last, prompt)) return last;
  return '\u26a0\ufe0f Timeout';
}

/* ── Main pipeline ── */
async function runMulti(goal, manualUrls = {}, selectedAgents = null, chatId = null, projectFiles = {}) {
  if (multiRunning) {
    await setMultiState({ step: 'error', error: 'Pipeline already running.' });
    return;
  }

  console.log('=== THE ORCHESTRATOR v2.1 — Production pipeline ===');
  multiRunning = true;
  multiCancelled = false;
  startKeepalive();

  try {
    const usedTabs = {};
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
        finalAgents = aiResult.selected;
        await setMultiState({ selectedAgents: finalAgents, agentReasoning: aiResult.reasoning });
      } else {
        const { selected } = selectAgents(goal);
        finalAgents = selected;
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

    /* ── 1. Brain creates the task plan ── */
    await setMultiState({ step: 'planning' });
    let tasks = await planTasks(goal, usedTabs);
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

    /* ── 3. Execute: ALL tasks in parallel ── */
    const agentOutputs = {};
    await setMultiState({ tasks: [...tasks], step: 'running' });

    const allTaskPromises = tasks.map(async (task) => {
      if (multiCancelled) throw new CancelError();
      const agent = getAgent(task.assignedTo);
      if (!agent) { task.status = 'error'; return; }

      task.status = 'in-progress';
      await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs }, brainPhase: `${agent.name} starting...` });

      try {
        const taskKey = agent.id + '-' + tasks.indexOf(task);
        await runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, agentOutputs, goal, projectFiles, taskKey);
      } catch (err) {
        if (err instanceof CancelError) throw err;
      }
    });

    await Promise.all(allTaskPromises);
    if (multiCancelled) throw new CancelError();

    /* ── 4. Final brain synthesis ── */
    await setMultiState({ step: 'synthesis', brainPhase: 'Brain synthesizing final output...' });

    let finalSynthesis = '';
    /* Filter to only COMPLETED outputs with content */
    const completedOutputs = Object.entries(agentOutputs).filter(([, d]) => d.status === 'done' && d.output && d.output.length > 50);
    
    if (completedOutputs.length > 0) {
      /* Extract key requirements — first 200 chars of each specialist output */
      const summaries = completedOutputs.map(([id, d]) => {
        const name = getAgent(id)?.name || id;
        /* Take first meaningful paragraph */
        const lines = d.output.split('\n').filter(l => l.trim().length > 20);
        const summary = lines.slice(0, 3).join(' ').slice(0, 400);
        return `${name}: ${summary}`;
      }).join('\n');

      const synthPrompt = `Build the project: ${goal}

Requirements from specialists:
${summaries}

Generate ONE self-contained HTML file with embedded CSS/JS.
Wrap the file in <file name="filename.ext"> and </file> tags.
Make it complete, working, and production-ready.`;

      const synthTab = usedTabs[BRAIN_ID];
      if (synthTab && (await tabAlive(synthTab.id)) && (await waitForContentScript(synthTab.id))) {
        await pokeTab(synthTab.id);
        let r = await send(synthTab.id, { action: 'inject', text: synthPrompt });
        if (!r?.error) {
          await sleep(1000);
          r = await send(synthTab.id, { action: 'submit' });
          if (!r?.error) {
            const raw = await pollWithProgress(synthTab.id, synthPrompt, 120, BRAIN_ID, agentOutputs);
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
    if (err instanceof CancelError) {
      console.log('=== Pipeline cancelled ===');
      await setMultiState({ step: 'cancelled' }); return;
    }
    console.error('Pipeline failed:', err);
    await setMultiState({ step: 'error', error: friendlyError(err, 'the pipeline') });
  } finally {
    multiRunning = false;
    setMultiState({ tasksConfirmed: null });
    /* Cleanup hidden window */
    setTimeout(() => cleanupHiddenWindow(), 5000);
    stopKeepalive();
  }
}
