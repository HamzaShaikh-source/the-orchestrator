/* prompts.js — Prompt builders for brain and specialists */

function buildTaskPrompt(task, allTasks, allOutputs, goal) {
  const role = task.assignedTo ? getAgent(task.assignedTo)?.name || task.assignedTo : 'agent';
  const otherTasks = allTasks.filter(t => t !== task);
  const doneTasks = otherTasks.filter(t => t.status === 'done');
  const pendingTasks = otherTasks.filter(t => t.status !== 'done');
  const files = task.projectFiles || {};

  const existingFiles = [];
  if (allOutputs) {
    for (const [, data] of Object.entries(allOutputs)) {
      if (data.output) {
        const matches = data.output.match(/<file\s+name=["']([^"']+)["']>/gi);
        if (matches) matches.forEach(m => existingFiles.push(m.replace(/<file\s+name=["']|["']>/g, '')));
      }
    }
  }
  const fileContext = Object.entries(files).slice(0, 8).map(([name, content]) => {
    const text = String(content || '').slice(0, 4000);
    return `### ${name}\n${text}`;
  }).join('\n\n');

  let parts = [];
  parts.push(`## The Goal\n${goal}\n`);
  parts.push(`## Your Role\nYou are acting as "${role}". Your specific task: ${task.description}\n`);
  if (fileContext) {
    parts.push(`## User-Provided Project Files\nUse these files as source context. Preserve user intent and avoid discarding existing work.\n\n${fileContext}\n`);
  }
  if (doneTasks.length > 0) {
    parts.push(`## What Other Agents Have Already Completed\n${doneTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`);
  }
  let completedOutputList = Object.entries(allOutputs || {})
    .filter(([, d]) => d.status === 'done' && d.output);
  let completedOutputContext = '';
  if (completedOutputList.length > 0) {
    const estimatedBaseSize = goal.length + task.description.length + fileContext.length + 500;
    if (estimatedBaseSize > 15000) {
      completedOutputList = completedOutputList.slice(-2);
      completedOutputContext = completedOutputList
        .map(([, d]) => `### ${d.agent || d.agentId || 'Agent'}\n${String(d.output).slice(0, 2500)}`)
        .join('\n\n');
    } else if (estimatedBaseSize > 10000) {
      completedOutputContext = completedOutputList
        .map(([, d]) => `### ${d.agent || d.agentId || 'Agent'}\n${String(d.output).slice(0, 800)}${d.output.length > 800 ? '\n[summary of remaining content]' : ''}`)
        .join('\n\n');
    } else {
      completedOutputContext = completedOutputList
        .map(([, d]) => `### ${d.agent || d.agentId || 'Agent'}\n${String(d.output).slice(0, 2500)}`)
        .join('\n\n');
    }
  }
  if (completedOutputContext) {
    parts.push(`## Completed Agent Outputs To Build On\n${completedOutputContext}\n`);
  }
  if (pendingTasks.length > 0) {
    parts.push(`## What Other Agents Are Working On\n${pendingTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`);
  }
  if (existingFiles.length > 0) {
    parts.push(`## Already Created Files\n${[...new Set(existingFiles)].join(', ')}\nOnly create NEW files not in this list.\n`);
  }
  if (task.type === 'code') {
    parts.push(`## Output Format\nReturn complete, directly usable code. Wrap every generated or changed file in <file name="filename.ext"> and </file> tags.\nExample:\n<file name="index.html">\n<!DOCTYPE html>\n<html>\n</file>`);
  } else {
    parts.push(`## Output Quality\nBe specific, actionable, and concise. Include decisions, assumptions, and handoff notes that the next agent can use.`);
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

  const prompt = `You are the lead architect. You are writing the EXACT instruction that ${agent.name} (specialist in ${strengths}) will receive.

DO NOT write meta-commentary, framing, or explanations.
DO NOT say "Your task is to..." or "Here is an assignment..."
OUTPUT ONLY the raw instruction itself — the exact text ${agent.name} should follow.

Goal: ${goal}
Task: ${task.description}
${doneOutputs ? `\nContext from completed work:\n${doneOutputs.slice(0, 2000)}` : ''}${fileSection}

Write the precise instruction for ${agent.name}. Start directly with the work to be done.${codeFormat}`;

  try {
    const tab = await ensureTab(brain, usedTabs, {});
    await waitTab(tab.id);
    await sleep(3000);
    if (!(await waitForContentScript(tab.id))) return buildTaskPrompt(task, allTasks, agentOutputs, goal);

    /* Reset the brain tab before sending the write prompt.
     * This clears any previous planner response or old brain response
     * so getNewContent() doesn't return stale text. */
    await send(tab.id, { action: 'reset' });
    await sleep(300);

    let promptToSend = prompt;
    if (promptToSend.length > 4000) {
      promptToSend = promptToSend.slice(0, 4000) + '\n\n[instruction truncated due to length]';
    }
    let r = await send(tab.id, { action: 'inject', text: promptToSend });
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
