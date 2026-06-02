/* Orchestrator — runMulti: login-check → select → plan → confirm → route → execute → feedback → synthesize */

const AGENT_SELECT_PROMPT = `You are an agent selection system for a multi-AI pipeline. Given a user goal, select the best combination of AI agents from this list:

- deepseek: Best at code generation, logical reasoning, technical tasks, debugging
- chatgpt: Best at creative writing, content creation, instruction following, explanations, UI/UX
- gemini: Best at analysis, structured thinking, multimodal understanding, research synthesis
- perplexity: Best at web research, fact-checking, finding current information with citations
- huggingface: Best at specialized NLP, code generation, translation, summarization

Return ONLY valid JSON with no markdown:
{"selected":["agent1","agent2",...,"agentN"],"reasoning":"one sentence why each was chosen"}

Select 2-4 agents. User goal:`;

/* ── Agent Selection ── */

async function aiSelectAgents(goal, usedTabs) {
  const selectorId = 'chatgpt';
  const selector = getAgent(selectorId);
  if (!selector) return null;

  const prompt = AGENT_SELECT_PROMPT + ` ${goal}`;
  console.log(`[Selector] Asking ${selector.name} to select agents for:`, goal.slice(0, 80));

  let tab = usedTabs[selector.id];
  if (!tab || !await tabAlive(tab.id)) {
    tab = await openTab(selector.url);
    usedTabs[selector.id] = tab;
  }
  await waitTab(tab.id);
  await sleep(4000);

  if (!(await waitForContentScript(tab.id))) {
    console.warn('[Selector] Content script not available, using fallback');
    delete usedTabs[selector.id];
    return null;
  }

  let r = await send(tab.id, { action: 'inject', text: prompt });
  if (r?.error) { console.warn('[Selector] inject failed:', r.error); delete usedTabs[selector.id]; return null; }
  await sleep(1000);

  r = await send(tab.id, { action: 'submit' });
  if (r?.error) { console.warn('[Selector] submit failed:', r.error); delete usedTabs[selector.id]; return null; }

  const raw = await poll(tab.id, prompt, 60);
  if (!raw || raw === '\u26a0\ufe0f Timeout') { delete usedTabs[selector.id]; return null; }

  try {
    const parsed = JSON.parse(raw);
    if (parsed.selected && Array.isArray(parsed.selected) && parsed.selected.length >= 2) {
      const valid = parsed.selected.filter(id => getAgent(id));
      if (valid.length >= 2) {
        console.log(`[Selector] Selected: ${valid.join(', ')} — ${parsed.reasoning || ''}`);
        return { selected: valid, reasoning: parsed.reasoning || '' };
      }
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

async function ensureTab(agent, usedTabs, manualUrls) {
  let tab = usedTabs[agent.id];
  if (tab && await tabAlive(tab.id)) return tab;
  tab = await getOrCreateTab(agent, manualUrls[agent.id]);
  usedTabs[agent.id] = tab;
  return tab;
}

/* ── Human-readable error messages ── */

function friendlyError(err, agentName) {
  const msg = (err?.message || err || '').toLowerCase();
  if (msg.includes('content script') || msg.includes('content_script'))
    return `${agentName}'s page needs a refresh. The content script wasn't detected. Open ${agentName} in a tab, refresh it, and try again.`;
  if (msg.includes('could not find submit button') || msg.includes('submit'))
    return `${agentName}'s send button couldn't be found. The UI may have changed. Try opening ${agentName} manually and refreshing.`;
  if (msg.includes('timeout') || msg.includes('poll'))
    return `${agentName} took too long to respond. This could be due to heavy traffic or a network issue. Try again later.`;
  if (msg.includes('inject'))
    return `Couldn't type into ${agentName}'s input field. The page layout may have changed.`;
  if (msg.includes('tab') || msg.includes('no tab'))
    return `Couldn't open ${agentName}'s page. Check your internet connection.`;
  if (msg.includes('cancel'))
    return 'The operation was cancelled.';
  return `Something went wrong with ${agentName}: ${err?.message || err}`;
}

/* ── Task execution with retry ── */

async function runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, allAgentOutputs, goal) {
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (multiCancelled) throw new CancelError();
    if (attempt > 1) {
      console.log(`[Orch] Retry #${attempt} for task on ${agent.name}`);
      /* Close the broken tab and open a fresh one */
      const oldTab = usedTabs[agent.id];
      if (oldTab?.id) try { await chrome.tabs.remove(oldTab.id); } catch {}
      delete usedTabs[agent.id];
    }

    try {
      const tab = await ensureTab(agent, usedTabs, manualUrls);
      await waitTab(tab.id);
      await sleep(3000);

      if (!(await waitForContentScript(tab.id))) {
        throw new Error('content_script_not_detected');
      }

      const instruction = buildTaskPrompt(task, tasks, allAgentOutputs, goal);
      let r = await send(tab.id, { action: 'inject', text: instruction });
      if (r?.error) throw new Error(`inject_error: ${r.error}`);

      /* Brief pause to let the AI process the input */
      await sleep(1500);

      r = await send(tab.id, { action: 'submit' });
      if (r?.error) throw new Error(`submit_error: ${r.error}`);

      /* Poll with shorter timeout (60s) and progress updates */
      const output = await pollWithProgress(tab.id, task.description, 60, agent.id, agentOutputs);
      if (multiCancelled) throw new CancelError();

      agentOutputs[agent.id] = { output, status: 'done', task: task.description, agent: agent.name };
      task.status = 'done';
      await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });

      await updateAgentConv(agent.id, tab.id);
      return; /* Success — exit retry loop */
    } catch (err) {
      if (err instanceof CancelError) throw err;
      lastError = err;
      console.error(`[Orch] Attempt ${attempt}/${maxRetries} failed for ${agent.name}:`, err.message);

      /* Mark attempt failure but don't set final error yet */
      if (attempt < maxRetries) {
        agentOutputs[agent.id] = { output: '', status: 'retrying', error: `Attempt ${attempt} failed, retrying...`, task: task.description, agent: agent.name };
        await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
      }
    }
  }

  /* All retries exhausted — fail gracefully */
  const friendly = friendlyError(lastError, agent.name);
  agentOutputs[agent.id] = { output: '', status: 'error', error: friendly, task: task.description, agent: agent.name };
  task.status = 'error';
  await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
}

