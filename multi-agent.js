const $ = id => document.getElementById(id);
let pollTimer = null, running = false, currentChatId = null, selectedAgents = [];
let projectFiles = {}, attachedFiles = [];

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  toast.style.cssText = `position:fixed; bottom:20px; right:20px; background:#1a1a24; border:1px solid ${type==='error'?'#f44250':'#10a37f'}; border-radius:8px; padding:10px 16px; z-index:9999; color:white; font-size:13px; box-shadow:0 4px 16px rgba(0,0,0,0.4); animation:fadeOut 3s forwards;`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/* ── Agent strip ── */
function renderAgentCards() {
  const strip = $('#agent-strip');
  if (!strip) return;
  strip.innerHTML = allActiveAgents().map(a => `
    <div class="agent-chip ${selectedAgents.includes(a.id) ? 'selected' : ''}" data-agent="${a.id}">
      <span>${a.icon}</span> ${a.name}
      <span class="dot" id="dot-${a.id}"></span>
    </div>
  `).join('');
  strip.querySelectorAll('.agent-chip').forEach(card => {
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
  document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('selected'));
  ids.forEach(id => document.querySelector(`.agent-chip[data-agent="${id}"]`)?.classList.add('selected'));
}

function setAgentStatus(id, status) {
  const dot = $(`dot-${id}`);
  if (dot) dot.className = `dot ${status}`;
}

/* ── Tasks ── */
function renderTasks(tasks, editable) {
  const container = $('#task-list');
  if (!tasks?.length) { $('#tasks-section').classList.add('hidden'); return; }
  $('#tasks-section').classList.remove('hidden');
  container.innerHTML = tasks.map((t, i) => `
    <div class="task-card">
      <div class="task-header">
        <span style="font-weight:600">#${i+1}</span>
        <span class="task-status ${t.status}">${t.status||'pending'}</span>
      </div>
      <div style="font-size:13px;line-height:1.5">${editable ? `<textarea data-index="${i}" style="width:100%;background:var(--surface-3);border:none;border-radius:8px;padding:8px;color:white;font-family:inherit">${escapeHtml(t.description)}</textarea>` : escapeHtml(t.description)}</div>
      <div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">→ ${t.assignedTo || 'unassigned'}</div>
    </div>
  `).join('');
}

/* ── Outputs ── */
function renderOutputs(agentOutputs) {
  const container = $('#outputs-list');
  if (!agentOutputs || !Object.keys(agentOutputs).length) { $('#outputs-section').classList.add('hidden'); return; }
  $('#outputs-section').classList.remove('hidden');
  syncFilesFromAI(agentOutputs);
  container.innerHTML = Object.entries(agentOutputs).map(([id, data]) => {
    const agent = getAgent(id);
    if (!agent) return '';
    const badge = data.status === 'streaming' ? '⏳' : data.status === 'done' ? '✅' : data.status === 'error' ? '❌' : '';
    const text = data.output || data.error || 'Waiting...';
    return `
      <div class="output-card">
        <div class="header"><span>${agent.icon}</span> ${agent.name} <span style="margin-left:auto">${badge}</span></div>
        <div class="body">${escapeHtml(text)}</div>
        <button class="copy-output" data-text="${escapeAttr(text)}" style="margin-top:8px;background:transparent;border:1px solid var(--line);border-radius:20px;padding:4px 12px;font-size:11px;cursor:pointer;color:var(--text-secondary)">📋 Copy</button>
      </div>
    `;
  }).join('');
  document.querySelectorAll('.copy-output').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.text).then(() => showToast('Copied!')).catch(() => {});
    });
  });
}

function syncFilesFromAI(agentOutputs) {
  if (!agentOutputs) return;
  let changed = false;
  const FILE_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
  for (const [, data] of Object.entries(agentOutputs)) {
    if (!data.output) continue;
    let match;
    while ((match = FILE_RE.exec(data.output))) {
      const name = match[1].trim(), content = match[2].trim();
      if (projectFiles[name] !== content) { projectFiles[name] = content; changed = true; }
    }
  }
}

function renderSynthesis(text) {
  $('#synth-section').classList.toggle('hidden', !text);
  $('#synth-body').textContent = text || '';
}

