const $ = (id) => document.getElementById(id);

let pollTimer = null;
let running = false;
let currentChatId = null;

/* ── Chat History ── */

async function renderChatList() {
  const list = $('chat-list');
  const chats = await listChats();
  list.innerHTML = chats.map(c => {
    const agentCount = c.selectedAgents?.length || '?';
    const date = new Date(c.timestamp).toLocaleDateString();
    return `
      <div class="chat-item ${c.id === currentChatId ? 'active' : ''}" data-chat-id="${c.id}">
        <div class="chat-item-title">${escapeHtml(c.title)}</div>
        <div class="chat-item-meta">
          <span>${date}</span>
          <span>${agentCount} agents</span>
          <button class="chat-del-btn" data-chat-id="${c.id}" title="Delete chat">×</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.chat-del-btn')) return;
      selectChat(el.dataset.chatId);
    });
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
    if (chat.results.agentOutputs) {
      for (const [id, data] of Object.entries(chat.results.agentOutputs)) {
        setAgentStatus(id, data.status || 'idle', data.output?.slice(0, 60) || '');
      }
    }
  } else {
    $('tasks-section').style.display = 'none';
    $('outputs-section').style.display = 'none';
    $('files-section').style.display = 'none';
    $('synth-section').style.display = 'none';
    allActiveAgents().forEach(a => setAgentStatus(a.id, 'idle', ''));
  }

  if (chat.selectedAgents?.length) {
    highlightAgents(chat.selectedAgents);
  } else {
    unhighlightAgents();
  }

  /* Restore agent conversation URLs in advanced inputs */
  if (chat.agentConvs) {
    for (const [agentId, url] of Object.entries(chat.agentConvs)) {
      const el = document.getElementById(`url-input-${agentId}`);
      if (el) el.value = url;
    }
  }

  renderChatList();
}

function newChat() {
  currentChatId = null;
  $('goal-input').value = '';
  $('status-text').textContent = 'Ready';
  $('status-dot').className = '';
  $('tasks-section').style.display = 'none';
  $('outputs-section').style.display = 'none';
  $('files-section').style.display = 'none';
  $('synth-section').style.display = 'none';
  $('complexity-info').style.display = 'none';
  allActiveAgents().forEach(a => setAgentStatus(a.id, 'idle', ''));
  unhighlightAgents();
  renderChatList();
}

/* ── Agent strip rendering ── */

function renderAgentCards() {
  const list = $('agent-list');
  list.innerHTML = allActiveAgents().map(a => `
    <div class="agent-strip-card" data-agent="${a.id}">
      <span class="icon">${a.icon}</span>
      <span class="name">${a.name}</span>
      <span class="dot idle" id="dot-${a.id}"></span>
    </div>
  `).join('');
}

function highlightAgents(selectedIds) {
  document.querySelectorAll('.agent-strip-card').forEach(card => {
    const id = card.dataset.agent;
    card.classList.toggle('active-agent', selectedIds.includes(id));
  });
  const text = $('complexity-text');
  if (text && selectedIds.length) {
    const names = selectedIds.map(id => getAgent(id)?.name || id).join(', ');
    text.textContent = `Selected agents: ${names}`;
    $('complexity-info').style.display = 'block';
  }
}

function unhighlightAgents() {
  document.querySelectorAll('.agent-strip-card').forEach(card => card.classList.remove('active-agent'));
}

function setAgentStatus(id, status, preview) {
  const dot = document.getElementById(`dot-${id}`);
  if (dot) dot.className = `dot ${status}`;
}

/* ── Task rendering ── */

function renderTasks(tasks) {
  const grid = $('task-grid');
  if (!tasks || tasks.length === 0) {
    $('tasks-section').style.display = 'none';
    return;
  }
  $('tasks-section').style.display = 'block';
  grid.innerHTML = tasks.map((t, i) => `
    <div class="task-card">
      <div class="num">#${i + 1}</div>
      <div class="desc">${escapeHtml(t.description)}</div>
      <div class="meta">
        <span class="assigned">→ ${t.assignedTo || 'unassigned'}</span>
        <span class="status ${t.status || 'pending'}">${t.status || 'pending'}</span>
      </div>
    </div>
  `).join('');
}

/* ── Output rendering ── */

/* ── File parsing & download ── */

const FILE_TAG_RE = /<file\s+name=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;

function parseFiles(text) {
  const files = [];
  let match;
  while ((match = FILE_TAG_RE.exec(text)) !== null) {
    files.push({ name: match[1].trim(), content: match[2].trim() });
  }
  return files;
}

function collectAllFiles(agentOutputs) {
  const files = [];
  const seen = new Set();
  if (!agentOutputs) return files;
  for (const [, data] of Object.entries(agentOutputs)) {
    if (!data.output) continue;
    const parsed = parseFiles(data.output);
    for (const f of parsed) {
      const key = f.name;
      if (!seen.has(key)) {
        seen.add(key);
        files.push(f);
      }
    }
  }
  return files;
}

function renderFiles(agentOutputs) {
  const area = $('files-area');
  const files = collectAllFiles(agentOutputs);
  if (files.length === 0) {
    $('files-section').style.display = 'none';
    return;
  }
  $('files-section').style.display = 'block';
  area.innerHTML = files.map(f => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;background:var(--surface-2);border:1px solid var(--line);font-size:12px">
      <span style="color:var(--brand);font-weight:700">&#9656;</span>
      <span style="flex:1;font-family:monospace;font-size:11px;color:var(--text)">${escapeHtml(f.name)}</span>
      <span style="color:var(--dim);font-size:11px">${f.content.length} bytes</span>
    </div>
  `).join('');
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipBlob(files) {
  const encoder = new TextEncoder();
  const localEntries = [];
  const centralEntries = [];
  let offset = 0;
  for (const f of files) {
    const data = encoder.encode(f.content);
    const name = encoder.encode(f.name);
    const crc = crc32(data);
    const size = data.length;
    const lh = new ArrayBuffer(30 + name.length);
    const dv = new DataView(lh);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    new Uint8Array(lh, 30).set(name);
    const lhArr = new Uint8Array(lh);
    localEntries.push(lhArr, data);
    const ch = new ArrayBuffer(46 + name.length);
    const cdv = new DataView(ch);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint32(14, crc, true);
    cdv.setUint32(18, size, true);
    cdv.setUint32(22, size, true);
    cdv.setUint16(26, name.length, true);
    cdv.setUint16(28, 0, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    new Uint8Array(ch, 46).set(name);
    centralEntries.push(new Uint8Array(ch));
    offset += 30 + name.length + size;
  }
  const centralSize = centralEntries.reduce((s, a) => s + a.length, 0);
  const centralOffset = offset;
  const eocd = new ArrayBuffer(22);
  const edv = new DataView(eocd);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true);
  const chunks = [...localEntries, ...centralEntries, new Uint8Array(eocd)];
  const total = chunks.reduce((s, a) => s + a.length, 0);
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { merged.set(c, pos); pos += c.length; }
  return new Blob([merged], { type: 'application/zip' });
}

$('download-files-btn').addEventListener('click', () => {
  const files = collectAllFiles(window._lastAgentOutputs);
  if (files.length === 0) return;
  const blob = createZipBlob(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'project-files.zip';
  a.click();
  URL.revokeObjectURL(url);
});

function renderOutputs(agentOutputs) {
  const area = $('output-area');
  if (!agentOutputs || Object.keys(agentOutputs).length === 0) {
    $('outputs-section').style.display = 'none';
    return;
  }
  $('outputs-section').style.display = 'block';
  window._lastAgentOutputs = agentOutputs;
  area.innerHTML = Object.entries(agentOutputs).map(([agentId, data]) => {
    const agent = getAgent(agentId);
    if (!agent || !data.output) return '';
    return `
      <div class="output-card">
        <div class="header">
          <span class="icon">${agent.icon}</span>
          <span class="name">${agent.name}</span>
        </div>
        <div class="body">${escapeHtml(data.output)}</div>
      </div>
    `;
  }).join('');
  renderFiles(agentOutputs);
}

function renderSynthesis(text) {
  $('synth-section').style.display = text ? 'block' : 'none';
  $('synth-body').textContent = text || '';
}

/* ── State management ── */

function statusText(state) {
  const msgs = {
    'agent-selection': 'AI selecting agents...',
    'planning': 'Planning tasks...',
    'synthesis': 'Synthesizing final output...',
    'done': 'Complete!',
    'error': state.error ? `Error: ${state.error}` : 'Error',
    'cancelled': 'Cancelled',
  };
  if (msgs[state.step]) return msgs[state.step];
  if (state.step === 'login-check') return 'Checking agent login status...';
  if (state.step === 'running') return `Running tasks (${(state.tasks || []).filter(t => t.status === 'done').length}/${(state.tasks || []).length})...`;
  if (state.step === 'feedback') return `Feedback loop ${state.loopIndex}/${state.loopCount}`;
  return state.step || 'Ready';
}

function render(state) {
  const dot = $('status-dot');
  const text = $('status-text');
  const isActive = ['login-check', 'agent-selection', 'planning', 'running', 'feedback', 'synthesis'].includes(state.step);
  dot.className = isActive ? 'working' : state.step === 'done' ? 'done' : state.step === 'error' || state.step === 'cancelled' ? 'error' : '';
  text.textContent = statusText(state);

  renderTasks(state.tasks);
  renderOutputs(state.agentOutputs);
  renderSynthesis(state.synthesis);
  renderLoginOverlay(state);

  if (state.agentOutputs) {
    for (const [id, data] of Object.entries(state.agentOutputs)) {
      setAgentStatus(id, data.status || 'idle');
    }
  }

  if (state.selectedAgents?.length && state.step !== 'idle') {
    highlightAgents(state.selectedAgents);
    const reasoning = state.agentReasoning;
    const info = $('complexity-text');
    const names = state.selectedAgents.map(id => getAgent(id)?.name || id).join(', ');
    if (reasoning && reasoning !== 'keyword fallback') {
      info.textContent = `Selected: ${names} — ${reasoning}`;
    } else {
      info.textContent = `Selected agents: ${names}`;
    }
    $('complexity-info').style.display = 'block';
  }

  if (state.step === 'done' || state.step === 'error' || state.step === 'cancelled') {
    resetUI();
    if (currentChatId) renderChatList();
  }
}

function resetUI() {
  $('run-btn').disabled = false;
  $('stop-btn').classList.add('hidden');
  $('login-overlay').classList.add('hidden');
  running = false;
  stopPoll();
}

/* ── Login Check UI ── */

function renderLoginOverlay(state) {
  const overlay = $('login-overlay');
  if (state.step !== 'login-check') {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');

  const lc = state.loginCheck || {};
  const agents = lc.agents || {};
  const list = $('login-agent-list');
  const msg = $('login-status-msg');
  const actions = $('login-actions');

  /* Render agent rows */
  list.innerHTML = Object.entries(agents).map(([id, a]) => {
    const agent = getAgent(id);
    const icon = agent?.icon || '?';
    const statusText = a.status === 'checking' ? '⏳ Checking...' :
                       a.status === 'done' ? '✅ Logged in' :
                       a.status === 'cancelled' ? '❌ Cancelled' :
                       a.status === 'not-logged-in' ? '⚠️ Not logged in' :
                       a.status === 'waiting' ? '⏳ Waiting for login...' :
                       a.status === 'timeout' ? '⏰ Timed out' :
                       a.status === 'error' ? '❌ Error' : '⏳';
    const statusClass = a.status === 'done' ? 'done' :
                        a.status === 'checking' ? 'checking' :
                        a.status === 'waiting' ? 'waiting' : 'error';
    return `<div class="login-agent-row">
      <span class="icon">${icon}</span>
      <span class="name">${a.agentName || id}</span>
      <span class="status ${statusClass}">${statusText}</span>
    </div>`;
  }).join('');

  /* Message + actions */
  if (lc.status === 'checking') {
    msg.textContent = `Checking login for ${lc.agentName || lc.currentAgent}...`;
    actions.style.display = 'none';
  } else if (lc.status === 'waiting') {
    msg.textContent = `Please log in to ${lc.agentName || lc.currentAgent} in the opened browser tab. This page will detect when you're logged in automatically.`;
    actions.style.display = 'none';
  } else if (lc.status === 'cancelled' || lc.status === 'failed') {
    msg.textContent = lc.error || 'Login check failed.';
    actions.style.display = 'flex';
  } else if (lc.status === 'done') {
    msg.textContent = 'All agents logged in! Proceeding...';
    actions.style.display = 'none';
  } else {
    msg.textContent = '';
    actions.style.display = 'none';
  }
}

/* Login overlay button handlers */
$('login-retry-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'loginRetry' }).catch(() => {});
});
$('login-cancel-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopMulti' }).catch(() => {});
  $('login-overlay').classList.add('hidden');
});