/* ── Poll with progress updates ── */

async function pollWithProgress(tabId, prompt, maxSec, agentId, agentOutputs) {
  let last = '';
  let stable = 0;
  let readFailures = 0;
  const isCancelled = () => cancelled || multiCancelled;

  for (let i = 0; i < maxSec; i++) {
    if (isCancelled()) throw new CancelError();
    const r = await send(tabId, { action: 'read' });
    if (r?.error) {
      readFailures++;
      if (readFailures >= 8) throw new Error(r.error);
      await sleep(1000);
      continue;
    }
    readFailures = 0;
    const cur = (r?.text || '').trim();
    if (!cur || PLACEHOLDER_RE.test(cur) || isEcho(cur, prompt)) {
      stable = 0; last = ''; await sleep(1000); continue;
    }
    if (cur === last) { stable++; }
    else if (cur) { stable = 0; }
    last = cur;

    /* Push progress updates to UI */
    if (cur.length > 20 && agentOutputs) {
      const existing = agentOutputs[agentId] || {};
      agentOutputs[agentId] = { ...existing, output: cur, status: 'streaming' };
      const state = await getMultiState();
      if (state.agentOutputs) {
        state.agentOutputs[agentId] = agentOutputs[agentId];
        await setMultiState({ agentOutputs: { ...state.agentOutputs } });
      }
    }

    if (stable >= 3 && cur.length > 15) return cur;
    await sleep(1000);
  }
  if (last && !PLACEHOLDER_RE.test(last) && last.length > 15 && !isEcho(last, prompt)) return last;
  return '\u26a0\ufe0f Timeout';
}

/* ── Feedback ── */

