/* task-planner.js — breaks goal into structured subtasks (extension port) */

import { allActiveAgents } from './agents.js';

export function computeGoalComplexity(goal) {
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

export async function getCachedTaskPlan(store, goal) {
  try {
    const plans = await store.get(TASK_TEMPLATE_KEY, null);
    if (!plans || !Array.isArray(plans)) return null;
    const goalLower = goal.toLowerCase();
    for (const plan of plans) {
      if (goalLower.includes(plan.keyword)) return JSON.parse(JSON.stringify(plan.tasks));
    }
  } catch {}
  return null;
}

export async function cacheTaskPlan(store, goal, tasks) {
  try {
    const plans = await store.get(TASK_TEMPLATE_KEY, null);
    const all = Array.isArray(plans) ? plans : [];
    const keyword = goal.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    all.unshift({ keyword, tasks, ts: Date.now() });
    if (all.length > 5) all.length = 5;
    await store.set(TASK_TEMPLATE_KEY, all);
  } catch {}
}

export async function planTasks({ goal, maxAgents = 4, ask, store, onEvent = () => {} }) {
  console.log('[Planner] Planning tasks for:', String(goal || '').slice(0, 120));
  if (typeof ask !== 'function') throw new Error('[Planner] ask function required');

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

  onEvent({ type: 'plan-start', goal: String(goal || '').slice(0, 120) });

  let raw = '';
  try {
    raw = await ask(prompt, { json: true });
  } catch (err) {
    console.warn('[Planner] ask failed:', err?.message || err);
  }
  let tasks = parsePlannerTasks(raw);

  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.log('[Planner] First parse failed, retrying');
    onEvent({ type: 'plan-retry' });
    try {
      raw = await ask(prompt, { json: true });
      tasks = parsePlannerTasks(raw);
    } catch (err) {
      console.warn('[Planner] retry ask failed:', err?.message || err);
    }
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    try {
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

  if (!Array.isArray(tasks) || tasks.length === 0) {
    const cached = await getCachedTaskPlan(store, goal);
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
  await cacheTaskPlan(store, goal, tasks);
  onEvent({ type: 'plan-done', count: tasks.length });
  return tasks;
}

export function parsePlannerTasks(raw) {
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

export function normalizePlannerTasks(tasks, goal) {
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