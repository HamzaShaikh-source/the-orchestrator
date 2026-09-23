/* context.js — long-context budgeting (Web2API hard limit) */

import { getAgent } from './agents.js';

export const TURN_BUDGET = 7500;

const SEP = '\n---\n';
const FILE_BLOCK_RE = /<file\b[^>]*>[\s\S]*?<\/file>/gi;

export function compactOutput(text, maxChars) {
  const s = String(text ?? '');
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (s.length <= maxChars) return s;

  const fileBlocks = [];
  let prose = '';
  let last = 0;
  FILE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = FILE_BLOCK_RE.exec(s)) !== null) {
    prose += s.slice(last, m.index);
    fileBlocks.push(m[0]);
    last = m.index + m[0].length;
  }
  prose += s.slice(last);

  const marker = '[...]';

  if (!fileBlocks.length) {
    const budget = maxChars - marker.length;
    if (budget <= 0) return s.slice(0, maxChars);
    const headLen = Math.floor(budget * 0.6);
    const tailLen = budget - headLen;
    const head = prose.slice(0, headLen);
    const tail = tailLen > 0 ? prose.slice(prose.length - tailLen) : '';
    return head + marker + tail;
  }

  const filesPart = fileBlocks.join('\n');
  if (!prose) return filesPart;

  const sep = '\n';
  const budget = maxChars - filesPart.length - sep.length - marker.length;
  /* File blocks alone exceeding maxChars: ALL file blocks win over budget. */
  if (budget < 0) return filesPart;
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  const head = prose.slice(0, headLen);
  const tail = tailLen > 0 ? prose.slice(prose.length - tailLen) : '';
  return filesPart + sep + head + marker + tail;
}

export function buildTaskContext({ task, goal, tasks = [], allOutputs = {}, projectFiles = {}, budget = TURN_BUDGET }) {
  const role = task.assignedTo ? (getAgent(task.assignedTo)?.name || task.assignedTo) : 'agent';
  const otherTasks = (tasks || []).filter(t => t !== task);
  const doneTasks = otherTasks.filter(t => t.status === 'done');
  const pendingTasks = otherTasks.filter(t => t.status !== 'done');
  const files = task.projectFiles || projectFiles || {};

  const existingFiles = [];
  for (const [, data] of Object.entries(allOutputs || {})) {
    if (data && data.output) {
      const matches = String(data.output).match(/<file\s+name=["']([^"']+)["']>/gi);
      if (matches) matches.forEach(mm => existingFiles.push(mm.replace(/<file\s+name=["']|["']>/g, '')));
    }
  }

  const goalSec = `## The Goal\n${goal}\n`;
  const roleSec = `## Your Role\nYou are acting as "${role}". Your specific task: ${task.description}\n`;

  const fileContext = Object.entries(files).slice(0, 8)
    .map(([name, content]) => `### ${name}\n${String(content ?? '').slice(0, 4000)}`)
    .join('\n\n');
  const filesSec = fileContext
    ? `## User-Provided Project Files\nUse these files as source context. Preserve user intent and avoid discarding existing work.\n\n${fileContext}\n`
    : '';

  const pendingSec = pendingTasks.length
    ? `## What Other Agents Are Working On\n${pendingTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`
    : '';

  let formatSec = '';
  if (existingFiles.length) {
    formatSec += `## Already Created Files\n${[...new Set(existingFiles)].join(', ')}\nOnly create NEW files not in this list.\n\n`;
  }
  if (task.type === 'code') {
    formatSec += `## Output Format\nReturn complete, directly usable code. Wrap every generated or changed file in <file name="filename.ext"> and </file> tags.\nExample:\n<file name="index.html">\n<!DOCTYPE html>\n<html>\n</file>`;
  } else {
    formatSec += `## Output Quality\nBe specific, actionable, and concise. Include decisions, assumptions, and handoff notes that the next agent can use.`;
  }

  const doneHeader = doneTasks.length
    ? `## What Other Agents Have Already Completed\n${doneTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`
    : '';

  const completedEntries = Object.entries(allOutputs || {})
    .filter(([, d]) => d && d.status === 'done' && d.output);

  const fixedBefore = [goalSec, roleSec, filesSec].filter(Boolean);
  const tailParts = [pendingSec, formatSec].filter(Boolean);
  const completedExists = Boolean(doneHeader) || completedEntries.length > 0;

  const assemble = (completedText) => {
    const parts = [...fixedBefore];
    if (completedText) parts.push(completedText);
    parts.push(...tailParts);
    return parts.join(SEP);
  };

  const baseWithout = assemble('');
  const avail = completedExists ? budget - baseWithout.length - SEP.length : 0;

  let completedText = '';
  if (completedExists && avail > 0) {
    const fixedDone = doneHeader ? doneHeader.replace(/\n+$/, '') : '';
    if (!completedEntries.length) {
      completedText = fixedDone.length <= avail ? fixedDone : '';
    } else {
      const outputsHeader = '## Completed Agent Outputs To Build On';
      const headerBlock = fixedDone ? `${fixedDone}\n\n${outputsHeader}` : outputsHeader;
      const room = avail - headerBlock.length - 1;
      if (room <= 0) {
        completedText = fixedDone.length <= avail ? fixedDone : '';
      } else {
        const labels = completedEntries.map(([, d]) => `### ${d.agent || d.agentId || 'Agent'}\n`);
        const labelsLen = labels.reduce((n, l) => n + l.length, 0);
        const blanks = (completedEntries.length - 1) * 2;
        const roomEntries = room - labelsLen - blanks;

        const buildBody = (perEntry) => completedEntries
          .map(([, d], i) => labels[i] + compactOutput(String(d.output), Math.max(1, perEntry - labels[i].length)))
          .join('\n\n');

        const fullLen = completedEntries.reduce((n, [, d]) => n + String(d.output).length, 0);
        let body = '';
        if (roomEntries <= 0) {
          body = '';
        } else if (fullLen <= roomEntries) {
          body = completedEntries.map(([, d], i) => labels[i] + String(d.output)).join('\n\n');
        } else {
          let per = Math.floor(roomEntries / completedEntries.length);
          body = buildBody(per);
          while (body.length > roomEntries && per > 250) {
            per = Math.max(250, Math.floor(per * 0.6));
            body = buildBody(per);
          }
          if (body.length > roomEntries) {
            let sl = 200;
            body = completedEntries.map(([, d], i) => labels[i] + String(d.output).slice(0, sl)).join('\n\n');
            while (body.length > roomEntries && sl > 0) {
              sl = Math.floor(sl * 0.7);
              body = completedEntries.map(([, d], i) => labels[i] + String(d.output).slice(0, sl)).join('\n\n');
            }
            if (body.length > roomEntries) body = '';
          }
        }
        completedText = body ? `${headerBlock}\n${body}` : headerBlock;
        if (completedText.length > avail) completedText = fixedDone.length <= avail ? fixedDone : '';
      }
    }
  }

  let result = assemble(completedText);
  if (result.length > budget) {
    result = assemble('');
    if (result.length > budget) result = result.slice(0, budget);
  }
  return result;
}
