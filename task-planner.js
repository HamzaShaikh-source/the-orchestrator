/* Task Planner
 * Breaks user goal into structured subtasks using the best analysis agent.
 */

async function planTasks(goal, usedTabs = {}) {
  console.log('[Planner] Planning tasks for:', goal.slice(0, 80));

  const plannerId = 'chatgpt';
  const planner = getAgent(plannerId);
  if (!planner) throw new Error('No agent available for planning');

  const prompt = `You are a task planner. Break down the following goal into 3-6 specific, actionable subtasks. Each subtask must focus on a different aspect and use a DIFFERENT type from the others.

For each subtask output:
- "description": what to do (1-2 sentences)
- "type": one of [code, creative, research, analysis, writing, technical, design]

IMPORTANT: Vary the types across subtasks. For example: if one task is "code", make another "writing", another "design", etc. Do NOT use the same type for all subtasks.

Output ONLY a JSON array with no markdown or explanation:
[{"description":"...","type":"..."}]

Goal: ${goal}`;

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

  const raw = await poll(tab.id, prompt, 90);

  let tasks = [];
  try {
    tasks = JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try { tasks = JSON.parse(match[0]); } catch {}
    }
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    tasks = [
      { description: `Research and analyze: ${goal.slice(0, 100)}`, type: 'research' },
      { description: `Design solution for: ${goal.slice(0, 100)}`, type: 'analysis' },
      { description: `Implement core of: ${goal.slice(0, 100)}`, type: 'code' },
      { description: `Polish and refine: ${goal.slice(0, 100)}`, type: 'creative' },
    ];
  }

  console.log('[Planner] Generated', tasks.length, 'tasks');
  return tasks;
}