async function runFeedback(targetId, targetData, usedTabs, agentOutputs, activeAgentIds = []) {
  const criticAgents = (activeAgentIds.length ? activeAgentIds : ['deepseek', 'chatgpt']).filter(id => getAgent(id) && id !== targetId && (agentOutputs[id]?.status === 'done' || !agentOutputs[id]));
  if (!criticAgents.length) return targetData;

  for (const criticId of criticAgents) {
    if (criticId === targetId) continue;
    const critic = getAgent(criticId);
    if (!critic) continue;

    let tab = usedTabs[criticId];
    if (!tab || !await tabAlive(tab.id)) {
      try {
        tab = await getOrCreateTab(critic);
        usedTabs[criticId] = tab;
        await waitTab(tab.id);
        await sleep(4000);
      } catch { continue; }
    }
    if (!tab) continue;
    if (!(await waitForContentScript(tab.id))) continue;

    let r = await send(tab.id, { action: 'inject', text: `Critique the following output. Identify 3-5 specific ways to improve it. Be direct and constructive.\n\n${targetData.output}` });
    if (r?.error) continue;
    await sleep(1000);
    r = await send(tab.id, { action: 'submit' });
    if (r?.error) continue;

    const critique = await pollWithProgress(tab.id, '', 60, criticId, agentOutputs);
    if (!critique || critique === '\u26a0\ufe0f Timeout') continue;
    await updateAgentConv(criticId, tab.id);

    const improveAgents = criticAgents.filter(id => id !== criticId && id !== targetId && (agentOutputs[id]?.status === 'done' || !agentOutputs[id]));
    for (const improveId of improveAgents) {
      const improve = getAgent(improveId);
      if (!improve) continue;

      let improveTab = usedTabs[improveId];
      if (!improveTab || !await tabAlive(improveTab.id)) {
        try {
          improveTab = await getOrCreateTab(improve);
          usedTabs[improveId] = improveTab;
          await waitTab(improveTab.id);
          await sleep(4000);
        } catch { continue; }
      }
      if (!improveTab) continue;
      if (!(await waitForContentScript(improveTab.id))) continue;

      r = await send(improveTab.id, { action: 'inject', text: `Apply this critique to improve the output:\n\nCritique:\n${critique}\n\nOriginal:\n${targetData.output}\n\nImproved:` });
      if (r?.error) continue;
      await sleep(1000);
      r = await send(improveTab.id, { action: 'submit' });
      if (r?.error) continue;

      const improved = await pollWithProgress(improveTab.id, '', 60, improveId, agentOutputs);
      if (!improved || improved === '\u26a0\ufe0f Timeout') continue;

      await updateAgentConv(improveId, improveTab.id);
      console.log(`[Feedback] ${critic.name} critiqued, ${improve.name} improved ${targetId}`);
      return { ...targetData, output: improved, feedback: critique };
    }
  }
  return targetData;
}

/* ── Main pipeline ── */

