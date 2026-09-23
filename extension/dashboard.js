/* dashboard.js — The Orchestrator extension dashboard.
   Talks to the service worker over chrome.runtime port 'dash'. No server. */

const $ = (id) => document.getElementById(id);

const AGENTS = [
  { id: 'chatgpt', name: 'ChatGPT', icon: '💬', color: '#10a37f' },
  { id: 'gemini', name: 'Gemini', icon: '✨', color: '#4285f4' },
  { id: 'perplexity', name: 'Perplexity', icon: '🔍', color: '#22c55e' },
];

const PROVIDER_META = {
  chatgpt: { name: 'ChatGPT', color: '#10a37f' },
  gemini: { name: 'Gemini', color: '#4285f4' },
  perplexity: { name: 'Perplexity', color: '#22c55e' },
};

const CONNECTOR_META = {
  github: { name: 'GitHub', icon: '🐙' },
  'google-drive': { name: 'Google Drive', icon: '📁' },
  webhook: { name: 'Webhook', icon: '🔗' },
};

const state = {
  running: false,
  selectedAgents: new Set(['chatgpt', 'gemini', 'perplexity']),
  tasks: [],
  outputs: {},
  feed: [],
  providers: [],
  cookies: {},
  connectors: [],
  files: [],
  zipName: null,
  lastRun: null,
  selectedTaskId: null,
  activeTab: 'output',
};

let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'dash' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    setTimeout(() => {
      if (document.visibilityState !== 'hidden') connect();
    }, 1000);
  });
}

function send(msg) {
  try {
    if (port) port.postMessage(msg);
  } catch (err) {
    console.error('send failed', err);
  }
}

function onMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case 'event':
      handleEvent(msg.event);
      break;
    case 'done':
      handleDone(msg.result);
      break;
    case 'state':
      applyState(msg.state);
      break;
    case 'providers':
      state.providers = msg.providers || [];
      renderProviders();
      break;
    case 'connectors':
      state.connectors = msg.connectors || [];
      renderConnectors();
      renderConnectorPanel();
      break;
    case 'connector-result':
      handleConnectorResult(msg);
      break;
    case 'cookies':
      state.cookies = msg.cookies || {};
      renderProviders();
      break;
    case 'tokens-saved':
      toast(msg.ok ? 'Tokens saved' : `Save failed: ${msg.error || ''}`, msg.ok ? 'good' : 'info');
      if (msg.ok) send({ type: 'connectors' });
      break;
    case 'ping':
      break;
    default:
      break;
  }
}

/* ── Events ── */

function handleEvent(ev) {
  if (!ev) return;
  switch (ev.type) {
    case 'step':
      setStatus('running', ev.step === 'running' ? 'Running' : stepLabel(ev.step));
      addFeed(ev.step === 'running' ? 'Running tasks…' : stepLabel(ev.step), 'accent');
      break;
    case 'plan-start':
      addFeed('Planning tasks…', 'accent');
      break;
    case 'plan-done':
      addFeed(`Planned ${ev.count} tasks`);
      break;
    case 'agents':
      addFeed(`Agents: ${(ev.agents || []).join(', ')}${ev.reasoning ? ` — ${ev.reasoning}` : ''}`);
      break;
    case 'task-start':
      addTask(ev);
      addFeed(`${agentName(ev.agentId)}: ${ev.description}`, 'accent');
      break;
    case 'task-delta':
      appendOutput(ev.taskId, ev.text);
      break;
    case 'task-done':
      markTask(ev.taskId, 'done');
      addFeed(`${agentName(ev.agentId)}: done`);
      break;
    case 'task-error':
      markTask(ev.taskId, 'error', ev.error);
      addFeed(`${agentName(ev.agentId)}: error — ${ev.error}`, 'error');
      break;
    case 'agent-failover':
      addFeed(`Failover: ${agentName(ev.from)} → ${agentName(ev.to)}`, 'accent');
      break;
    case 'files-ready':
      state.files = ev.files || [];
      state.zipName = ev.zipName || null;
      renderFiles();
      addFeed(`Generated ${state.files.length} file(s)`);
      break;
    case 'confirm':
      addFeed('Awaiting confirmation…', 'accent');
      break;
    case 'error':
      toast(ev.message || 'Error', 'info');
      addFeed(ev.message || 'Error', 'error');
      break;
    default:
      break;
  }
}

