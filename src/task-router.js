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
  if (!_reliability[agentId]) _reliability[agentId] = { total: 0, success: 0, lastResults: [] };
  _reliability[agentId].total++;
  if (success) _reliability[agentId].success++;
  _reliability[agentId].lastResults.push({ success, ts: Date.now() });
  if (_reliability[agentId].lastResults.length > 50) {
    _reliability[agentId].lastResults = _reliability[agentId].lastResults.slice(-50);
  }
  try { await chrome.storage.local.set({ [RELIABILITY_KEY]: _reliability }); } catch {}
}

function getDecayedSuccess(agentId) {
  const r = _reliability[agentId];
  if (!r || !r.lastResults) return { success: 0, total: 0 };
  const cutoff = Date.now() - 86400000;
  let decayedSuccess = 0, decayedTotal = 0;
  for (const entry of r.lastResults) {
    const weight = entry.ts > cutoff ? 1 : 0.5;
    decayedTotal += weight;
    if (entry.success) decayedSuccess += weight;
  }
  return { success: decayedSuccess, total: decayedTotal };
}

function getAdjustedStrength(baseScore, agentId) {
  const raw = _reliability[agentId];
  if (!raw || raw.total < 3) return baseScore;
  const { success, total } = getDecayedSuccess(agentId);
  const effectiveRate = total > 0 ? success / total : (raw.success / raw.total);
  return baseScore * (0.3 + 0.7 * effectiveRate);
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
      const candidates = assigned.filter(t => t.assignedTo === busiest[0]);
      let bestTask = null, bestScore = -1;
      for (const t of candidates) {
        const normalizedType = t.type;
        const baseScore = agent.strengths[normalizedType] || agent.strengths.code || 1;
        const adjusted = getAdjustedStrength(baseScore, agent.id);
        if (adjusted > bestScore) { bestScore = adjusted; bestTask = t; }
      }
      if (bestTask) {
        bestTask.assignedTo = agent.id;
        counts[busiest[0]]--;
        counts[agent.id] = 1;
      }
    }
  }

  /* Task similarity: avoid same agent getting two tasks of same type if another agent also scores >= 7 */
  const typeCounts = {};
  for (const t of assigned) {
    if (!typeCounts[t.assignedTo]) typeCounts[t.assignedTo] = {};
    typeCounts[t.assignedTo][t.type] = (typeCounts[t.assignedTo][t.type] || 0) + 1;
  }
  for (const t of assigned) {
    const type = t.type;
    const agentId = t.assignedTo;
    if (typeCounts[agentId]?.[type] > 1) {
      for (const other of pool) {
        if (other.id === agentId) continue;
        const otherScore = other.strengths[type] || other.strengths.code || 1;
        if (otherScore >= 7 && typeCounts[other.id]?.[type] === undefined) {
          t.assignedTo = other.id;
          typeCounts[agentId][type]--;
          if (!typeCounts[other.id]) typeCounts[other.id] = {};
          typeCounts[other.id][type] = 1;
          break;
        }
      }
    }
  }

  return assigned;
}
