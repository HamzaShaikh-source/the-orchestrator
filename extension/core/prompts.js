/* prompts.js — prompt builders (extension port of harness/prompts.js) */

import { buildTaskContext, compactOutput, TURN_BUDGET } from './context.js';

export function buildTaskPrompt(task, allTasks, allOutputs, goal, projectFiles = {}) {
  return buildTaskContext({ task, goal, tasks: allTasks, allOutputs, projectFiles });
}

export function buildSynthesisPrompt(goal, completedOutputs) {
  let rules = `Generate a single self-contained HTML file for: ${goal}

Rules:
- All CSS in <style>, all JS in <script>
- Semantic HTML5, responsive, production-ready
- Wrap the file in <file name="filename.ext"> and </file> tags`;
  if (rules.length > TURN_BUDGET) rules = rules.slice(0, TURN_BUDGET);

  const outputs = (Array.isArray(completedOutputs) ? completedOutputs : [])
    .map(o => (o && typeof o === 'object' ? String(o.output || '') : String(o || '')))
    .filter(o => o.trim().length > 0);
  if (!outputs.length) return rules;

  const header = '\n\n## Completed Specialist Outputs To Build On\n';
  const avail = TURN_BUDGET - rules.length - header.length;
  if (avail <= 200) return rules;

  const per = Math.floor(avail / outputs.length);
  let text = outputs.map(o => compactOutput(o, Math.max(50, per - 2))).join('\n\n');
  if (text.length > avail) {
    const sl = Math.max(20, Math.min(200, Math.floor(avail / outputs.length) - 2));
    text = outputs.map(o => o.slice(0, sl)).join('\n\n');
  }
  if (text.length > avail) return rules;
  return rules + header + text;
}

export async function reviewOutput(task, agent, output) {
  if (!output || output.length < 20) return output;
  const hasFiles = output.includes('<file name=');
  if (task.type === 'code' && !hasFiles) {
    console.log(`[Prompts] Code task without file tags in ${agent?.name || agent?.id || 'agent'}'s output`);
  }
  return output;
}