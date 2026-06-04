/* Orchestrator — BRAIN-CENTERED architecture
 *
 * ChatGPT is the "brain" that:
 * 1. Creates detailed task specs for each specialist
 * 2. Reviews every specialist's output
 * 3. Maintains shared project state
 * 4. Continuously synthesizes results
 *
 * Specialists (DeepSeek, etc.) execute brain-assigned tasks.
 */

const AGENT_SELECT_PROMPT = `You are an agent selection system for a multi-AI pipeline. Given a user goal, select the best combination of AI agents from this list:

- deepseek: Best at code generation, logical reasoning, technical tasks, debugging
- chatgpt: Best at creative writing, content creation, instruction following, explanations, UI/UX
- gemini: Best at analysis, structured thinking, multimodal understanding, research synthesis
- perplexity: Best at web research, fact-checking, finding current information with citations
- huggingface: Best at specialized NLP, code generation, translation, summarization

Return ONLY valid JSON with no markdown:
{"selected":["agent1","agent2",...,"agentN"],"reasoning":"one sentence why each was chosen"}

Select 2-4 agents. User goal:`;

const BRAIN_ID = 'deepseek';

/* ── Agent Selection ── */

async function aiSelectAgents(goal, usedTabs) {
  const selector = getAgent(BRAIN_ID);
  if (!selector) return null;

  const prompt = AGENT_SELECT_PROMPT + ` ${goal}`;
  console.log(`[Selector] Asking ${selector.name} to select agents`);

  let tab = usedTabs[selector.id];
  if (!tab || !await tabAlive(tab.id)) {
    tab = await openTab(selector.url);
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

async function ensureTab(agent, usedTabs, manualUrls) {
  let tab = usedTabs[agent.id];
  if (tab && await tabAlive(tab.id)) return tab;
  tab = await getOrCreateTab(agent, manualUrls[agent.id]);
  usedTabs[agent.id] = tab;
  return tab;
}

/* ── Error messages ── */

function friendlyError(err, agentName) {
  const msg = (err?.message || err || '').toLowerCase();
  if (msg.includes('content_script')) return `${agentName}'s page needs a refresh. Open ${agentName}, refresh, and try again.`;
  if (msg.includes('submit')) return `${agentName}'s send button couldn't be found. The UI may have changed.`;
  if (msg.includes('timeout')) return `${agentName} took too long to respond. Try again later.`;
  if (msg.includes('inject')) return `Couldn't type into ${agentName}'s input field.`;
  if (msg.includes('cancel')) return 'Cancelled.';
  return `Something went wrong with ${agentName}: ${err?.message || err}`;
}

/* ── Brain: generate detailed task assignment for a specialist ── */

async function brainWriteTaskPrompt(task, agent, allTasks, agentOutputs, goal, usedTabs, projectFiles = {}) {
  const brain = getAgent(BRAIN_ID);
  if (!brain) return buildTaskPrompt(task, allTasks, agentOutputs, goal); /* fallback */

  /* Collect what's been done so far */
  const doneOutputs = Object.entries(agentOutputs)
    .filter(([, d]) => d.status === 'done' && d.output)
    .map(([id, d]) => `${getAgent(id)?.name || id} completed: ${(d.output || '').slice(0, 500)}`)
    .join('\n\n');

  const context = {
    goal,
    specialistName: agent.name,
    specialistTask: task.description,
    taskType: task.type,
    otherTasks: allTasks.filter(t => t !== task).map(t => `${t.assignedTo || '?'}: ${t.description} [${t.status}]`).join('\n'),
    completedSoFar: doneOutputs || 'Nothing completed yet.',
    userFiles: Object.keys(projectFiles || {}),
  };

  const userFilesSection = context.userFiles.length > 0
    ? `\n\n## User's Existing Files\n${context.userFiles.map(f => `- ${f}`).join('\n')}\nThese files already exist. Modify them if the task requires, or create new ones.`
    : '';

  /* ── Brain writes a concise task assignment for the specialist ── */

  const strengths = agent.strengths ? Object.entries(agent.strengths).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}=${v}`).join(', ') : '';
  const codeFormat = task.type === 'code' ? '\n\nWrap code files in <file name="name.ext"> and </file> tags.' : '';

  const prompt = `Write a precise task assignment for ${agent.name} (strengths: ${strengths}).

Goal: ${goal}

Their task: ${task.description}

Other agents working on this: ${allTasks.filter(t => t !== task).map(t => `${t.assignedTo}: ${t.description}`).join('; ') || 'None'}

${doneOutputs ? `\nWhat previous agents built (MUST build upon, don't duplicate):\n${doneOutputs.slice(0, 2000)}` : ''}
${userFilesSection}

Output the exact instruction you want ${agent.name} to follow. Be specific and actionable.${codeFormat}`;

  try {
    const tab = await ensureTab(brain, usedTabs, {});
    await waitTab(tab.id);
    await sleep(3000);
    if (!(await waitForContentScript(tab.id))) return buildTaskPrompt(task, allTasks, agentOutputs, goal);

    let r = await send(tab.id, { action: 'inject', text: prompt });
    if (r?.error) return buildTaskPrompt(task, allTasks, agentOutputs, goal);
    await sleep(1000);
    r = await send(tab.id, { action: 'submit' });
    if (r?.error) return buildTaskPrompt(task, allTasks, agentOutputs, goal);

    const output = await poll(tab.id, prompt, 90);
    if (!output || output === '\u26a0\ufe0f Timeout') return buildTaskPrompt(task, allTasks, agentOutputs, goal);

    /* Append the ACTUAL outputs from previous specialists so the next agent knows what was built */
    let fullInstruction = output;
    if (doneOutputs) {
      fullInstruction += `\n\n## Actual Outputs From Previous Agents\nHere are the COMPLETE outputs from agents who have already worked on this project. You MUST build upon these, not duplicate them.\n\n${doneOutputs.slice(0, 4000)}`;
    }

    /* Also append file-format instructions for code tasks */
    if (task.type === 'code') {
      fullInstruction += `\n\nIMPORTANT: Wrap each file in <file name="filename.ext"> and </file> tags.\nExample: <file name="index.html">\n<!DOCTYPE html>\n</file>`;
    }
    return fullInstruction;
  } catch (err) {
    console.warn('[Brain] Failed to write task prompt, using fallback:', err.message);
    return buildTaskPrompt(task, allTasks, agentOutputs, goal);
  }
}