function stepLabel(step) {
  const map = {
    providers: 'Checking providers…',
    'agent-selection': 'Selecting agents…',
    planning: 'Planning…',
    ordering: 'Ordering tasks…',
    'confirm-tasks': 'Confirming tasks…',
    running: 'Running…',
    synthesis: 'Synthesizing…',
    files: 'Collecting files…',
    saving: 'Saving…',
    done: 'Done',
    retry: 'Retrying…',
  };
  return map[step] || step;
}

function handleDone(result) {
  state.running = false;
  state.lastRun = result;
  setStatus(result.ok ? 'done' : 'error', result.ok ? 'Done' : 'Failed');
  $('cancel-btn').classList.add('hidden');
  $('run-btn').disabled = false;
  if (result.ok) {
    if (result.files && result.files.length) {
      state.files = result.files;
      state.zipName = result.zipName;
      renderFiles();
      addFeed(`Run complete — ${result.doneCount}/${result.taskCount} tasks, ${result.fileCount} file(s)`);
      toast('Run complete', 'good');
    } else {
      addFeed('Run complete — no files generated');
      toast('Run complete', 'good');
    }
  } else {
    addFeed(`Run failed: ${result.error || 'unknown error'}`, 'error');
    toast(`Run failed: ${result.error || ''}`, 'info');
  }
  renderTasks();
}

/* ── Rendering ── */

