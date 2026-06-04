/* prompts.js — Prompt builders for brain and specialists */

function buildTaskPrompt(task, allTasks, allOutputs, goal) {
  const role = task.assignedTo ? getAgent(task.assignedTo)?.name || task.assignedTo : 'agent';
  const otherTasks = allTasks.filter(t => t !== task);
  const doneTasks = otherTasks.filter(t => t.status === 'done');
  const pendingTasks = otherTasks.filter(t => t.status !== 'done');

  const existingFiles = [];
  if (allOutputs) {
    for (const [, data] of Object.entries(allOutputs)) {
      if (data.output) {
        const matches = data.output.match(/<file\s+name=["']([^"']+)["']>/gi);
        if (matches) matches.forEach(m => existingFiles.push(m.replace(/<file\s+name=["']|["']>/g, '')));
      }
    }
  }

  let parts = [];
  parts.push(`## The Goal\n${goal}\n`);
  parts.push(`## Your Role\nYou are acting as "${role}". Your specific task: ${task.description}\n`);
  if (doneTasks.length > 0) {
    parts.push(`## What Other Agents Have Already Completed\n${doneTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`);
  }
  if (pendingTasks.length > 0) {
    parts.push(`## What Other Agents Are Working On\n${pendingTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`);
  }
  if (existingFiles.length > 0) {
    parts.push(`## Already Created Files\n${[...new Set(existingFiles)].join(', ')}\nOnly create NEW files not in this list.\n`);
  }
  if (task.type === 'code') {
    parts.push(`## Output Format\nWrap files in <file name="filename.ext"> and </file> tags.\nExample:\n<file name="index.html">\n<!DOCTYPE html>\n<html>\n</file>`);
  }
  return parts.join('\n---\n');
}

async function brainWriteTaskPrompt(task, agent, allTasks, agentOutputs, goal, usedTabs, projectFiles = {}) {
  const brain = getAgent(BRAIN_ID);
  if (!brain) return buildTaskPrompt(task, allTasks, agentOutputs, goal);

  const doneOutputs = Object.entries(agentOutputs)
    .filter(([, d]) => d.status === 'done' && d.output)
    .map(([id, d]) => `${getAgent(id)?.name || id} completed: ${(d.output || '').slice(0, 500)}`)
    .join('\n\n');

  const userFiles = Object.keys(projectFiles || {});
  const fileSection = userFiles.length > 0 ? `\nExisting files:\n${userFiles.map(f => `- ${f}`).join('\n')}` : '';
  const strengths = agent.strengths ? Object.entries(agent.strengths).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}=${v}`).join(', ') : '';
  const codeFormat = task.type === 'code' ? '\nWrap code in <file name="name.ext"> and </file> tags.' : '';

  const prompt = `Write a task assignment for ${agent.name} (strengths: ${strengths}).

Goal: ${goal}
Task: ${task.description}
Other tasks: ${allTasks.filter(t => t !== task).map(t => `${t.assignedTo}: ${t.description}`).join('; ') || 'None'}
${doneOutputs ? `\nPrevious output (build upon):\n${doneOutputs.slice(0, 2000)}` : ''}${fileSection}

Output the exact instruction for ${agent.name}. Be specific.${codeFormat}`;

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

    let fullInstruction = output;
    if (doneOutputs) {
      fullInstruction += `\n\n## Previous output (build upon):\n${doneOutputs.slice(0, 3000)}`;
    }
    if (task.type === 'code') {
      fullInstruction += `\n\nWrap each file in <file name="filename.ext"> and </file> tags.`;
    }
    return fullInstruction;
  } catch (err) {
    console.warn('[Brain] Failed to write task prompt, using fallback:', err.message);
    return buildTaskPrompt(task, allTasks, agentOutputs, goal);
  }
}

async function brainReviewOutput(task, agent, output) {
  if (!output || output.length < 20) return output;
  const hasFiles = output.includes('<file name=');
  if (task.type === 'code' && !hasFiles) {
    console.log(`[Brain] Code task without file tags in ${agent.name}'s output`);
  }
  return output;
}