async function runMulti(goal, manualUrls = {}, selectedAgents = null, chatId = null) {
  if (multiRunning) {
    await setMultiState({ step: 'error', error: 'Pipeline already running. Wait for it to finish or click Stop.' });
    return;
  }

  console.log('=== Multi-agent pipeline starting ===');
  multiRunning = true;
  multiCancelled = false;

  try {
    const usedTabs = {};

    /* ── 0. Determine agents ── */
    let finalAgents = selectedAgents;

    /* ── 0a. Login Check — first ── */
    if (finalAgents && finalAgents.length > 0) {
      await setMultiState({ step: 'login-check', goal, selectedAgents: finalAgents, tasks: [], agentOutputs: {}, synthesis: '' });
      const loginResult = await runLoginCheck(finalAgents);
      if (!loginResult.allDone) {
        console.warn('[Orch] Login check failed — aborting');
        await setMultiState({ step: 'login-check', loginCheck: { ...loginResult, status: 'failed' } });
        multiRunning = false;
        return;
      }
    } else {
      await setMultiState({ step: 'login-check', goal, selectedAgents: [], tasks: [], agentOutputs: {}, synthesis: '' });
      const selectorCheck = await runLoginCheck(['chatgpt']);
      if (!selectorCheck.allDone) {
        await setMultiState({ step: 'login-check', loginCheck: { ...selectorCheck, status: 'failed', error: 'ChatGPT must be logged in for AI agent selection.' } });
        multiRunning = false;
        return;
      }

      await setMultiState({ step: 'agent-selection', goal, selectedAgents: [], agentReasoning: '', tasks: [], agentOutputs: {}, synthesis: '' });
      const aiResult = await aiSelectAgents(goal, usedTabs);
      if (aiResult) {
        finalAgents = aiResult.selected;
        await setMultiState({ selectedAgents: finalAgents, agentReasoning: aiResult.reasoning });
        console.log(`[Orch] AI selected agents: ${finalAgents.join(', ')}`);
      } else {
        const { selected } = selectAgents(goal);
        finalAgents = selected;
        await setMultiState({ selectedAgents: finalAgents, agentReasoning: 'keyword fallback' });
        console.log(`[Orch] Fallback agents: ${finalAgents.join(', ')}`);
      }

      const remaining = finalAgents.filter(id => id !== 'chatgpt');
      if (remaining.length > 0) {
        await setMultiState({ step: 'login-check', selectedAgents: finalAgents, agentReasoning: '' });
        const loginResult = await runLoginCheck(remaining);
        if (!loginResult.allDone) {
          await setMultiState({ step: 'login-check', loginCheck: { ...loginResult, status: 'failed' } });
          multiRunning = false;
          return;
        }
      }
    }
    if (multiCancelled) throw new CancelError();

    /* ── Initialize shared context ── */
    await setMultiState({ sharedContext: { goal, files: [], agentSummaries: {} } });

    /* ── 1. Plan ── */
    await setMultiState({ step: 'planning', tasks: [], agentOutputs: {}, synthesis: '' });
    let tasks = await planTasks(goal, usedTabs);
    if (multiCancelled) throw new CancelError();

    /* ── 2. Route ── */
    tasks = routeAll(tasks, finalAgents);
    if (multiCancelled) throw new CancelError();

    /* ── 2b. User confirmation of tasks ── */
    await setMultiState({ tasks, step: 'confirm-tasks' });
    console.log('[Orch] Waiting for user to confirm tasks...');

    /* Wait for user confirmation via state signal */
    const confirmTimeout = 300000; /* 5 min */
    const confirmStart = Date.now();
    let confirmed = false;
    while (Date.now() - confirmStart < confirmTimeout) {
      if (multiCancelled) throw new CancelError();
      const state = await getMultiState();
      if (state.tasksConfirmed === true) { confirmed = true; break; }
      if (state.tasksConfirmed === false) {
        /* User rejected — cancel */
        console.log('[Orch] User rejected tasks — aborting');
        await setMultiState({ step: 'cancelled', error: null });
        multiRunning = false;
        return;
      }
      await sleep(500);
    }
    if (!confirmed) {
      console.log('[Orch] Task confirmation timed out — proceeding anyway');
    }
    if (multiCancelled) throw new CancelError();

    /* ── 3. Execute (with retry, parallel for different agents) ── */
    const agentOutputs = {};

    /* Group tasks by agent for parallel execution */
    const agentTaskGroups = {};
    for (const task of tasks) {
      task.status = 'pending';
      const id = task.assignedTo || 'unassigned';
      if (!agentTaskGroups[id]) agentTaskGroups[id] = [];
      agentTaskGroups[id].push(task);
    }

    await setMultiState({ tasks: [...tasks], step: 'running' });

    /* Execute tasks IN PARALLEL across different agents.
       Tasks for the same agent run sequentially (one at a time per tab).
       Different agents execute concurrently for maximum speed. */
    const groupEntries = Object.entries(agentTaskGroups);
    const agentResults = await Promise.allSettled(
      groupEntries.map(async ([agentId, agentTasks]) => {
        if (multiCancelled) throw new CancelError();
        const agent = getAgent(agentId);
        if (!agent) {
          agentTasks.forEach(t => { t.status = 'error'; });
          return;
        }

        for (const task of agentTasks) {
          if (multiCancelled) throw new CancelError();
          task.status = 'in-progress';
          await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
          console.log(`[Orch] Running task on ${agent.name} (type: ${task.type})`);

          try {
            await runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, agentOutputs, goal);
          } catch (err) {
            if (err instanceof CancelError) throw err;
            /* runTaskOnAgent already handles its own error recovery */
          }
        }
      })
    );

    /* Log any parallel execution failures */
    for (const result of agentResults) {
      if (result.status === 'rejected' && !(result.reason instanceof CancelError)) {
        console.error('[Orch] Parallel execution error:', result.reason?.message);
      }
    }
    if (multiCancelled) throw new CancelError();

    /* ── 4. Feedback ── */
    const completed = Object.entries(agentOutputs).filter(([, d]) => d.status === 'done');
    if (completed.length >= 2) {
      const loopCount = 1; /* Reduced from 2 to 1 for speed */
      for (let i = 1; i <= loopCount; i++) {
        if (multiCancelled) throw new CancelError();
        await setMultiState({ step: 'feedback', loopIndex: i, loopCount });

        const targetEntry = completed.find(([id]) => id !== 'deepseek' && id !== 'chatgpt') || completed[completed.length - 1];
        if (!targetEntry) break;
        const [targetId, targetData] = targetEntry;

        if (targetData.output) {
          try {
            const result = await runFeedback(targetId, targetData, usedTabs, agentOutputs, finalAgents);
            agentOutputs[targetId] = result;
            await setMultiState({ agentOutputs: { ...agentOutputs } });
          } catch (err) {
            if (err instanceof CancelError) throw err;
            console.error(`[Feedback] loop ${i} failed:`, err.message);
          }
        }
      }
    }
    if (multiCancelled) throw new CancelError();

    /* ── 5. Synthesize ── */
    await setMultiState({ step: 'synthesis' });

    let finalSynthesis = '';
    const completedOutputs = Object.entries(agentOutputs).filter(([, d]) => d.status === 'done' && d.output);
    const parts = completedOutputs.map(([id, d]) => `=== ${getAgent(id)?.name || id} ===\n${d.output}`).join('\n\n');

    if (parts) {
      const synthPrompt = `Synthesize the following outputs from multiple AI agents into a single coherent final response. Combine insights, resolve contradictions, and produce a polished result.\n\n${parts}\n\nFinal synthesized output:`;
      const synthCandidates = ['chatgpt', 'gemini', 'deepseek'].filter(id => getAgent(id));

      for (const synthId of synthCandidates) {
        const synthAgent = getAgent(synthId);
        if (!synthAgent) continue;
        try {
          const synthTab = await ensureTab(synthAgent, usedTabs, {});
          await waitTab(synthTab.id);
          await sleep(4000);
          if (!(await waitForContentScript(synthTab.id))) continue;

          let r = await send(synthTab.id, { action: 'inject', text: synthPrompt });
          if (r?.error) continue;
          await sleep(1000);
          r = await send(synthTab.id, { action: 'submit' });
          if (r?.error) continue;

          const raw = await pollWithProgress(synthTab.id, synthPrompt, 60, synthId, agentOutputs);
          if (!raw || raw === '\u26a0\ufe0f Timeout') continue;

          await updateAgentConv(synthAgent.id, synthTab.id);
          finalSynthesis = raw;
          console.log(`[Synth] Used ${synthAgent.name}`);
          break;
        } catch (err) {
          console.warn(`[Synth] ${synthAgent.name} failed:`, err.message);
        }
      }
      if (!finalSynthesis) finalSynthesis = parts;
    }

    await setMultiState({ synthesis: finalSynthesis, step: 'done' });

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

    console.log('=== Multi-agent pipeline complete ===');
  } catch (err) {
    if (err instanceof CancelError) {
      console.log('=== Multi-agent pipeline cancelled ===');
      await setMultiState({ step: 'cancelled', error: null });
      return;
    }
    console.error('Multi-agent pipeline failed:', err);
    const friendly = friendlyError(err, 'the pipeline');
    await setMultiState({ step: 'error', error: friendly });
  } finally {
    multiRunning = false;
    /* Reset task confirmation flag */
    setMultiState({ tasksConfirmed: null });
  }
}