function agentName(id) {
  const a = AGENTS.find((x) => x.id === id);
  return a ? a.name : id;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(cls, text) {
  const pill = $('status-pill');
  pill.className = `pill ${cls}`;
  $('status-pill-text').textContent = text;
}

function addFeed(text, cls = '') {
  const feed = $('feed');
  const item = document.createElement('div');
  item.className = `feed-item ${cls}`.trim();
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  item.innerHTML = `<span class="feed-time">${time}</span>${escapeHtml(text)}`;
  feed.appendChild(item);
  while (feed.children.length > 60) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

function renderAgents() {
  $('agent-list').innerHTML = AGENTS.map((a) => {
    const task = state.tasks.find((t) => t.assignedTo === a.id && t.status === 'in-progress');
    const dotCls = task ? 'busy' : '';
    return `<div class="agent-row">
      <span class="agent-icon" style="color:${a.color}" aria-hidden="true">${a.icon}</span>
      <span class="agent-meta">
        <span class="agent-name">${a.name}</span>
        <span class="agent-task">${task ? escapeHtml(task.description) : 'idle'}</span>
      </span>
      <span class="agent-dot ${dotCls}"></span>
    </div>`;
  }).join('');
}

function renderProviders() {
  const list = state.providers.length ? state.providers : Object.keys(PROVIDER_META).map((id) => ({ id, available: false }));
  $('provider-list').innerHTML = list.map((p) => {
    const meta = PROVIDER_META[p.id] || { name: p.id, color: '#888' };
    const cookie = state.cookies[p.id];
    const loggedIn = p.available === true || (cookie && cookie.loggedIn);
    const cls = loggedIn ? 'done' : '';
    const label = loggedIn ? 'Live' : 'Not logged in';
    return `<button type="button" class="connector-row" aria-label="Provider ${escapeHtml(meta.name)}: ${label}">
      <span class="connector-icon" style="color:${meta.color}" aria-hidden="true">●</span>
      <span class="connector-name">${escapeHtml(meta.name)}</span>
      <span class="pill ${cls}"><span class="dot"></span><span class="label">${label}</span></span>
    </button>`;
  }).join('');
}

function connectorStatusInfo(c) {
  const status = c.status || 'needs-setup';
  if (status === 'connected') return { cls: 'done', label: 'Connected' };
  if (status === 'error') return { cls: 'error', label: 'Error' };
  return { cls: '', label: 'Needs setup' };
}

function renderConnectors() {
  $('connector-list').innerHTML = state.connectors.map((c) => {
    const meta = CONNECTOR_META[c.id] || { name: c.id, icon: '🔌' };
    const info = connectorStatusInfo(c);
    return `<div class="connector-row">
      <span class="connector-icon" aria-hidden="true">${meta.icon}</span>
      <span class="connector-name">${escapeHtml(meta.name)}</span>
      <span class="pill ${info.cls}"><span class="dot"></span><span class="label">${info.label}</span></span>
    </div>`;
  }).join('');
}

function renderTasks() {
  const board = $('task-board');
  if (!state.tasks.length) {
    board.innerHTML = '<div class="empty-note">No tasks yet. Enter a goal and press Run.</div>';
    return;
  }
  board.innerHTML = state.tasks.map((t) => {
    const statusCls = t.status === 'done' ? 'done' : t.status === 'error' ? 'error' : t.status === 'in-progress' ? 'running' : '';
    const statusLabel = t.status === 'done' ? 'Done' : t.status === 'error' ? 'Error' : t.status === 'in-progress' ? 'Running' : 'Pending';
    const selected = t.id === state.selectedTaskId ? ' selected' : '';
    return `<div class="task-card${selected}" data-task-id="${escapeHtml(t.id)}">
      <div class="task-card-top">
        <span class="type-badge">${escapeHtml(t.type || 'task')}</span>
        <span class="agent-chip"><span class="chip-icon">${agentIcon(t.assignedTo)}</span>${escapeHtml(agentName(t.assignedTo))}</span>
        <span class="pill ${statusCls}"><span class="dot"></span><span class="label">${statusLabel}</span></span>
      </div>
      <div class="task-desc">${escapeHtml(t.description)}</div>
      ${t.error ? `<div class="task-error-text">${escapeHtml(t.error)}</div>` : ''}
    </div>`;
  }).join('');
}

function agentIcon(id) {
  const a = AGENTS.find((x) => x.id === id);
  return a ? a.icon : '🤖';
}

function addTask(ev) {
  const existing = state.tasks.find((t) => t.id === ev.taskId);
  if (existing) {
    existing.status = 'in-progress';
    existing.assignedTo = ev.agentId;
    existing.description = ev.description;
    existing.type = ev.taskType;
  } else {
    state.tasks.push({ id: ev.taskId, status: 'in-progress', assignedTo: ev.agentId, description: ev.description, type: ev.taskType });
  }
  if (!state.selectedTaskId) state.selectedTaskId = ev.taskId;
  renderTasks();
  renderAgents();
  renderTaskSelect();
}

function markTask(taskId, status, error) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (t) {
    t.status = status;
    if (error) t.error = error;
  }
  renderTasks();
  renderAgents();
}

function appendOutput(taskId, text) {
  if (!text) return;
  if (!state.outputs[taskId]) state.outputs[taskId] = '';
  state.outputs[taskId] += text;
  if (state.selectedTaskId === taskId && state.activeTab === 'output') {
    $('output-pre').textContent = state.outputs[taskId];
    $('output-placeholder').classList.add('hidden');
    $('output-pre').scrollTop = $('output-pre').scrollHeight;
  }
}

function renderTaskSelect() {
  const sel = $('task-select');
  const current = sel.value;
  sel.innerHTML = state.tasks.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.description.slice(0, 60))}</option>`).join('');
  if (current && state.tasks.some((t) => t.id === current)) sel.value = current;
  else if (state.tasks.length) sel.value = state.tasks[0].id;
  showSelectedOutput();
}

function showSelectedOutput() {
  const taskId = $('task-select').value;
  state.selectedTaskId = taskId;
  const out = state.outputs[taskId];
  if (out) {
    $('output-pre').textContent = out;
    $('output-placeholder').classList.add('hidden');
  } else {
    $('output-pre').textContent = '';
    $('output-placeholder').classList.remove('hidden');
  }
  renderTasks();
}

function renderFiles() {
  const tbody = $('files-tbody');
  if (!state.files.length) {
    tbody.innerHTML = '';
    $('files-empty').classList.remove('hidden');
    $('zip-btn').classList.add('disabled');
    return;
  }
  $('files-empty').classList.add('hidden');
  $('zip-btn').classList.remove('disabled');
  tbody.innerHTML = state.files.map((f) => `<tr><td>${escapeHtml(f)}</td><td class="col-status">ready</td></tr>`).join('');
}

/* ── Connector panel ── */

function renderConnectorPanel() {
  const body = $('connector-panel-body');
  body.innerHTML = state.connectors.map((c) => {
    const meta = CONNECTOR_META[c.id] || { name: c.id, icon: '🔌' };
    const info = connectorStatusInfo(c);
    const actions = (c.actions || []).map((a) => `<button class="btn ghost small" data-conn-action="${escapeHtml(c.id)}:${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('');
    return `<div class="conn-card" data-conn-id="${escapeHtml(c.id)}">
      <div class="conn-card-head">
        <span class="connector-icon" aria-hidden="true">${meta.icon}</span>
        <span class="conn-title">${escapeHtml(meta.name)}</span>
        <span class="pill ${info.cls}"><span class="dot"></span><span class="label">${info.label}</span></span>
      </div>
      <div class="conn-detail">${escapeHtml(c.detail || '')}</div>
      <div class="conn-actions">${actions}</div>
      <div class="conn-result hidden" data-conn-result></div>
    </div>`;
  }).join('');

  /* token forms */
  const github = state.connectors.find((c) => c.id === 'github');
  const drive = state.connectors.find((c) => c.id === 'google-drive');
  if (github) {
    body.insertAdjacentHTML('beforeend', `<div class="conn-card">
      <div class="conn-card-head"><span class="conn-title">GitHub token</span></div>
      <div class="conn-form">
        <input class="conn-input" id="tok-github" type="password" placeholder="ghp_… personal access token">
        <button class="btn ghost small" id="save-github">Save GitHub token</button>
      </div>
    </div>`);
  }
  if (drive) {
    body.insertAdjacentHTML('beforeend', `<div class="conn-card">
      <div class="conn-card-head"><span class="conn-title">Google Drive OAuth</span></div>
      <div class="conn-form">
        <input class="conn-input" id="tok-gclient" type="password" placeholder="OAuth client ID">
        <input class="conn-input" id="tok-gsecret" type="password" placeholder="OAuth client secret">
        <input class="conn-input" id="tok-grefresh" type="password" placeholder="Refresh token">
        <button class="btn ghost small" id="save-drive">Save Drive credentials</button>
      </div>
    </div>`);
  }
}