/* ── Export ── */
async function exportResults() {
  const goal = $('#goal-input').value || 'Chat';
  const synth = $('#synth-body')?.textContent || '';
  let md = `# ${goal}\n\n${synth}\n\n`;
  for (const [name, content] of Object.entries(projectFiles)) {
    md += `## ${name}\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'orchestrator.md'; a.click();
  URL.revokeObjectURL(url); showToast('Exported!');
}
$('#export-btn')?.addEventListener('click', exportResults);

/* ── Status & render ── */
function statusText(state) {
  if (state.step === 'login-check') return 'Checking logins...';
  if (state.step === 'planning') return 'Planning tasks...';
  if (state.step === 'confirm-tasks') return 'Review tasks and confirm';
  if (state.step === 'running') return `Executing (${state.tasks?.filter(t=>t.status==='done').length||0}/${state.tasks?.length||0})`;
  if (state.step === 'synthesis') return 'Synthesizing final output...';
  if (state.step === 'done') return 'Complete!';
  if (state.step === 'error') return `Error: ${state.error}`;
  return state.step || 'Ready';
}

function render(state) {
  const dot = $('#status-dot');
  const active = ['login-check', 'planning', 'confirm-tasks', 'running', 'synthesis'].includes(state.step);
  dot.className = `status-dot ${active ? 'working' : state.step==='done'?'done':state.step==='error'?'error':''}`;
  $('#status-text').textContent = statusText(state);
  renderTasks(state.tasks, state.step === 'confirm-tasks');
  renderOutputs(state.agentOutputs);
  renderSynthesis(state.synthesis);
  $('#confirm-bar').style.display = state.step === 'confirm-tasks' ? 'flex' : 'none';
  if (state.selectedAgents) highlightAgents(state.selectedAgents);
  if (['done', 'error', 'cancelled'].includes(state.step)) {
    running = false; $('#run-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden');
    stopPoll();
  }
}

/* ── Polling ── */
async function fetchState() {
  try { const s = await chrome.runtime.sendMessage({ action: 'multiStatus' }); if (s) render(s); } catch {}
}
function startPoll() { stopPoll(); pollTimer = setInterval(fetchState, 800); }
function stopPoll() { if (pollTimer) clearInterval(pollTimer); }

/* ── File upload ── */
$('#file-upload')?.addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  for (const f of files) {
    let content = '';
    if (f.type.startsWith('text/') || f.name.endsWith('.js') || f.name.endsWith('.html') || f.name.endsWith('.css') || f.name.endsWith('.json') || f.name.endsWith('.md')) {
      content = await f.text();
    } else content = `[Binary file: ${f.name} - ${f.size} bytes]`;
    attachedFiles.push({ name: f.name, content });
  }
  $('#file-count').textContent = `${attachedFiles.length} file(s)`;
  const goal = $('#goal-input');
  if (attachedFiles.length && !goal.value.includes('Attached files:')) {
    goal.value += `\n\nAttached files:\n${attachedFiles.map(f => `--- ${f.name} ---\n${f.content.slice(0, 1500)}`).join('\n')}`;
  }
  e.target.value = '';
});

/* ── Chat history ── */
async function renderChatList() {
  const chats = await listChats();
  const list = $('#chat-list');
  if (!list) return;
  list.innerHTML = chats.map(c =>
    `<div class="chat-item ${c.id===currentChatId?'active':''}" data-id="${c.id}">
      <div class="chat-title">${escapeHtml(c.title)}</div>
      <div class="chat-meta"><span>${new Date(c.timestamp).toLocaleDateString()}</span><button class="del-chat" data-id="${c.id}" style="background:none;border:none;color:red;cursor:pointer;font-size:14px">×</button></div>
    </div>`
  ).join('');
  list.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', (e) => { if (!e.target.classList.contains('del-chat')) selectChat(el.dataset.id); });
    el.querySelector('.del-chat')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteChat(el.dataset.id);
      if (currentChatId === el.dataset.id) newChat();
      renderChatList();
    });
  });
}

async function selectChat(id) {
  const chat = await getChat(id);
  if (!chat) return;
  currentChatId = id;
  $('#goal-input').value = chat.prompt || '';
  if (chat.results) {
    renderTasks(chat.results.tasks);
    renderOutputs(chat.results.agentOutputs);
    renderSynthesis(chat.results.synthesis);
  }
  if (chat.projectFiles) projectFiles = chat.projectFiles;
  if (chat.selectedAgents) highlightAgents(chat.selectedAgents);
  renderChatList();
}

function newChat() {
  currentChatId = null; selectedAgents = []; projectFiles = {};
  $('#goal-input').value = '';
  $('#status-text').textContent = 'Ready';
  $('#status-dot').className = 'status-dot';
  ['tasks-section', 'outputs-section', 'synth-section'].forEach(s => $(s)?.classList.add('hidden'));
  renderAgentCards();
  renderChatList();
}
$('#new-chat-btn')?.addEventListener('click', newChat);

/* ── Run / Stop ── */
$('#run-btn').addEventListener('click', async () => {
  if (running) return;
  const goal = $('#goal-input').value.trim();
  if (!goal) { showToast('Enter a goal first', 'error'); return; }
  running = true;
  $('#run-btn').classList.add('hidden');
  $('#stop-btn').classList.remove('hidden');
  $('#status-dot').className = 'status-dot working';
  $('#status-text').textContent = 'Starting...';
  startPoll();

  if (!currentChatId) {
    const chat = await createChat(goal);
    currentChatId = chat.id;
    await saveChat(chat);
  }
  await renderChatList();
  allActiveAgents().forEach(a => setAgentStatus(a.id, 'idle'));

  chrome.runtime.sendMessage({
    action: 'runMulti',
    goal,
    selectedAgents: selectedAgents.length ? selectedAgents : null,
    chatId: currentChatId,
    projectFiles,
  });
});

$('#stop-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopMulti' });
  running = false;
  $('#run-btn').classList.remove('hidden');
  $('#stop-btn').classList.add('hidden');
  stopPoll();
  $('#status-text').textContent = 'Cancelled';
  $('#status-dot').className = 'status-dot error';
  showToast('Cancelled', 'error');
});

$('#confirm-tasks')?.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'confirmTasks' }));
$('#cancel-tasks')?.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'rejectTasks' }));

function escapeHtml(str) { return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }
function escapeAttr(str) { return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

/* ── Init ── */
(async () => {
  renderAgentCards();
  await renderChatList();
  newChat();
  showToast('Ready – select agents and enter a goal');
})();
