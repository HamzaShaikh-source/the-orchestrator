const $ = (id) => document.getElementById(id);

let pollTimer = null;
let running = false;
let currentChatId = null;
let selectedAgents = [];
let projectFiles = {}; /* { "filename.ext": "content..." } */
let activeFile = null;

/* ── Toast Notifications ── */

function showToast(msg, type = 'info') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 300); }, 3000);
}

/* ── File Management ── */

function renderFileTree() {
  const list = $('file-list');
  const names = Object.keys(projectFiles);
  if (names.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--dim);padding:8px 4px">No files yet. Files created by AI will appear here.</div>';
    $('files-section').style.display = 'none';
    return;
  }
  $('files-section').style.display = 'block';
  list.innerHTML = names.map(name => {
    const ext = name.split('.').pop();
    const icon = ext === 'html' ? '🌐' : ext === 'css' ? '🎨' : ext === 'js' ? '⚡' : ext === 'json' ? '📋' : ext === 'md' ? '📝' : '📄';
    return `<div class="file-item ${activeFile === name ? 'active' : ''}" data-file="${escapeHtml(name)}">
      <span class="icon">${icon}</span>
      <span class="name">${escapeHtml(name)}</span>
      <button class="del-btn" data-file="${escapeHtml(name)}">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.file-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn')) return;
      openFile(el.dataset.file);
    });
  });
  list.querySelectorAll('.del-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFile(el.dataset.file);
    });
  });
}

function openFile(name) {
  activeFile = name;
  const content = projectFiles[name] || '';
  const editor = $('file-editor-content');
  editor.value = content;
  editor.readOnly = false;
  $('file-editor-name').textContent = name;
  $('send-file-to-ai-btn').style.display = 'inline-block';
  renderFileTree();
}

function saveActiveFile() {
  if (!activeFile) return;
  const content = $('file-editor-content').value;
  projectFiles[activeFile] = content;
}

function deleteFile(name) {
  saveActiveFile();
  delete projectFiles[name];
  if (activeFile === name) {
    activeFile = Object.keys(projectFiles)[0] || null;
    if (activeFile) openFile(activeFile);
    else {
      $('file-editor-content').value = '';
      $('file-editor-content').readOnly = true;
      $('file-editor-name').textContent = 'Select a file';
      $('send-file-to-ai-btn').style.display = 'none';
    }
  }
  renderFileTree();
  showToast(`Deleted ${name}`, 'info');
}

$('new-file-btn').addEventListener('click', () => {
  const name = prompt('File name (e.g. style.css, script.js):');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (projectFiles[trimmed]) {
    showToast(`File "${trimmed}" already exists`, 'error');
    return;
  }
  projectFiles[trimmed] = '';
  openFile(trimmed);
  renderFileTree();
  showToast(`Created ${trimmed}`, 'success');
});

$('send-file-to-ai-btn').addEventListener('click', () => {
  if (!activeFile || running) return;
  saveActiveFile();
  const goal = $('goal-input').value.trim();
  const baseGoal = goal || 'Modify the selected file';
  $('goal-input').value = `${baseGoal}\n\nEdit this file: ${activeFile}\n\`\`\`\n${projectFiles[activeFile]}\n\`\`\``;
  showToast(`File "${activeFile}" added to prompt`, 'success');
});

/* Auto-save active file when switching away */
$('file-editor-content').addEventListener('blur', saveActiveFile);

/* ── Sync AI-generated files into project files ── */

function syncFilesFromAI(agentOutputs) {
  if (!agentOutputs) return;
  let changed = false;
  for (const [, data] of Object.entries(agentOutputs)) {
    if (!data.output) continue;
    const FILE_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
    let match;
    while ((match = FILE_RE.exec(data.output)) !== null) {
      const name = match[1].trim();
      const content = match[2].trim();
      if (projectFiles[name] !== content) {
        projectFiles[name] = content;
        changed = true;
      }
    }
  }
  if (changed) {
    renderFileTree();
    if (activeFile && projectFiles[activeFile] !== undefined) {
      $('file-editor-content').value = projectFiles[activeFile];
    }
  }
}

/* ── Goal Suggestions ── */

const GOAL_SUGGESTIONS = [
  'Create a landing page with CSS animations and a contact form',
  'Build a JavaScript calculator with dark theme',
  'Design a dashboard UI for tracking personal expenses',
  'Create a portfolio site with project gallery',
  'Build a todo app with local storage',
];