/* ── Polling ── */

function startPoll() {
  stopPoll();
  pollTimer = setInterval(fetchState, 800);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function fetchState() {
  try {
    const s = await chrome.runtime.sendMessage({ action: 'multiStatus' });
    if (s) render(s);
  } catch {}
}

/* ── Event handlers ── */

$('new-chat-btn').addEventListener('click', newChat);

$('run-btn').addEventListener('click', async () => {
  try {
    if (running) return;
    const goal = $('goal-input').value.trim();
    if (!goal) {
      $('status-text').textContent = 'Enter a goal first';
      $('status-dot').className = 'error';
      return;
    }

    running = true;
    $('run-btn').disabled = true;
    $('stop-btn').classList.remove('hidden');
    $('status-text').textContent = 'AI selecting agents...';
    $('status-dot').className = 'working';

    if (!currentChatId) {
      const chat = await createChat(goal);
      currentChatId = chat.id;
      await saveChat(chat);
    } else {
      const chat = await getChat(currentChatId);
      if (chat) {
        chat.prompt = goal;
        chat.status = 'running';
        await saveChat(chat);
      }
    }
    await renderChatList();

    allActiveAgents().forEach(a => setAgentStatus(a.id, 'idle'));

    startPoll();
    const manualUrls = collectUrlInputs();
    /* Reuse stored agent selection & conv URLs when re-running a historical chat */
    let storedAgents = null;
    if (currentChatId) {
      const chat = await getChat(currentChatId);
      if (chat?.selectedAgents?.length) storedAgents = chat.selectedAgents;
      if (chat?.agentConvs) {
        for (const [id, url] of Object.entries(chat.agentConvs)) {
          if (!manualUrls[id]) manualUrls[id] = url;
        }
      }
    }
    chrome.runtime.sendMessage({ action: 'runMulti', goal, selectedAgents: storedAgents, chatId: currentChatId, manualUrls });
  } catch (e) {
    console.error('Run error:', e);
    $('status-text').textContent = 'Error: ' + e.message;
    $('status-dot').className = 'error';
    resetUI();
  }
});

$('stop-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stopMulti' }).catch(() => {});
  $('stop-btn').classList.add('hidden');
  resetUI();
  $('status-text').textContent = 'Cancelled';
  $('status-dot').className = 'error';
  if (currentChatId) {
    const chat = await getChat(currentChatId);
    if (chat) { chat.status = 'cancelled'; await saveChat(chat); }
  }
});

/* ── Advanced URL inputs ── */

let urlInputsVisible = false;

function renderUrlInputs() {
  const list = $('url-inputs-list');
  list.innerHTML = allActiveAgents().map(a => `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
      <span style="font-size:11px;width:80px;flex:0 0 auto;color:var(--muted)">${a.icon} ${a.name}</span>
      <input type="text" id="url-input-${a.id}" placeholder="${a.url}" style="flex:1;background:#0e1118;border:1px solid var(--line);border-radius:4px;padding:4px 8px;color:var(--text);font-size:11px;outline:none">
    </div>
  `).join('');
}

function collectUrlInputs() {
  const urls = {};
  for (const a of allActiveAgents()) {
    const el = document.getElementById(`url-input-${a.id}`);
    const val = el?.value?.trim();
    if (val) urls[a.id] = val;
  }
  return urls;
}

$('toggle-urls-btn')?.addEventListener('click', () => {
  urlInputsVisible = !urlInputsVisible;
  $('url-inputs-section').style.display = urlInputsVisible ? 'block' : 'none';
  if (urlInputsVisible) renderUrlInputs();
});

/* ── Helpers ── */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ── Init ── */

renderAgentCards();
renderChatList();
newChat();