function handleConnectorResult(msg) {
  const card = document.querySelector(`.conn-card[data-conn-id="${msg.id}"]`);
  const box = card ? card.querySelector('[data-conn-result]') : null;
  if (!box) return;
  box.classList.remove('hidden');
  const r = msg.result || {};
  if (r.ok) {
    box.className = 'conn-result ok';
    box.textContent = JSON.stringify(r.result || {}, null, 2).slice(0, 600);
    toast(`${msg.id} ${msg.action}: ok`, 'good');
  } else {
    box.className = 'conn-result err';
    box.textContent = `Error: ${r.error || 'unknown'}`;
  }
}

/* ── State ── */

function applyState(s) {
  state.running = Boolean(s.running);
  state.lastRun = s.lastRun || null;
  if (s.lastRun && s.lastRun.files && s.lastRun.files.length) {
    state.files = s.lastRun.files;
    state.zipName = s.lastRun.zipName;
    renderFiles();
  }
  if (s.running) {
    setStatus('running', 'Running');
    $('cancel-btn').classList.remove('hidden');
    $('run-btn').disabled = true;
  }
}

/* ── Actions ── */

function startRun() {
  const goal = $('goal').value.trim();
  if (!goal) {
    toast('Enter a goal first', 'info');
    return;
  }
  state.tasks = [];
  state.outputs = {};
  state.files = [];
  state.selectedTaskId = null;
  $('feed').innerHTML = '';
  $('task-board').innerHTML = '';
  $('output-pre').textContent = '';
  $('output-placeholder').classList.remove('hidden');
  renderFiles();
  renderTasks();
  setStatus('running', 'Starting…');
  $('cancel-btn').classList.remove('hidden');
  $('run-btn').disabled = true;
  send({ type: 'run', goal, selectedAgents: [...state.selectedAgents], autoConfirm: true });
}

function toast(text, cls = 'info') {
  const box = document.createElement('div');
  box.className = `toast ${cls}`;
  box.textContent = text;
  $('toasts').appendChild(box);
  setTimeout(() => box.remove(), 4000);
}

/* ── Wire up ── */

