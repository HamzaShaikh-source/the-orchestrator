/* Task Planner
 * Breaks user goal into structured subtasks using ChatGPT.
 * Each subtask includes a clear role and collaborator context.
 */

async function planTasks(goal, usedTabs = {}) {
  console.log('[Planner] Planning tasks for:', goal.slice(0, 120));

  const plannerId = 'chatgpt';
  const planner = getAgent(plannerId);
  if (!planner) throw new Error('No agent available for planning');

  const agentList = allActiveAgents().map(a => `- ${a.id}: ${a.name} (strengths: ${Object.entries(a.strengths).map(([k, v]) => `${k}=${v}`).join(', ')})`).join('\n');

  const prompt = `You are a task planner for a multi-agent AI team. Break down the following goal into 3-6 specific subtasks.

For each subtask, output a JSON object with:
- "description": what this subtask achieves (1-2 clear sentences). Include enough context so the agent understands how it fits into the bigger picture.
- "type": one of [code, creative, research, analysis, writing, technical, design]

RULES:
1. Use DIFFERENT types for each subtask (vary them)
2. Each subtask should be self-contained — the agent working on it should understand the full goal
3. The first subtask should set the foundation, later ones build on previous work
4. Output ONLY a valid JSON array, no markdown, no explanation

Available agents:
${agentList}

Goal: ${goal}

Output: [{ "description": "...", "type": "..." }]`;

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