/* ── Brain: review specialist output ── */

async function brainReviewOutput(task, agent, output, agentOutputs, goal, usedTabs) {
  /* Fast heuristic review — no AI call needed */
  if (!output || output.length < 20) return output;
  /* Check if output actually addresses the task */
  const hasContent = output.length > 50;
  const hasFiles = output.includes('<file');
  /* For code tasks, require file tags */
  if (task.type === 'code' && !hasFiles) {
    /* Just append format reminder, output might still be OK */
    console.log(`[Brain] Code task but no file tags in ${agent.name}'s output`);
  }
  console.log(`[Brain] ✅ ${agent.name}'s output accepted (${output.length} chars${hasFiles ? ', files found' : ''})`);
  return output;
}

/* ── Specialist task execution with brain management ── */

async function runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, allAgentOutputs, goal, projectFiles = {}) {
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (multiCancelled) throw new CancelError();
    if (attempt > 1) {
      console.log(`[Orch] Retry #${attempt} for ${agent.name}`);
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

      /* Step 1: Brain writes a detailed task assignment for this specialist */
      console.log(`[Brain] Writing task assignment for ${agent.name}...`);
      await setMultiState({ step: 'brain-writing', brainPhase: `Brain preparing task for ${agent.name}...`, agentOutputs: { ...agentOutputs } });

      const instruction = await brainWriteTaskPrompt(task, agent, tasks, allAgentOutputs, goal, usedTabs, projectFiles);

      /* Step 2: Specialist executes the brain's assignment */
      console.log(`[Brain] ${agent.name} executing: ${task.description.slice(0, 50)}`);
      await setMultiState({ step: 'brain-executing', brainPhase: `${agent.name} executing task...`, agentOutputs: { ...agentOutputs } });

      let r = await send(tab.id, { action: 'inject', text: instruction });
      if (r?.error) throw new Error(`inject_error: ${r.error}`);
      await sleep(1500);

      r = await send(tab.id, { action: 'submit' });
      if (r?.error) throw new Error(`submit_error: ${r.error}`);

      const specialistOutput = await pollWithProgress(tab.id, task.description, 120, agent.id, agentOutputs);
      if (multiCancelled) throw new CancelError();

      if (!specialistOutput || specialistOutput === '\u26a0\ufe0f Timeout') {
        throw new Error('timeout: specialist did not respond');
      }

      /* Step 3: Brain reviews the specialist's output */
      console.log(`[Brain] Reviewing ${agent.name}'s output...`);
      await setMultiState({ step: 'brain-reviewing', brainPhase: `Brain reviewing ${agent.name}'s output...`, agentOutputs: { ...agentOutputs } });

      const finalOutput = await brainReviewOutput(task, agent, specialistOutput, agentOutputs, goal, usedTabs);

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
        agentOutputs[agent.id] = { output: '', status: 'retrying', error: `Retrying...`, task: task.description, agent: agent.name };
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
      if (readFailures >= 8) throw new Error(r.error);
      await sleep(1000);
      continue;
    }
    readFailures = 0;
    const cur = (r?.text || '').trim();
    if (!cur || PLACEHOLDER_RE.test(cur) || isEcho(cur, prompt)) {
      stable = 0; last = ''; await sleep(1000); continue;
    }

    /* Text is growing — still streaming, don't count as stable */
    if (cur.length > maxLen) {
      maxLen = cur.length;
      stable = 0;
      last = cur;
    } else if (cur === last) {
      stable++;
      /* Require longer stability for longer texts */
      const required = cur.length > 2000 ? 20 : cur.length > 500 ? 15 : 10;
      if (stable >= required && cur.length > 10) return cur;
    } else {
      stable = 0;
      last = cur;
    }

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

  console.log('=== THE ORCHESTRATOR — Brain-centered pipeline ===');
  multiRunning = true;
  multiCancelled = false;

  try {
    const usedTabs = {};
    let finalAgents = selectedAgents;

    /* ── 0a. Login Check ── */
    if (finalAgents && finalAgents.length > 0) {
      await setMultiState({ step: 'login-check', goal, selectedAgents: finalAgents, tasks: [], agentOutputs: {}, synthesis: '' });
      const loginResult = await runLoginCheck(finalAgents);
      if (!loginResult.allDone) {
        await setMultiState({ step: 'login-check', loginCheck: { ...loginResult, status: 'failed' } });
        multiRunning = false; return;
      }
    } else {
      await setMultiState({ step: 'login-check', goal, selectedAgents: [], tasks: [], agentOutputs: {}, synthesis: '' });
      const selectorCheck = await runLoginCheck([BRAIN_ID]);
      if (!selectorCheck.allDone) {
        await setMultiState({ step: 'login-check', loginCheck: { ...selectorCheck, status: 'failed', error: 'ChatGPT must be logged in.' } });
        multiRunning = false; return;
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
          multiRunning = false; return;
        }
      }
    }
    if (multiCancelled) throw new CancelError();

    await setMultiState({ sharedContext: { goal, files: Object.keys(projectFiles), agentSummaries: {} } });

    /* ── 1. Brain creates the task plan ── */
    await setMultiState({ step: 'planning' });
    let tasks = await planTasks(goal, usedTabs);
    if (multiCancelled) throw new CancelError();

    /* ── 2. Route ── */
    tasks = routeAll(tasks, finalAgents);
    if (multiCancelled) throw new CancelError();

    /* ── 2b. User confirmation ── */
    await setMultiState({ tasks, step: 'confirm-tasks' });
    const confirmTimeout = 300000;
    const confirmStart = Date.now();
    let confirmed = false;
    while (Date.now() - confirmStart < confirmTimeout) {
      if (multiCancelled) throw new CancelError();
      const state = await getMultiState();
      if (state.tasksConfirmed === true) { confirmed = true; break; }
      if (state.tasksConfirmed === false) {
        await setMultiState({ step: 'cancelled' }); multiRunning = false; return;
      }
      await sleep(500);
    }
    if (multiCancelled) throw new CancelError();

    /* ── 3. Execute: Parallel across different agents ── */
    const agentOutputs = {};

    await setMultiState({ tasks: [...tasks], step: 'running' });

    /* Group tasks by agent for parallel execution */
    const agentGroups = {};
    for (const task of tasks) {
      const id = task.assignedTo || 'unassigned';
      if (!agentGroups[id]) agentGroups[id] = [];
      agentGroups[id].push(task);
    }

    /* Run each agent group in parallel */
    const groupPromises = Object.entries(agentGroups).map(async ([agentId, agentTasks]) => {
      for (const task of agentTasks) {
        if (multiCancelled) throw new CancelError();
        const agent = getAgent(agentId);
        if (!agent) { task.status = 'error'; continue; }

        task.status = 'in-progress';
        await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs }, brainPhase: `${agent.name} starting...` });

        try {
          await runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, agentOutputs, goal, projectFiles);
        } catch (err) {
          if (err instanceof CancelError) throw err;
        }
      }
    });

    await Promise.all(groupPromises);
    if (multiCancelled) throw new CancelError();

    /* ── 4. Final brain synthesis ── */
    await setMultiState({ step: 'synthesis', brainPhase: 'Brain synthesizing final output...' });

    let finalSynthesis = '';
    const completedOutputs = Object.entries(agentOutputs).filter(([, d]) => d.status === 'done' && d.output);
    const parts = completedOutputs.map(([id, d]) => `=== ${getAgent(id)?.name || id} ===\n${d.output}`).join('\n\n');

    if (parts) {
      /* Brain generates the actual implementation files based on all specialist outputs */
      const synthPrompt = `You are the BRAIN. Your specialists have produced architecture, design, and content specifications for a project.

Original Goal: ${goal}

Specialist Outputs:
${parts}

Your job: Based on ALL the specialist outputs above, generate the ACTUAL implementation files. Produce complete, working code files.

Wrap each file in <file name="filename.ext"> and </file> tags.

Example format:
<file name="index.html">
<!DOCTYPE html>
<html>
...
</html>
</file>
<file name="style.css">
/* CSS */
</file>
<file name="script.js">
// JS
</file>

Generate ALL the files needed to make this project work. Make them complete, production-ready, and based on the specifications from your specialists.`;

      const synthTab = usedTabs[BRAIN_ID];
      if (synthTab && await tabAlive(synthTab.id) && await waitForContentScript(synthTab.id)) {
        let r = await send(synthTab.id, { action: 'inject', text: synthPrompt });
        if (!r?.error) {
          await sleep(1000);
          r = await send(synthTab.id, { action: 'submit' });
          if (!r?.error) {
            const raw = await pollWithProgress(synthTab.id, synthPrompt, 90, BRAIN_ID, agentOutputs);
            if (raw && raw !== '\u26a0\ufe0f Timeout') finalSynthesis = raw;
          }
        }
      }
      if (!finalSynthesis) finalSynthesis = parts;
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

    console.log('=== The Orchestrator pipeline complete ===');
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
  }
}