function init() {
  renderAgents();
  renderProviders();
  renderConnectors();
  renderTasks();
  renderTaskSelect();

  $('agent-chips').innerHTML = AGENTS.map((a) => {
    const sel = state.selectedAgents.has(a.id) ? ' selected' : '';
    return `<button type="button" class="chip${sel}" data-agent="${a.id}" aria-pressed="${sel ? 'true' : 'false'}">
      <span class="chip-icon">${a.icon}</span>${a.name}
    </button>`;
  }).join('');

  $('agent-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const id = btn.dataset.agent;
    if (state.selectedAgents.has(id)) state.selectedAgents.delete(id);
    else state.selectedAgents.add(id);
    btn.classList.toggle('selected');
    btn.setAttribute('aria-pressed', state.selectedAgents.has(id) ? 'true' : 'false');
  });

  $('run-btn').addEventListener('click', startRun);
  $('goal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startRun();
  });
  $('cancel-btn').addEventListener('click', () => send({ type: 'cancel' }));

  $('task-board').addEventListener('click', (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    state.selectedTaskId = card.dataset.taskId;
    const sel = $('task-select');
    if (sel) sel.value = state.selectedTaskId;
    showSelectedOutput();
  });

  $('task-select').addEventListener('change', showSelectedOutput);

  $('tab-output-btn').addEventListener('click', () => {
    state.activeTab = 'output';
    $('tab-output-btn').classList.add('active');
    $('tab-files-btn').classList.remove('active');
    $('output-panel').classList.remove('hidden');
    $('files-panel').classList.add('hidden');
  });
  $('tab-files-btn').addEventListener('click', () => {
    state.activeTab = 'files';
    $('tab-files-btn').classList.add('active');
    $('tab-output-btn').classList.remove('active');
    $('files-panel').classList.remove('hidden');
    $('output-panel').classList.add('hidden');
  });

  $('zip-btn').addEventListener('click', () => send({ type: 'download-zip' }));
  $('qa-push-btn').addEventListener('click', () => {
    const repo = $('qa-repo').value.trim();
    if (!repo) { toast('Enter owner/repo to push to', 'info'); return; }
    send({ type: 'connector-action', id: 'github', action: 'push-files', args: { repo } });
  });
  $('qa-drive-btn').addEventListener('click', () => {
    send({ type: 'connector-action', id: 'google-drive', action: 'upload-files', args: {} });
  });

  $('connectors-toggle').addEventListener('click', () => {
    $('connector-panel').classList.add('open');
    $('connector-panel').setAttribute('aria-hidden', 'false');
    $('panel-backdrop').classList.remove('hidden');
    send({ type: 'connectors' });
  });
  $('connector-panel-close').addEventListener('click', closePanel);
  $('panel-backdrop').addEventListener('click', closePanel);

  $('connector-panel-body').addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-conn-action]');
    if (actionBtn) {
      const [id, action] = actionBtn.dataset.connAction.split(':');
      send({ type: 'connector-action', id, action, args: {} });
      return;
    }
    if (e.target.id === 'save-github') {
      const v = $('tok-github').value.trim();
      if (!v) { toast('Enter a token', 'info'); return; }
      send({ type: 'save-tokens', tokens: { github: v } });
      $('tok-github').value = '';
    }
    if (e.target.id === 'save-drive') {
      const tokens = {
        googleClientId: $('tok-gclient').value.trim(),
        googleClientSecret: $('tok-gsecret').value.trim(),
        googleRefreshToken: $('tok-grefresh').value.trim(),
      };
      if (!tokens.googleClientId || !tokens.googleClientSecret || !tokens.googleRefreshToken) {
        toast('Fill all three Drive fields', 'info');
        return;
      }
      send({ type: 'save-tokens', tokens });
      ['tok-gclient', 'tok-gsecret', 'tok-grefresh'].forEach((id) => { $(id).value = ''; });
    }
  });

  connect();
  send({ type: 'state' });
  send({ type: 'providers' });
  send({ type: 'connectors' });
  send({ type: 'cookies' });
}

function closePanel() {
  $('connector-panel').classList.remove('open');
  $('connector-panel').setAttribute('aria-hidden', 'true');
  $('panel-backdrop').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', init);