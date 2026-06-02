/* Orchestrator — runMulti: ai-select → plan → route → execute → feedback → synthesize */

const AGENT_SELECT_PROMPT = `You are an agent selection system for a multi-AI pipeline. Given a user goal, select the best combination of AI agents from this list:

- deepseek: Best at code generation, logical reasoning, technical tasks, debugging
- chatgpt: Best at creative writing, content creation, instruction following, explanations, UI/UX
- gemini: Best at analysis, structured thinking, multimodal understanding, research synthesis
- perplexity: Best at web research, fact-checking, finding current information with citations
- huggingface: Best at specialized NLP, code generation, translation, summarization

Return ONLY valid JSON with no markdown:
{"selected":["agent1","agent2",...],"reasoning":"one sentence why each was chosen"}

Select 2-4 agents. User goal:`;

async function aiSelectAgents(goal, usedTabs) {
  const selectorId = 'chatgpt';
  const selector = getAgent(selectorId);
  if (!selector) return null;

  const prompt = AGENT_SELECT_PROMPT + ` ${goal}`;

  console.log(`[Selector] Asking ${selector.name} to select agents for:`, goal.slice(0, 60));

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
        console.log(`[Selector] Selected: ${valid.join(', ')} \u2014 ${parsed.reasoning || ''}`);
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

async function ensureTab(agent, usedTabs, manualUrls) {
  let tab = usedTabs[agent.id];
  if (tab && await tabAlive(tab.id)) {
    return tab;
  }
  tab = await getOrCreateTab(agent, manualUrls[agent.id]);
  usedTabs[agent.id] = tab;
  return tab;
}

async function runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs, allAgentOutputs) {
  const tab = await ensureTab(agent, usedTabs, manualUrls);
  await waitTab(tab.id);
  await sleep(4000);

  if (!(await waitForContentScript(tab.id))) {
    throw new Error(`Content script not detected on ${agent.name} (${agent.url}). Ensure the extension is loaded at chrome://extensions, open ${agent.url} manually, and refresh the tab.`);
  }

  let instruction = task.description;
  if (task.type === 'code') {
    const existingFiles = [];
    if (allAgentOutputs) {
      for (const [, data] of Object.entries(allAgentOutputs)) {
        if (data.output) {
          const matches = data.output.match(/<file\s+name=["']([^"']+)["']>/gi);
          if (matches) matches.forEach(m => existingFiles.push(m.replace(/<file\s+name=["']|["']>/g, '')));
        }
      }
    }
    const context = existingFiles.length ? `\nAlready created files: ${[...new Set(existingFiles)].join(', ')}. Only create NEW files not in this list.` : '';
    instruction += `${context}\n\nIMPORTANT: Split your code into separate files. Wrap each file in <file name="filename.ext"> and </file> tags. Example:
<file name="index.html">
<!DOCTYPE html>
<html>
</file>
<file name="style.css">
/* CSS */
</file>
<file name="script.js">
// JS
</file>`;
  }
  let r = await send(tab.id, { action: 'inject', text: instruction });
  if (r?.error) throw new Error(`${agent.name} inject: ${r.error}`);
  await sleep(1000);

  r = await send(tab.id, { action: 'submit' });
  if (r?.error) throw new Error(`${agent.name} submit: ${r.error}`);

  const output = await poll(tab.id, task.description, 120);
  if (multiCancelled) throw new CancelError();

  agentOutputs[agent.id] = { output, status: 'done', task: task.description };
  task.status = 'done';
  await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });

  await updateAgentConv(agent.id, tab.id);
}

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

    const critique = await poll(tab.id, '', 120);
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

      const improved = await poll(improveTab.id, '', 120);
      if (!improved || improved === '\u26a0\ufe0f Timeout') continue;

      await updateAgentConv(improveId, improveTab.id);
      console.log(`[Feedback] ${critic.name} critiqued, ${improve.name} improved ${targetId}`);
      return { ...targetData, output: improved, feedback: critique };
    }
  }
  return targetData;
}

async function runMulti(goal, manualUrls = {}, selectedAgents = null, chatId = null) {
  if (multiRunning) {
    await setMultiState({ step: 'error', error: 'Multi-agent pipeline already running' });
    return;
  }

  console.log('=== Multi-agent pipeline starting ===');
  multiRunning = true;
  multiCancelled = false;

  try {
    const usedTabs = {};

    /* ── 0. AI Agent Selection ── */
    await setMultiState({ step: 'agent-selection', goal, selectedAgents: [], agentReasoning: '', tasks: [], agentOutputs: {}, synthesis: '' });

    let finalAgents = selectedAgents;
    if (!finalAgents || finalAgents.length === 0) {
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
    }
    if (multiCancelled) throw new CancelError();

    /* ── 0b. Login Check for selected agents ── */
    if (finalAgents && finalAgents.length > 0) {
      const loginResult = await runLoginCheck(finalAgents);
      if (!loginResult.allDone) {
        console.warn('[Orch] Login check failed — aborting');
        await setMultiState({ step: 'login-check', loginCheck: { ...loginResult, status: 'failed' } });
        multiRunning = false;
        return;
      }
    }
    if (multiCancelled) throw new CancelError();

    /* ── 1. Plan ── */
    await setMultiState({ step: 'planning', tasks: [], agentOutputs: {}, synthesis: '' });
    let tasks = await planTasks(goal, usedTabs);
    if (multiCancelled) throw new CancelError();

    /* ── 2. Route (only to selected agents) ── */
    tasks = routeAll(tasks, finalAgents);
    await setMultiState({ tasks, step: 'running' });
    if (multiCancelled) throw new CancelError();

    /* ── 3. Execute (sequential, one tab per agent) ── */
    const agentOutputs = {};

    for (const task of tasks) {
      if (multiCancelled) throw new CancelError();

      const agent = getAgent(task.assignedTo);
      if (!agent) { task.status = 'error'; continue; }

      task.status = 'in-progress';
      await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });

      console.log(`[Orch] Running task #${tasks.indexOf(task) + 1} on ${agent.name}`);

      try {
        await runTaskOnAgent(task, agent, usedTabs, manualUrls, tasks, agentOutputs);
      } catch (err) {
        if (err instanceof CancelError) throw err;
        console.error(`[Orch] Task failed on ${agent.name}:`, err);
        agentOutputs[agent.id] = { output: '', status: 'error', error: err.message, task: task.description };
        task.status = 'error';
        await setMultiState({ tasks: [...tasks], agentOutputs: { ...agentOutputs } });
      }
    }

    if (multiCancelled) throw new CancelError();

    /* ── 4. Cross-model Feedback (skip if too few outputs) ── */
    const completed = Object.entries(agentOutputs).filter(([, d]) => d.status === 'done');
    if (completed.length >= 2) {
      const loopCount = 2;
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
            console.error(`[Feedback] loop ${i} failed:`, err);
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

      /* Try each potential synth agent in order until one works (reuse existing tabs) */
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

          const raw = await poll(synthTab.id, synthPrompt, 120);
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

    /* Save conversation URLs + results to chat record */
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
    await setMultiState({ step: 'error', error: err.message });
  } finally {
    multiRunning = false;
  }
}