function renderSuggestions() {
  const el = $('suggestions');
  if (!el) return;
  el.innerHTML = GOAL_SUGGESTIONS.map(s =>
    `<button class="suggestion-chip" data-goal="${escapeHtml(s)}">${escapeHtml(s)}</button>`
  ).join('');
  el.querySelectorAll('.suggestion-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $('goal-input').value = btn.dataset.goal;
      el.style.display = 'none';
    });
  });
}

/* ── Onboarding ── */

function checkOnboarding() {
  const seen = localStorage.getItem('onboarding_seen');
  if (!seen) $('onboarding-overlay').classList.remove('hidden');
  $('onboarding-dismiss').addEventListener('click', () => {
    localStorage.setItem('onboarding_seen', '1');
    $('onboarding-overlay').classList.add('hidden');
  });
}

/* ── Chat History ── */

async function renderChatList() {
  const list = $('chat-list');
  const chats = await listChats();
  list.innerHTML = chats.map(c => `
    <div class="chat-item ${c.id === currentChatId ? 'active' : ''}" data-chat-id="${c.id}">
      <div class="chat-item-title">${escapeHtml(c.title)}</div>
      <div class="chat-item-meta">
        <span>${new Date(c.timestamp).toLocaleDateString()}</span>
        <span>${c.selectedAgents?.length || '?'} agents</span>
        <button class="chat-del-btn" data-chat-id="${c.id}" style="background:none;border:0;color:var(--dim);cursor:pointer;font-size:12px;margin-left:auto">×</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', (e) => { if (!e.target.closest('.chat-del-btn')) selectChat(el.dataset.chatId); });
  });
  list.querySelectorAll('.chat-del-btn').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteChat(el.dataset.chatId);
      if (currentChatId === el.dataset.chatId) newChat();
      renderChatList();
    });
  });
}

async function selectChat(chatId) {
  const chat = await getChat(chatId);
  if (!chat) return;
  currentChatId = chatId;
  $('goal-input').value = chat.prompt || '';
  $('status-text').textContent = chat.status === 'done' ? 'Complete!' : 'Ready';
  $('status-dot').className = chat.status === 'done' ? 'done' : '';
  if (chat.results) {
    renderTasks(chat.results.tasks || []);
    renderOutputs(chat.results.agentOutputs || {});
    renderSynthesis(chat.results.synthesis || '');
  } else {
    ['tasks-section','outputs-section','files-section','synth-section','export-section'].forEach(s => $(s).style.display = 'none');
  }
  /* Restore project files */
  if (chat.projectFiles) {
    projectFiles = { ...chat.projectFiles };
    activeFile = Object.keys(projectFiles)[0] || null;
    if (activeFile) openFile(activeFile);
    renderFileTree();
  }
  if (chat.selectedAgents?.length) highlightAgents(chat.selectedAgents);
  else unhighlightAgents();
  renderChatList();
}

function newChat() {
  currentChatId = null; selectedAgents = [];
  $('goal-input').value = ''; $('status-text').textContent = 'Ready'; $('status-dot').className = '';
  ['tasks-section','outputs-section','files-section','synth-section','export-section','confirm-section','error-retry-section'].forEach(s => {
    const el = $(s); if (el) el.style.display = 'none';
  });
  $('complexity-info').style.display = 'none'; $('loading-bar').classList.add('hidden');
  allActiveAgents().forEach(a => setAgentStatus(a.id, 'idle'));
  unhighlightAgents(); renderAgentCards(); renderChatList();
}

/* ── Agent Strip ── */

function renderAgentCards() {
  const list = $('agent-list');
  list.innerHTML = allActiveAgents().map(a => `
    <div class="agent-strip-card ${selectedAgents.includes(a.id) ? 'selected' : ''}" data-agent="${a.id}" title="Click to toggle ${a.name}">
      <span>${a.icon}</span>
      <span class="name">${a.name}</span>
      <span class="dot idle" id="dot-${a.id}"></span>
    </div>
  `).join('');
  list.querySelectorAll('.agent-strip-card').forEach(card => {
    card.addEventListener('click', () => {
      if (running) return;
      const id = card.dataset.agent;
      const idx = selectedAgents.indexOf(id);
      if (idx >= 0) selectedAgents.splice(idx, 1);
      else selectedAgents.push(id);
      renderAgentCards();
    });
  });
}

function highlightAgents(ids) {
  document.querySelectorAll('.agent-strip-card').forEach(card => {
    card.classList.toggle('selected', ids.includes(card.dataset.agent));
  });
  const names = ids.map(id => getAgent(id)?.name || id).join(', ');
  $('complexity-text').textContent = `Selected: ${names}`;
  $('complexity-info').style.display = 'block';
}

function unhighlightAgents() {
  document.querySelectorAll('.agent-strip-card').forEach(c => c.classList.remove('selected'));
}
function setAgentStatus(id, status) {
  const dot = document.getElementById(`dot-${id}`);
  if (dot) dot.className = `dot ${status || 'idle'}`;
}

/* ── Tasks ── */

function renderTasks(tasks, editable) {
  const grid = $('task-grid');
  if (!tasks || tasks.length === 0) { $('tasks-section').style.display = 'none'; return; }
  $('tasks-section').style.display = 'block';
  grid.innerHTML = tasks.map((t, i) => `
    <div class="task-card">
      <span class="num">#${i+1}</span>
      <div class="desc">${editable ? `<textarea class="task-edit" data-index="${i}" rows="2">${escapeHtml(t.description)}</textarea>` : escapeHtml(t.description)}</div>
      <div class="meta">
        <span class="assigned">→ ${t.assignedTo || '?'}</span>
        <span class="status ${t.status || 'pending'}">${t.status || 'pending'}</span>
      </div>
    </div>
  `).join('');
}

/* ── Outputs ── */

function renderOutputs(agentOutputs) {
  const area = $('output-area');
  if (!agentOutputs || Object.keys(agentOutputs).length === 0) { $('outputs-section').style.display = 'none'; return; }
  $('outputs-section').style.display = 'block';
  window._lastAgentOutputs = agentOutputs;
  /* Sync files from AI output */
  syncFilesFromAI(agentOutputs);
  area.innerHTML = Object.entries(agentOutputs).map(([id, data]) => {
    const agent = getAgent(id);
    if (!agent || (!data.output && data.status !== 'streaming' && data.status !== 'error' && data.status !== 'retrying')) return '';
    const badge = data.status === 'streaming' ? '<span class="badge-streaming">⏳ Generating...</span>' :
                  data.status === 'retrying' ? '<span class="badge-retry">🔄 Retrying...</span>' :
                  data.status === 'error' ? `<span class="badge-error">❌ ${escapeHtml(data.error || 'Error')}</span>` : '';
    const text = data.output || (data.status === 'error' ? data.error || 'Error' : 'Waiting...');
    return `<div class="output-card ${data.status === 'streaming' ? 'streaming' : ''}">
      <div class="header"><span class="icon">${agent.icon}</span> ${agent.name} ${badge}</div>
      <div class="body">${escapeHtml(text)}</div>
    </div>`;
  }).join('');
}

function renderSynthesis(text) {
  $('synth-section').style.display = text ? 'block' : 'none';
  $('synth-body').textContent = text || '';
  if (text) $('export-section').style.display = 'block';
}

/* ZIP download */
const FILE_TAG_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
function parseFiles(text) { const files = []; let m; while ((m = FILE_TAG_RE.exec(text)) !== null) files.push({name: m[1].trim(), content: m[2].trim()}); return files; }
function collectAllFiles(outputs) { const files = [], seen = new Set(); if (!outputs) return files; for (const [,d] of Object.entries(outputs)) { if (!d.output) continue; for (const f of parseFiles(d.output)) { if (!seen.has(f.name)) { seen.add(f.name); files.push(f); } } } return files; }

function crc32(d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) { c ^= d[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }

function createZipBlob(files) {
  const enc = new TextEncoder(); const local = [], central = []; let off = 0;
  for (const f of files) {
    const d = enc.encode(f.content), n = enc.encode(f.name), crc = crc32(d), sz = d.length;
    const lh = new ArrayBuffer(30 + n.length); const dv = new DataView(lh);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, 0, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, sz, true); dv.setUint32(22, sz, true);
    dv.setUint16(26, n.length, true); new Uint8Array(lh, 30).set(n); local.push(new Uint8Array(lh), d);
    const ch = new ArrayBuffer(46 + n.length); const cdv = new DataView(ch);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(10, 0, true);
    cdv.setUint32(14, crc, true); cdv.setUint32(18, sz, true); cdv.setUint32(22, sz, true);
    cdv.setUint16(26, n.length, true); cdv.setUint32(42, off, true);
    new Uint8Array(ch, 46).set(n); central.push(new Uint8Array(ch)); off += 30 + n.length + sz;
  }
  const cs = central.reduce((s,a) => s + a.length, 0), co = off;
  const eo = new ArrayBuffer(22); const ev = new DataView(eo);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cs, true); ev.setUint32(16, co, true);
  const chunks = [...local, ...central, new Uint8Array(eo)];
  const total = chunks.reduce((s,a) => s + a.length, 0);
  const merged = new Uint8Array(total); let pos = 0;
  for (const c of chunks) { merged.set(c, pos); pos += c.length; }
  return new Blob([merged], {type:'application/zip'});
}

$('download-files-btn')?.addEventListener('click', () => {
  const files = collectAllFiles(window._lastAgentOutputs);
  if (files.length === 0) return showToast('No files to download', 'error');
  const blob = createZipBlob(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'project-files.zip'; a.click();
  URL.revokeObjectURL(url); showToast('Downloaded project-files.zip', 'success');
});

/* ── Export ── */

function exportResults() {
  const goal = $('goal-input').value || 'Untitled';
  const synth = $('synth-body')?.textContent || '';
  const outputs = window._lastAgentOutputs || {};
  let md = `# ${goal}\n\n*Exported from The Orchestrator*\n\n---\n\n`;
  for (const [id, d] of Object.entries(outputs)) {
    const a = getAgent(id); md += `## ${a?.name || id}\n\n`;
    if (d.task) md += `*${d.task}*\n\n`;
    if (d.status === 'error') md += `*Error: ${d.error}*\n\n`;
    else if (d.output) md += `${d.output}\n\n`;
  }
  if (synth) md += `---\n## Synthesized Output\n\n${synth}\n\n`;
  for (const [name, content] of Object.entries(projectFiles)) {
    md += `### ${name}\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  const blob = new Blob([md], {type:'text/markdown'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'orchestrator-results.md'; a.click();
  URL.revokeObjectURL(url); showToast('Exported as Markdown', 'success');
}
$('export-btn')?.addEventListener('click', exportResults);

/* ── State & Render ── */

function statusText(state) {
  const m = {
    'agent-selection':'Selecting agents...','planning':'Brain planning...','synthesis':'Brain synthesizing...',
    'confirm-tasks':'Review tasks → Confirm to run','done':'Complete!',
    'error': state.error ? `Error: ${state.error}` : 'Error','cancelled':'Cancelled',
    'brain-writing': state.brainPhase || 'Brain preparing...',
    'brain-executing': state.brainPhase || 'Executing...',
    'brain-reviewing': state.brainPhase || 'Brain reviewing...',
  };
  if (m[state.step]) return m[state.step];
  if (state.step === 'login-check') return 'Checking logins...';
  if (state.step === 'running') return `Tasks: ${(state.tasks||[]).filter(t => t.status === 'done' || t.status === 'error').length}/${(state.tasks||[]).length}`;
  return state.step || 'Ready';
}

function render(state) {
  const dot = $('status-dot');
  const active = ['login-check','agent-selection','planning','confirm-tasks','running','brain-writing','brain-executing','brain-reviewing','synthesis'].includes(state.step);
  dot.className = active ? 'working' : state.step === 'done' ? 'done' : state.step === 'error' || state.step === 'cancelled' ? 'error' : '';
  $('status-text').textContent = statusText(state);
  const editing = state.step === 'confirm-tasks';
  renderTasks(state.tasks, editing);
  renderOutputs(state.agentOutputs);
  renderSynthesis(state.synthesis);
  renderLoginOverlay(state);
  const cs = $('confirm-section');
  if (cs) cs.style.display = state.step === 'confirm-tasks' ? 'flex' : 'none';
  if (state.selectedAgents?.length && state.step !== 'idle') highlightAgents(state.selectedAgents);
  if (state.step === 'done' || state.step === 'error' || state.step === 'cancelled') {
    resetUI();
    if (currentChatId) renderChatList();
    if (state.step === 'error') {
      $('error-msg').textContent = state.error || 'Unknown error.';
      $('error-retry-section').classList.remove('hidden');
    }
  }
}

function resetUI() {
  $('run-btn').disabled = false; $('stop-btn').classList.add('hidden');
  $('login-overlay').classList.add('hidden'); $('confirm-section').style.display = 'none';
  $('loading-bar').classList.add('hidden'); running = false; stopPoll();
}

/* ── Login Check UI ── */

function renderLoginOverlay(state) {
  const ov = $('login-overlay');
  if (state.step !== 'login-check') { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  const lc = state.loginCheck || {}, agents = lc.agents || {};
  $('login-agent-list').innerHTML = Object.entries(agents).map(([id, a]) => {
    const agent = getAgent(id);
    const st = a.status === 'done' ? '✅ Logged in' : a.status === 'waiting' ? '⏳ Waiting...' : a.status === 'cancelled' ? '❌ Cancelled' : a.status === 'checking' ? '⏳ Checking...' : '⚠️';
    const sc = a.status === 'done' ? 'done' : a.status === 'waiting' ? 'waiting' : 'error';
    return `<div class="login-agent-row"><span>${agent?.icon || '?'}</span><span style="flex:1">${a.agentName || id}</span><span class="status ${sc}">${st}</span></div>`;
  }).join('');
  const msg = $('login-status-msg'), actions = $('login-actions');
  if (lc.status === 'waiting') { msg.textContent = `Please log in to ${lc.agentName || lc.currentAgent} in the opened tab.`; actions.style.display = 'none'; }
  else if (lc.status === 'cancelled' || lc.status === 'failed') { msg.textContent = lc.error || 'Login failed.'; actions.style.display = 'flex'; }
  else if (lc.status === 'done') { msg.textContent = 'All logged in! Proceeding...'; actions.style.display = 'none'; }
  else { msg.textContent = ''; actions.style.display = 'none'; }
}

$('login-retry-btn')?.addEventListener('click', () => chrome.runtime.sendMessage({action:'loginRetry'}).catch(()=>{}));
$('login-cancel-btn')?.addEventListener('click', () => { chrome.runtime.sendMessage({action:'stopMulti'}).catch(()=>{}); $('login-overlay').classList.add('hidden'); });
$('confirm-btn')?.addEventListener('click', () => chrome.runtime.sendMessage({action:'confirmTasks'}).catch(()=>{}));
$('cancel-tasks-btn')?.addEventListener('click', () => chrome.runtime.sendMessage({action:'rejectTasks'}).catch(()=>{}));
$('error-retry-btn')?.addEventListener('click', () => { $('error-retry-section').classList.add('hidden'); $('run-btn').click(); });

/* ── Polling ── */

function startPoll() { stopPoll(); pollTimer = setInterval(fetchState, 800); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
async function fetchState() {
  try { const s = await chrome.runtime.sendMessage({action:'multiStatus'}); if (s) render(s); } catch {}
}

/* ── Run button ── */

$('run-btn').addEventListener('click', async () => {
  try {
    if (running) return;
    const goal = $('goal-input').value.trim();
    if (!goal) { $('status-text').textContent = 'Enter a goal first'; $('status-dot').className = 'error'; return; }

    running = true; $('run-btn').disabled = true; $('stop-btn').classList.remove('hidden');
    $('error-retry-section').classList.add('hidden'); $('suggestions').style.display = 'none';
    $('status-text').textContent = 'Starting...'; $('status-dot').className = 'working';
    $('confirm-section').style.display = 'none'; $('loading-bar').classList.remove('hidden');

    if (!currentChatId) { const chat = await createChat(goal); currentChatId = chat.id; await saveChat(chat); }
    else { const chat = await getChat(currentChatId); if (chat) { chat.prompt = goal; chat.status = 'running'; await saveChat(chat); } }
    /* Save project files to chat record */
    const chat = await getChat(currentChatId);
    if (chat && Object.keys(projectFiles).length > 0) {
      chat.projectFiles = { ...projectFiles };
      await saveChat(chat);
    }
    await renderChatList();
    allActiveAgents().forEach(a => setAgentStatus(a.id, 'idle'));
    startPoll();
    const manualUrls = {};
    let storedAgents = selectedAgents.length > 0 ? selectedAgents : null;
    if (currentChatId) {
      const chat = await getChat(currentChatId);
      if (chat?.selectedAgents?.length) storedAgents = chat.selectedAgents;
    }
    chrome.runtime.sendMessage({action:'runMulti', goal, selectedAgents: storedAgents || null, chatId: currentChatId, manualUrls, projectFiles});
  } catch (e) {
    $('status-text').textContent = 'Error: ' + e.message; $('status-dot').className = 'error'; $('loading-bar').classList.add('hidden'); resetUI();
  }
});

$('stop-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({action:'stopMulti'}).catch(()=>{});
  $('stop-btn').classList.add('hidden'); resetUI();
  $('status-text').textContent = 'Cancelled'; $('status-dot').className = 'error';
  if (currentChatId) { const chat = await getChat(currentChatId); if (chat) { chat.status = 'cancelled'; await saveChat(chat); } }
});

/* ── Helpers ── */

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

/* ── Init ── */

try {
  const loading = $('loading-init');
  if (loading) loading.classList.add('hidden');
  const app = $('app-content');
  if (app) app.classList.remove('hidden');
  renderSuggestions();
  renderAgentCards();
  renderChatList();
  newChat();
  checkOnboarding();
  showToast('Orchestrator ready — select agents and enter a goal', 'info');
} catch (e) {
  console.error('Init error:', e);
  /* Emergency fallback: try to hide loading and show app */
  try {
    document.getElementById('loading-init')?.classList?.add('hidden');
    document.getElementById('app-content')?.classList?.remove('hidden');
  } catch {}
}
