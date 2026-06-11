/* task-router.js v2.1 — Failure tracking, load balancing, fallback routing */

const RELIABILITY_KEY = 'agentReliability';

/* Sync in-memory cache, loaded once from storage */
let _reliability = {};

async function initReliability() {
  try {
    const { [RELIABILITY_KEY]: r } = await chrome.storage.local.get(RELIABILITY_KEY);
    _reliability = r || {};
  } catch { _reliability = {}; }
}

async function recordAgentResult(agentId, success) {
  if (!_reliability[agentId]) _reliability[agentId] = { total: 0, success: 0 };
  _reliability[agentId].total++;
  if (success) _reliability[agentId].success++;
  try { await chrome.storage.local.set({ [RELIABILITY_KEY]: _reliability }); } catch {}
}

function getAdjustedStrength(baseScore, agentId) {
  const r = _reliability[agentId];
  if (!r || r.total < 3) return baseScore;
  const rate = r.success / r.total;
  return baseScore * (0.3 + 0.7 * rate);
}

function routeAll(tasks, allowedAgents = null) {
  const pool = allowedAgents ? allowedAgents.map(id => getAgent(id)).filter(Boolean) : allActiveAgents();
  if (!pool.length) return tasks.map(t => ({ ...t, assignedTo: 'chatgpt', status: 'pending' }));

  /* Normalize unknown types: if a task type has no match, map it to closest known type */
  const TYPE_ALIASES = { 'ui': 'design', 'ux': 'design', 'frontend': 'code', 'backend': 'code', 'testing': 'technical', 'docs': 'writing' };

  const assigned = tasks.map(t => {
    const normalizedType = TYPE_ALIASES[t.type] || t.type;
    let best = null, bestScore = -1;
    for (const a of pool) {
      const baseScore = a.strengths[normalizedType] || a.strengths.code || 1;
      const adjusted = getAdjustedStrength(baseScore, a.id);
      if (adjusted > bestScore) { bestScore = adjusted; best = a.id; }
    }
    if (!best) best = pool[0].id;
    return { ...t, assignedTo: best, status: 'pending' };
  });

  /* Load balancing: every agent gets at least one task */
  const counts = {};
  assigned.forEach(t => { counts[t.assignedTo] = (counts[t.assignedTo] || 0) + 1; });
  const idleAgents = pool.filter(a => !counts[a.id]);

  for (const agent of idleAgents) {
    const busiest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (busiest && busiest[1] > 1) {
      const taskToReassign = assigned.find(t => t.assignedTo === busiest[0]);
      if (taskToReassign) {
        taskToReassign.assignedTo = agent.id;
        counts[busiest[0]]--;
        counts[agent.id] = 1;
      }
    }
  }

  return assigned;
}
