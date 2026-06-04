/* Task Planner
 * Breaks user goal into structured subtasks using ChatGPT.
 * Each subtask includes a clear role and collaborator context.
 */

async function planTasks(goal, usedTabs = {}) {
  console.log('[Planner] Planning tasks for:', goal.slice(0, 120));

  const plannerId = 'deepseek';
  const planner = getAgent(plannerId);
  if (!planner) throw new Error('No agent available for planning');

  const agentList = allActiveAgents().map(a => `- ${a.id}: ${a.name} (strengths: ${Object.entries(a.strengths).map(([k, v]) => `${k}=${v}`).join(', ')})`).join('\n');

  const prompt = `Plan 3-5 specific subtasks for this goal. Each subtask must produce a concrete deliverable.

For each subtask:
- "description": what to build/create (1-2 sentences with specific output)
- "type": one of [code, creative, research, analysis, writing, technical, design]

Rules:
- Each subtask must produce something TANGIBLE (code, content, design spec, research findings)
- Use DIFFERENT types across subtasks
- Later subtasks build on earlier ones
- Output ONLY a valid JSON array

Available agents:
${agentList}

Goal: ${goal}

Output format: [{"description": "Build X that does Y...", "type": "code"}, ...]`;

  let tab = usedTabs[planner.id];
  if (!tab || !await tabAlive(tab.id)) {
    tab = await openTab(planner.url);
    usedTabs[planner.id] = tab;
    await waitTab(tab.id);
    await sleep(4000);
  }

  if (!(await waitForContentScript(tab.id))) {
    console.warn(`[Planner] Content script not detected on existing ${planner.name} tab, opening fresh tab`);
    try { await chrome.tabs.remove(tab.id); } catch {}
    tab = await openTab(planner.url);
    usedTabs[planner.id] = tab;
    await waitTab(tab.id);
    await sleep(4000);
    if (!(await waitForContentScript(tab.id))) {
      throw new Error(`Content script not detected on ${planner.name}. Open ${planner.url} manually and refresh.`);
    }
  }

  let r = await send(tab.id, { action: 'inject', text: prompt });
  if (r?.error) throw new Error(`${planner.name} inject: ${r.error}`);
  await sleep(1000);

  r = await send(tab.id, { action: 'submit' });
  if (r?.error) throw new Error(`${planner.name} submit: ${r.error}`);

  const raw = await poll(tab.id, prompt, 120);

  let tasks = [];
  try {
    tasks = JSON.parse(raw);
  } catch {
    /* Try to extract JSON array from markdown-wrapped response */
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try { tasks = JSON.parse(match[0]); } catch {}
    }
  }

  /* If JSON parsing failed, try to fix common issues */
  if (!Array.isArray(tasks) || tasks.length === 0) {
    try {
      /* Attempt: remove trailing commas, fix single quotes */
      let fixed = raw
        .replace(/,\s*\]/g, ']')
        .replace(/,\s*\}/g, '}')
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":');
      const match2 = fixed.match(/\[[\s\S]*\]/);
      if (match2) {
        try { tasks = JSON.parse(match2[0]); } catch {}
      }
    } catch {}
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    tasks = [
      { description: `Plan and architect the overall structure: ${goal}`, type: 'analysis' },
      { description: `Build the core implementation: ${goal}`, type: 'code' },
      { description: `Design the user experience and visual style: ${goal}`, type: 'design' },
      { description: `Review, test, and polish the final output: ${goal}`, type: 'technical' },
    ];
  }

  console.log('[Planner] Generated', tasks.length, 'tasks');
  return tasks;
}
