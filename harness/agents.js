/* agents.js — Web2API-backed agent registry (deepseek/huggingface removed) */

export const AGENTS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    transport: 'web2api',
    provider: 'chatgpt',
    modelId: 'auto',
    capabilities: ['creative', 'writing', 'instruction', 'explanation'],
    strengths: { creative: 9, writing: 9, instruction: 9, code: 6, reasoning: 7, research: 5, analysis: 7, design: 9, ui: 9 },
    icon: '💬',
    color: '#10a37f',
    active: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    transport: 'web2api',
    provider: 'gemini',
    modelId: 'auto',
    capabilities: ['analysis', 'structured', 'multimodal', 'reasoning'],
    strengths: { analysis: 9, structured: 8, reasoning: 8, code: 7, creative: 6, research: 6, technical: 7, design: 7 },
    icon: '✨',
    color: '#4285f4',
    active: true,
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    transport: 'web2api',
    provider: 'perplexity',
    modelId: 'auto',
    capabilities: ['research', 'fact-checking', 'citations', 'current-events'],
    strengths: { research: 10, analysis: 7, writing: 5, code: 4, reasoning: 6, creative: 3, technical: 5 },
    icon: '🔍',
    color: '#22c55e',
    active: true,
  },
];

export const brainId = 'chatgpt';

function getAgent(id) {
  return AGENTS.find(a => a.id === id);
}

function scoreAgent(agentId, taskType) {
  const agent = getAgent(agentId);
  if (!agent || !agent.active) return 0;
  return agent.strengths[taskType] || 0;
}

function bestAgent(taskType) {
  let best = null;
  let bestScore = -1;
  for (const a of AGENTS) {
    if (!a.active) continue;
    const score = scoreAgent(a.id, taskType);
    if (score > bestScore) { bestScore = score; best = a.id; }
  }
  return best;
}

function allActiveAgents() {
  return AGENTS.filter(a => a.active);
}

/* ── Chat History System ── */

const CHATS_KEY = 'multiAgentChats';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function listChats(store) {
  const chats = await store.get(CHATS_KEY, []);
  return (Array.isArray(chats) ? chats : []).sort((a, b) => b.timestamp - a.timestamp);
}

async function getChat(store, id) {
  const chats = await listChats(store);
  return chats.find(c => c.id === id) || null;
}

async function saveChat(store, chat) {
  const chats = await listChats(store);
  const idx = chats.findIndex(c => c.id === chat.id);
  if (idx >= 0) chats[idx] = chat;
  else chats.unshift(chat);
  await store.set(CHATS_KEY, chats);
  return chat;
}

async function deleteChat(store, id) {
  let chats = await listChats(store);
  chats = chats.filter(c => c.id !== id);
  await store.set(CHATS_KEY, chats);
}

async function createChat(store, prompt, title) {
  const chat = {
    id: generateId(),
    title: title || prompt.slice(0, 60) || 'Untitled',
    prompt,
    timestamp: Date.now(),
    agentConvs: {},
    selectedAgents: [],
    results: null,
    status: 'pending',
  };
  await saveChat(store, chat);
  return chat;
}

/* ── Prompt Complexity Analysis ── */

const CAPABILITY_KEYWORDS = [
  ['code', ['code', 'script', 'program', 'function', 'algorithm', 'api', 'backend', 'frontend', 'javascript', 'python', 'rust', 'compile', 'debug', 'implement', 'build', 'develop', 'software', 'app']],
  ['reasoning', ['reason', 'logic', 'critical', 'evaluate', 'compare', 'contrast', 'why', 'how', 'explain', 'deduce', 'infer', 'conclusion']],
  ['creative', ['create', 'write', 'story', 'poem', 'essay', 'content', 'blog', 'article', 'creative', 'imagine', 'design', 'brainstorm', 'idea']],
  ['research', ['research', 'find', 'search', 'source', 'cite', 'reference', 'study', 'paper', 'journal', 'fact', 'verify', 'check', 'current', 'news']],
  ['analysis', ['analyze', 'analysis', 'compare', 'evaluate', 'assess', 'metrics', 'data', 'statistics', 'chart', 'graph', 'trend', 'pattern']],
  ['writing', ['write', 'edit', 'rewrite', 'proofread', 'grammar', 'style', 'tone', 'draft', 'outline', 'summarize', 'translate']],
  ['technical', ['technical', 'architecture', 'system', 'design', 'config', 'setup', 'install', 'deploy', 'infrastructure', 'protocol', 'server']],
  ['instruction', ['how to', 'guide', 'tutorial', 'steps', 'instructions', 'walkthrough', 'beginner', 'learn', 'teach']],
];

const AGENT_CAP_SCORES = {
  chatgpt: { creative: 10, writing: 9, instruction: 9, explanation: 8, analysis: 7, reasoning: 6, code: 5, research: 4, technical: 4 },
  gemini: { analysis: 9, reasoning: 8, structured: 9, multimodal: 9, creative: 6, code: 6, research: 5, writing: 6, technical: 5 },
  perplexity: { research: 10, analysis: 6, fact_checking: 10, citations: 10, current_events: 10, writing: 3, code: 2, reasoning: 4 },
};

function analyzePrompt(prompt) {
  const lower = prompt.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const score = {};

  for (const [cap, keywords] of CAPABILITY_KEYWORDS) {
    let s = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) s += 1;
      if (words.includes(kw)) s += 2;
    }
    score[cap] = s;
  }

  const length = words.length;
  const hasCode = /```|<code>|function\s+|class\s+|import\s+|def\s+/.test(lower);
  const questionCount = (lower.match(/\?/g) || []).length;
  const numberCount = (lower.match(/\d+/g) || []).length;

  const complexity = Math.min(10, Math.max(1,
    Math.round(
      (length > 60 ? 3 : length > 25 ? 2 : 1) +
      (hasCode ? 3 : 0) +
      Math.min(3, questionCount) +
      Math.min(2, numberCount)
    )
  ));

  return { score, complexity, length, hasCode };
}

function selectAgents(prompt) {
  const analysis = analyzePrompt(prompt);
  const { score, complexity } = analysis;

  const agentScores = {};
  for (const [agentId, caps] of Object.entries(AGENT_CAP_SCORES)) {
    let total = 0;
    for (const [cap, capScore] of Object.entries(caps)) {
      total += (score[cap] || 0) * capScore / 10;
    }
    agentScores[agentId] = Math.round(total * 10) / 10;
  }

  const sorted = Object.entries(agentScores).sort((a, b) => b[1] - a[1]);

  const numAgents = Math.min(5, Math.max(2, Math.ceil(complexity / 2)));
  const selected = sorted.slice(0, numAgents).map(([id]) => id).filter(id => getAgent(id));

  return { selected, complexity, scores: agentScores, sorted };
}

export {
  getAgent,
  allActiveAgents,
  scoreAgent,
  bestAgent,
  analyzePrompt,
  selectAgents,
  listChats,
  getChat,
  saveChat,
  deleteChat,
  createChat,
};
