/* Task Planner
 * Breaks user goal into structured subtasks using ChatGPT.
 * Each subtask includes a clear role and collaborator context.
 */

function computeGoalComplexity(goal) {
  if (!goal) return 3;
  const techKeywords = ['build', 'app', 'website', 'api', 'database', 'auth', 'login', 'dashboard', 'portfolio', 'fullstack', 'frontend', 'backend', 'deploy', 'pipeline', 'test', 'docker', 'server', 'client', 'responsive', 'animation', 'chart', 'graph', 'real-time', 'websocket', 'search', 'filter', 'sort', 'upload', 'download', 'payment', 'stripe', 'integration'];
  const keywordDensity = techKeywords.filter(k => goal.toLowerCase().includes(k)).length;
  let score = 3;
  if (goal.length > 300) score += 2;
  else if (goal.length > 150) score += 1;
  if (keywordDensity > 5) score += 2;
  else if (keywordDensity > 3) score += 1;
  return Math.min(8, Math.max(2, score));
}

const TASK_TEMPLATE_KEY = 'cachedTaskPlans';

async function getCachedTaskPlan(goal) {
  try {
    const { [TASK_TEMPLATE_KEY]: plans } = await chrome.storage.local.get(TASK_TEMPLATE_KEY);
    if (!plans || !Array.isArray(plans)) return null;
    const goalLower = goal.toLowerCase();
    for (const plan of plans) {
      if (goalLower.includes(plan.keyword)) return JSON.parse(JSON.stringify(plan.tasks));
    }
  } catch {}
  return null;
}

async function cacheTaskPlan(goal, tasks) {
  try {
    const { [TASK_TEMPLATE_KEY]: plans } = await chrome.storage.local.get(TASK_TEMPLATE_KEY);
    const all = Array.isArray(plans) ? plans : [];
    const keyword = goal.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    all.unshift({ keyword, tasks, ts: Date.now() });
    if (all.length > 5) all.length = 5;
    await chrome.storage.local.set({ [TASK_TEMPLATE_KEY]: all });
  } catch {}
}

async function planTasks(goal, usedTabs = {}, maxAgents = 4) {
  console.log('[Planner] Planning tasks for:', goal.slice(0, 120));

  const plannerId = 'deepseek';
  const planner = getAgent(plannerId);
  if (!planner) throw new Error('No agent available for planning');

  const agentList = allActiveAgents().map(a => `- ${a.id}: ${a.name} (strengths: ${Object.entries(a.strengths).map(([k, v]) => `${k}=${v}`).join(', ')})`).join('\n');

  const goalComplexity = computeGoalComplexity(goal);
  const maxTasks = maxAgents * 2;
  const targetTaskCount = Math.min(maxTasks, Math.max(2, goalComplexity));
  const prompt = `Plan ${targetTaskCount} specific subtasks for this goal. Each subtask must produce a concrete deliverable.

For each subtask:
- "description": what to build/create (1-2 sentences with specific output)
- "type": one of [code, creative, research, analysis, writing, design, planning, technical]
  IMPORTANT: type MUST be one of these exact values. Use "design" for UX/visual design, NOT "ui".

Rules:
- Each subtask must produce something TANGIBLE (code, content, design spec, research findings)
- Use DIFFERENT types across subtasks
- Later subtasks build on earlier ones
- Output ONLY a valid JSON array — NO markdown, NO explanation

Available agents:
${agentList}

Goal: ${goal}

Output format: [{"description": "Build X that does Y...", "type": "code"}, ...]`;

  let tab = usedTabs[planner.id];
  if (!tab || !await tabAlive(tab.id)) {
    tab = await openHiddenTab(planner.url);
    usedTabs[planner.id] = tab;
    await waitTab(tab.id);
    await sleep(4000);
  }

  if (!(await waitForContentScript(tab.id))) {
    console.warn(`[Planner] Content script not detected on existing ${planner.name} tab, opening fresh tab`);
    try { await chrome.tabs.remove(tab.id); } catch {}
    tab = await openHiddenTab(planner.url);
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

  let tasks = parsePlannerTasks(raw);

  /* Retry once with a fresh tab if parsing failed */
  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.log('[Planner] First parse failed, retrying with fresh tab');
    try { if (tab?.id) await chrome.tabs.remove(tab.id); } catch {}
    delete usedTabs[planner.id];
    tab = await openHiddenTab(planner.url);
    usedTabs[planner.id] = tab;
    await waitTab(tab.id);
    await sleep(4000);
    if (await waitForContentScript(tab.id)) {
      let r = await send(tab.id, { action: 'inject', text: prompt });
      if (!r?.error) {
        await sleep(1000);
        r = await send(tab.id, { action: 'submit' });
        if (!r?.error) {
          const raw2 = await poll(tab.id, prompt, 120);
          tasks = parsePlannerTasks(raw2);
        }
      }
    }
  }

  /* If JSON parsing failed, try to fix common issues */
  if (!Array.isArray(tasks) || tasks.length === 0) {
    try {
      /* Attempt: remove trailing commas, fix single quotes */
      let fixed = String(raw || '')
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

  /* Fallback to cached templates for common goals */
  if (!Array.isArray(tasks) || tasks.length === 0) {
    const cached = await getCachedTaskPlan(goal);
    if (cached) {
      console.log('[Planner] Using cached task plan');
      tasks = cached;
    }
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    tasks = [
      { description: `Plan and architect the overall structure: ${goal}`, type: 'analysis' },
      { description: `Build the core implementation: ${goal}`, type: 'code' },
      { description: `Design the user experience and visual style: ${goal}`, type: 'design' },
      { description: `Review, test, and polish the final output: ${goal}`, type: 'technical' },
    ];
  }

  tasks = normalizePlannerTasks(tasks, goal);
  if (tasks.length > maxTasks) {
    console.log(`[Planner] Capping ${tasks.length} tasks to max ${maxTasks}`);
    tasks = tasks.slice(0, maxTasks);
  }
  console.log('[Planner] Generated', tasks.length, 'tasks');
  await cacheTaskPlan(goal, tasks);
  return tasks;
}

function parsePlannerTasks(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const candidates = [
    text,
    text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim(),
    (text.match(/\[[\s\S]*\]/) || [])[0],
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

function normalizePlannerTasks(tasks, goal) {
  const allowed = new Set(['code', 'creative', 'research', 'analysis', 'writing', 'design', 'planning', 'technical']);
  const aliases = {
    ui: 'design',
    ux: 'design',
    frontend: 'code',
    backend: 'code',
    test: 'technical',
    testing: 'technical',
    docs: 'writing',
    documentation: 'writing',
    architecture: 'planning',
  };

  const cleaned = tasks
    .map((task, index) => {
      const type = aliases[String(task?.type || '').toLowerCase()] || String(task?.type || '').toLowerCase();
      const description = String(task?.description || task?.task || task?.title || '').trim();
      return {
        description: description || `Complete step ${index + 1} for: ${goal}`,
        type: allowed.has(type) ? type : (index === 0 ? 'analysis' : 'technical'),
        status: 'pending',
      };
    })
    .filter(task => task.description.length > 0)
    .slice(0, 5);

  if (!cleaned.some(task => task.type === 'code') && /build|app|site|code|implement|create/i.test(goal)) {
    cleaned.push({ description: `Build the main implementation for: ${goal}`, type: 'code', status: 'pending' });
  }

  return cleaned.slice(0, 5);
}
