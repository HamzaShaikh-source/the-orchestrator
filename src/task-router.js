function routeAll(tasks, allowedAgents = null) {
  const pool = allowedAgents ? allowedAgents.map(id => getAgent(id)).filter(Boolean) : allActiveAgents();
  if (!pool.length) return tasks.map(t => ({ ...t, assignedTo: 'chatgpt', status: 'pending' }));

  const assigned = tasks.map(t => {
    let best = null, bestScore = -1;
    for (const a of pool) {
      const score = a.strengths[t.type] || 0;
      if (score > bestScore) { bestScore = score; best = a.id; }
    }
    if (!best) best = pool[0].id;
    return { ...t, assignedTo: best, status: 'pending' };
  });

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
