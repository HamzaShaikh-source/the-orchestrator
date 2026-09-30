'use strict';

/* ---------- registry ---------- */

const AGENT_REGISTRY = {
  chatgpt: { id: 'chatgpt', name: 'ChatGPT', icon: '✦', color: '#10a37f' },
  gemini: { id: 'gemini', name: 'Gemini', icon: '✦', color: '#4285f4' },
  perplexity: { id: 'perplexity', name: 'Perplexity', icon: '✦', color: '#20b8cd' },
};
const BRAIN_ID = 'chatgpt';

const CONNECTOR_FALLBACK = [
  { id: 'github', name: 'GitHub', icon: '🐙' },
  { id: 'google-drive', name: 'Google Drive', icon: '📁' },
  { id: 'webhook', name: 'Webhook', icon: '🔗' },
];

/* ---------- state ---------- */

const state = {
  status: 'idle',            // idle | running | done | error
  running: false,
  step: '',
  selected: Object.keys(AGENT_REGISTRY),
  activeAgents: [],
  reasoning: '',
  connectors: [],            // [{id,name,icon,status,detail,actions}]
  connectorResults: {},      // id -> {ok, text}
  tasks: [],
  feed: [],
  selectedTaskId: null,
  tab: 'output',
  lastRun: null,             // {ok, files, conflicts, zipPath, error, tasks}
  runDir: null,
  panelOpen: false,
  panelConnectorId: null,
};

const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function agentInfo(id) {
  return AGENT_REGISTRY[id] || { id, name: id || 'Unknown', icon: '✦', color: '#a0a0a0' };
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function clockTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function normFile(f) {
  if (typeof f === 'string') return { name: f, bytes: null, status: '' };
  return { name: f.name || '', bytes: f.bytes ?? null, status: f.status || '' };
}

function dirFromZip(zipPath) {
  if (!zipPath) return null;
  const parts = String(zipPath).split(/[\\/]/);
  if (parts.length < 2) return null;
  const dir = parts[parts.length - 2];
  return /^[a-z0-9-]+$/.test(dir) ? dir : null;
}

function getTask(taskId) {
  return state.tasks.find((t) => t.taskId === taskId) || null;
}

/* ---------- toasts ---------- */

function toast(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? 'info' : kind === 'good' ? 'good' : ''}`;
  el.textContent = String(message);
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* ---------- activity feed ---------- */

function pushFeed(text, kind = '') {
  state.feed.push({ ts: Date.now(), text: String(text), kind });
  if (state.feed.length > 200) state.feed.splice(0, state.feed.length - 200);
  renderFeed();
}

/* ---------- reducer ---------- */

function reducer(ev) {
  if (!ev || !ev.type) return;

  switch (ev.type) {
    case 'hello': {
      applyServerState(ev.state || {});
      break;
    }

    case 'step': {
      state.step = ev.step || '';
      if (ev.step === 'synthesis') {
        ensureSynthesisCard();
        pushFeed('Brain synthesizing…', 'accent');
      } else if (ev.step === 'retry') {
        pushFeed('Retrying failed task…', 'bad');
      } else if (ev.step === 'files') {
        pushFeed('Extracting files…');
      } else if (ev.step === 'done') {
        // run-end carries the authoritative result; keep pill in sync if it lags
        if (state.running) { state.running = false; state.status = 'done'; }
      }
      renderTopBar();
      renderTasks();
      break;
    }

    case 'agents': {
      state.activeAgents = Array.isArray(ev.agents) ? ev.agents.slice() : [];
      state.reasoning = ev.reasoning || '';
      renderAgents();
      break;
    }

    case 'plan-start': {
      const goal = String(ev.goal || '').slice(0, 80);
      pushFeed(`Planning: ${goal}`);
      break;
    }

    case 'plan-done': {
      pushFeed(`Planned ${ev.count} task${ev.count === 1 ? '' : 's'}`);
      break;
    }

    case 'confirm': {
      const incoming = Array.isArray(ev.tasks) ? ev.tasks : [];
      incoming.forEach((t, i) => {
        const taskId = String(t.taskId ?? t.id ?? `t${i}`);
        if (!getTask(taskId)) {
          state.tasks.push({
            taskId,
            agentId: t.agentId ?? t.agent ?? null,
            description: t.description ?? t.title ?? '',
            taskType: t.taskType ?? t.type ?? 'task',
            status: 'pending',
            phase: 'pending',
            output: '',
            bytes: 0,
            error: null,
          });
        }
      });
      if (!state.selectedTaskId && state.tasks.length) {
        state.selectedTaskId = state.tasks[0].taskId;
      }
      renderTasks();
      renderOutput();
      break;
    }

    case 'task-start': {
      let t = getTask(ev.taskId);
      if (!t) {
        t = {
          taskId: String(ev.taskId),
          agentId: null,
          description: '',
          taskType: 'task',
          status: 'pending',
          phase: 'pending',
          output: '',
          bytes: 0,
          error: null,
        };
        state.tasks.push(t);
      }
      t.agentId = ev.agentId ?? t.agentId;
      if (ev.description) t.description = ev.description;
      if (ev.taskType) t.taskType = ev.taskType;
      t.status = 'active';
      t.phase = 'reading';   // Reading… for first 1.5s, then Thinking… until first delta
      t.error = null;
      startReadingTimer(t);
      if (!state.selectedTaskId) {
        state.selectedTaskId = t.taskId;
        renderOutput();
      }
      const agent = agentInfo(t.agentId);
      pushFeed(
        t.agentId === 'perplexity'
          ? 'Perplexity searching…'
          : `${agent.name} is thinking…`,
        'accent'
      );
      renderTasks();
      renderAgents();
      renderTaskSelect();
      break;
    }

    case 'task-delta': {
      const t = getTask(ev.taskId);
      if (!t) break;
      if (t.phase === 'reading' || t.phase === 'thinking') {
        clearReadingTimer(ev.taskId);
        t.phase = t.agentId === 'perplexity' ? 'searching' : 'writing';
        renderTasks();
      }
      queueDelta(t, ev.text || '');
      break;
    }

    case 'task-done': {
      const t = getTask(ev.taskId);
      clearReadingTimer(ev.taskId);
      if (!t) break;
      t.status = 'done';
      t.phase = 'done';
      if (ev.task && typeof ev.task === 'object') {
        if (ev.task.output && !t.output) t.output = ev.task.output;
        if (ev.task.description) t.description = ev.task.description;
      }
      const agent = agentInfo(t.agentId);
      pushFeed(`${agent.name} wrote ${fmtBytes(t.bytes || t.output.length)}`, 'good');
      renderTasks();
      renderAgents();
      break;
    }

    case 'task-error': {
      const t = getTask(ev.taskId);
      clearReadingTimer(ev.taskId);
      if (!t) break;
      t.status = 'error';
      t.phase = 'error';
      t.error = ev.error || 'Task failed';
      toast(`Task error: ${t.error}`, 'error');
      pushFeed(`${agentInfo(t.agentId).name} error: ${t.error}`, 'bad');
      renderTasks();
      renderAgents();
      break;
    }

    case 'agent-failover': {
      pushFeed(
        `Failover: ${agentInfo(ev.from).name} → ${agentInfo(ev.to).name}`,
        'bad'
      );
      break;
    }

    case 'run-end': {
      const result = ev.result || {};
      state.running = false;
      state.status = result.ok ? 'done' : 'error';
      state.lastRun = result;
      state.runDir = dirFromZip(result.zipPath) || state.runDir;
      const synth = state.tasks.find((t) => t.taskId === 'synthesis');
      if (synth && synth.status === 'active') {
        synth.status = result.ok ? 'done' : 'error';
        synth.phase = synth.status;
      }
      if (Array.isArray(result.files) && result.files.length) {
        pushFeed(`Files written: ${result.files.length}`, 'good');
      }
      if (Array.isArray(result.conflicts) && result.conflicts.length) {
        pushFeed(`Conflicts: ${result.conflicts.length}`, 'bad');
      }
      if (!result.ok && result.error) {
        toast(result.error, 'error');
        pushFeed(`Run failed: ${result.error}`, 'bad');
      } else {
        pushFeed('Run complete', 'good');
      }
      if (!state.runDir) resolveRunDir();
      renderAll();
      break;
    }

    case 'connector': {
      const info = state.connectors.find((c) => c.id === ev.id);
      const name = info ? info.name : ev.id;
      if (ev.ok) {
        state.connectorResults[ev.id] = {
          ok: true,
          text: summarizeConnectorResult(ev.action, ev.result),
          repos: ev.action === 'list-repos' && ev.result && Array.isArray(ev.result.repos)
            ? ev.result.repos
            : undefined,
        };
        const feedMsg = connectorFeedMessage(ev.id, ev.action);
        if (feedMsg) pushFeed(feedMsg, 'good');
        if (state.panelOpen) renderPanel();
      } else {
        const err = ev.error || 'Connector action failed';
        state.connectorResults[ev.id] = { ok: false, text: String(err) };
        toast(`${name}: ${err}`, 'error');
        pushFeed(`${name}: ${err}`, 'bad');
        if (state.panelOpen) renderPanel();
      }
      break;
    }

    default:
      break;
  }
}

function applyServerState(s) {
  state.running = !!s.running;
  if (state.running) state.status = 'running';
  else if (s.lastRun) state.status = s.lastRun.ok ? 'done' : 'error';
  else state.status = 'idle';
  if (s.lastRun) {
    state.lastRun = s.lastRun;
    const dir = dirFromZip(s.lastRun.zipPath);
    if (dir) state.runDir = dir;
  }
  if (Array.isArray(s.agents) && s.agents.length) {
    const fromServer = s.agents.filter((a) => a && a.id && AGENT_REGISTRY[a.id]);
    const active = fromServer.filter((a) => a.active !== false).map((a) => a.id);
    if (active.length) state.selected = active;
  }
  if (Array.isArray(s.cookies)) state.cookies = s.cookies;
  if (Array.isArray(s.providers)) state.providers = s.providers;
  if (!state.runDir) resolveRunDir();
}

/* ---------- reading timer (Reading… → Thinking…) ---------- */

const readingTimers = new Map();

function startReadingTimer(task) {
  clearReadingTimer(task.taskId);
  const timer = setTimeout(() => {
    readingTimers.delete(task.taskId);
    if (task.phase === 'reading') {
      task.phase = 'thinking';
      renderTasks();
    }
  }, 1500);
  readingTimers.set(task.taskId, timer);
}

function clearReadingTimer(taskId) {
  const timer = readingTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    readingTimers.delete(taskId);
  }
}

/* ---------- streaming deltas (requestAnimationFrame batch) ---------- */

const pendingDeltas = new Map(); // task -> pending text
let deltaRaf = null;

function queueDelta(task, text) {
  pendingDeltas.set(task, (pendingDeltas.get(task) || '') + text);
  if (deltaRaf == null) {
    deltaRaf = requestAnimationFrame(flushDeltas);
  }
}

function flushDeltas() {
  deltaRaf = null;
  pendingDeltas.forEach((chunk, task) => {
    task.output += chunk;
    task.bytes += chunk.length;
    if (state.selectedTaskId === task.taskId && state.tab === 'output') {
      const pre = $('output-pre');
      pre.textContent += chunk;
      pre.classList.remove('hidden');
      $('output-placeholder').classList.add('hidden');
      pre.scrollTop = pre.scrollHeight;
    }
  });
  pendingDeltas.clear();
}

/* ---------- synthesis pseudo-task ---------- */

function ensureSynthesisCard() {
  if (getTask('synthesis')) {
    const s = getTask('synthesis');
    if (s.status === 'pending') { s.status = 'active'; s.phase = 'synthesizing'; }
    return s;
  }
  state.tasks.push({
    taskId: 'synthesis',
    agentId: BRAIN_ID,
    description: 'Synthesize final deliverable from completed task outputs',
    taskType: 'synthesis',
    status: 'active',
    phase: 'synthesizing',
    output: '',
    bytes: 0,
    error: null,
  });
  renderTasks();
  renderTaskSelect();
  return getTask('synthesis');
}

/* ---------- phase labels / pill markup ---------- */

const PHASE_LABEL = {
  pending: 'Queued',
  reading: 'Reading…',
  thinking: 'Thinking…',
  writing: 'Writing…',
  searching: 'Searching…',
  synthesizing: 'Synthesizing…',
  done: 'Done',
  error: 'Error',
};

function phasePill(task) {
  const phase = task.phase || 'pending';
  const live = ['reading', 'thinking', 'writing', 'searching', 'synthesizing'].includes(phase);
  const cls = phase === 'done' ? 'done' : phase === 'error' ? 'error' : live ? 'live' : '';
  const title = phase === 'error' && task.error
    ? ` title="${escapeHtml(task.error)}"`
    : '';
  return `<span class="pill ${cls}"${title}><span class="dot"></span><span class="label">${escapeHtml(PHASE_LABEL[phase] || phase)}</span></span>`;
}

/* ---------- renders ---------- */

function renderAll() {
  renderTopBar();
  renderChips();
  renderAgents();
  renderProviders();
  renderConnectors();
  renderTasks();
  renderFeed();
  renderTaskSelect();
  renderOutput();
  renderFiles();
}

function renderTopBar() {
  const pill = $('status-pill');
  const text = state.status;
  const label = text.charAt(0).toUpperCase() + text.slice(1);
  $('status-pill-text').textContent = label;
  pill.className = `pill ${text}`;
  pill.title = state.step ? `Step: ${state.step}` : '';
  $('cancel-btn').classList.toggle('hidden', !state.running);
  $('run-btn').disabled = state.running;
  $('run-btn').textContent = state.running ? 'Running…' : 'Run';
  $('connectors-toggle').setAttribute('aria-expanded', String(state.panelOpen));
}

function renderChips() {
  const wrap = $('agent-chips');
  wrap.innerHTML = Object.values(AGENT_REGISTRY).map((a) => {
    const on = state.selected.includes(a.id);
    return `<button type="button" class="chip${on ? ' selected' : ''}" data-agent="${a.id}" aria-pressed="${on}" aria-label="Toggle ${escapeHtml(a.name)}">` +
      `<span class="chip-icon" style="color:${a.color}">${a.icon}</span>${escapeHtml(a.name)}</button>`;
  }).join('');
}

function agentRowStatus(agentId) {
  const tasks = state.tasks.filter((t) => t.agentId === agentId && t.taskId !== 'synthesis');
  if (!tasks.length) return { cls: '', task: '' };
  const activeTask = tasks.find((t) => t.status === 'active');
  if (activeTask && state.running) {
    return { cls: 'busy', task: activeTask.description || 'working…' };
  }
  if (state.status === 'idle' && !state.running) {
    const last = tasks[tasks.length - 1];
    if (last.status === 'error') return { cls: 'error', task: last.error || 'failed' };
    if (last.status === 'done') return { cls: 'done', task: 'done' };
    return { cls: '', task: '' };
  }
  if (state.status === 'error' && tasks.some((t) => t.status === 'error')) {
    const err = tasks.find((t) => t.status === 'error');
    return { cls: 'error', task: err.error || 'failed' };
  }
  if (state.status === 'done' && tasks.every((t) => t.status === 'done' || t.status === 'error')) {
    const err = tasks.find((t) => t.status === 'error');
    return err ? { cls: 'error', task: err.error || 'failed' } : { cls: 'done', task: 'done' };
  }
  return { cls: '', task: '' };
}

function renderAgents() {
  $('agent-list').innerHTML = Object.values(AGENT_REGISTRY).map((a) => {
    const { cls, task } = agentRowStatus(a.id);
    return `<div class="agent-row">` +
      `<span class="agent-icon" style="color:${a.color}" aria-hidden="true">${a.icon}</span>` +
      `<span class="agent-meta">` +
        `<span class="agent-name">${escapeHtml(a.name)}${a.id === BRAIN_ID ? ' · Brain' : ''}</span>` +
        `<span class="agent-task" title="${escapeHtml(task)}">${escapeHtml(task)}</span>` +
      `</span>` +
      `<span class="agent-dot ${cls}" role="img" aria-label="${cls || 'idle'}"></span>` +
    `</div>`;
  }).join('');
}

const PROVIDER_META = {
  chatgpt: { name: 'ChatGPT', color: '#10a37f' },
  gemini: { name: 'Gemini', color: '#4285f4' },
  perplexity: { name: 'Perplexity', color: '#22c55e' },
};

function renderProviders() {
  const list = state.cookies && state.cookies.length ? state.cookies : [];
  $('provider-list').innerHTML = list.map((p) => {
    const meta = PROVIDER_META[p.id] || { name: p.id, color: '#888' };
    const live = Array.isArray(state.providers) && state.providers.includes(p.id);
    const cls = p.configured ? 'done' : '';
    const label = p.configured ? (live ? 'Live' : 'Configured') : 'Not configured';
    return `<button type="button" class="connector-row" data-provider="${escapeHtml(p.id)}" aria-label="Provider ${escapeHtml(meta.name)}: ${label}">` +
      `<span class="connector-icon" style="color:${meta.color}" aria-hidden="true">✦</span>` +
      `<span class="connector-name">${escapeHtml(meta.name)}</span>` +
      `<span class="pill ${cls}"><span class="dot"></span><span class="label">${label}</span></span>` +
    `</button>`;
  }).join('');
}

function connectorStatusInfo(c) {
  const status = c.status || 'needs-setup';
  if (status === 'connected') return { cls: 'done', label: 'Connected' };
  if (status === 'error') return { cls: 'error', label: 'Error' };
  return { cls: '', label: 'Needs setup' };
}

function renderConnectors() {
  const list = state.connectors.length ? state.connectors : CONNECTOR_FALLBACK;
  $('connector-list').innerHTML = list.map((c) => {
    const s = connectorStatusInfo(c);
    return `<button type="button" class="connector-row" data-connector="${escapeHtml(c.id)}" aria-label="Open ${escapeHtml(c.name)} connector">` +
      `<span class="connector-icon" aria-hidden="true">${c.icon}</span>` +
      `<span class="connector-name">${escapeHtml(c.name)}</span>` +
      `<span class="pill ${s.cls}"><span class="dot"></span><span class="label">${s.label}</span></span>` +
    `</button>`;
  }).join('');
}

function renderTasks() {
  const board = $('task-board');
  if (!state.tasks.length) {
    board.innerHTML = '<div class="empty-note">No tasks yet. Set a goal and hit Run.</div>';
    return;
  }
  board.innerHTML = state.tasks.map((t) => {
    const agent = agentInfo(t.agentId);
    const selected = t.taskId === state.selectedTaskId ? ' selected' : '';
    return `<article class="task-card${selected}" data-task="${escapeHtml(t.taskId)}" tabindex="0" role="button" aria-label="Select task ${escapeHtml(t.description || t.taskId)}">` +
      `<div class="task-card-top">` +
        `<span class="type-badge">${escapeHtml(t.taskType || 'task')}</span>` +
        `<span class="agent-chip"><span class="chip-icon" style="color:${agent.color}">${agent.icon}</span>${escapeHtml(agent.name)}</span>` +
        phasePill(t) +
      `</div>` +
      `<div class="task-desc">${escapeHtml(t.description || '')}</div>` +
      (t.error ? `<div class="task-error-text">${escapeHtml(t.error)}</div>` : '') +
    `</article>`;
  }).join('');
}

let renderedFeedCount = -1;

function renderFeed() {
  const feed = $('feed');
  if (renderedFeedCount > state.feed.length) {
    feed.innerHTML = '';
    renderedFeedCount = 0;
  }
  if (renderedFeedCount === -1) {
    feed.innerHTML = '';
    renderedFeedCount = 0;
  }
  for (let i = renderedFeedCount; i < state.feed.length; i++) {
    const item = state.feed[i];
    const el = document.createElement('div');
    el.className = `feed-item ${item.kind || ''}`;
    const time = document.createElement('span');
    time.className = 'feed-time';
    time.textContent = clockTime(item.ts);
    el.appendChild(time);
    el.appendChild(document.createTextNode(item.text));
    feed.appendChild(el);
  }
  renderedFeedCount = state.feed.length;
  feed.scrollTop = feed.scrollHeight;
}

function renderTaskSelect() {
  const select = $('task-select');
  const sig = state.tasks.map((t) => t.taskId).join('|');
  if (select.dataset.sig === sig) return;
  select.dataset.sig = sig;
  const prev = state.selectedTaskId;
  select.innerHTML = state.tasks.length
    ? state.tasks.map((t) => {
        const agent = agentInfo(t.agentId);
        const label = `${agent.name}: ${(t.description || t.taskId).slice(0, 60)}`;
        return `<option value="${escapeHtml(t.taskId)}">${escapeHtml(label)}</option>`;
      }).join('')
    : '<option value="">No tasks</option>';
  if (prev && getTask(prev)) select.value = prev;
  else if (state.tasks.length) {
    state.selectedTaskId = state.tasks[0].taskId;
    select.value = state.selectedTaskId;
  }
}

let renderedOutputTask = null;

function renderOutput() {
  renderTaskSelect();
  const pre = $('output-pre');
  const placeholder = $('output-placeholder');
  const select = $('task-select');
  if (state.selectedTaskId && state.selectedTaskId !== select.value) {
    select.value = state.selectedTaskId;
  }
  const task = getTask(state.selectedTaskId);
  if (!task) {
    renderedOutputTask = null;
    pre.textContent = '';
    pre.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }
  if (renderedOutputTask !== task) {
    // full re-render only on selection change; deltas append in flushDeltas
    pre.textContent = task.output;
    renderedOutputTask = task;
    pre.scrollTop = pre.scrollHeight;
  }
  const hasText = task.output.length > 0;
  pre.classList.toggle('hidden', !hasText);
  placeholder.classList.toggle('hidden', hasText);
  if (!hasText) {
    const phase = PHASE_LABEL[task.phase] || '';
    placeholder.textContent = task.status === 'pending'
      ? 'Waiting for this task to start…'
      : `Waiting for output… ${phase}`;
  }
}

function renderFiles() {
  const tbody = $('files-tbody');
  const empty = $('files-empty');
  const files = state.lastRun && Array.isArray(state.lastRun.files)
    ? state.lastRun.files.map(normFile)
    : [];
  if (!files.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    tbody.innerHTML = files.map((f) =>
      `<tr>` +
        `<td>${escapeHtml(f.name)}</td>` +
        `<td class="col-bytes">${escapeHtml(fmtBytes(f.bytes))}</td>` +
        `<td class="col-status">${escapeHtml(f.status || 'written')}</td>` +
      `</tr>`
    ).join('');
  }
  const zip = $('zip-btn');
  if (state.runDir) {
    zip.href = `/api/zip?run=${encodeURIComponent(state.runDir)}`;
    zip.classList.remove('disabled');
    zip.removeAttribute('aria-disabled');
  } else {
    zip.href = '#';
    zip.classList.add('disabled');
    zip.setAttribute('aria-disabled', 'true');
  }
}

function renderTabs() {
  const outBtn = $('tab-output-btn');
  const filesBtn = $('tab-files-btn');
  const isOut = state.tab === 'output';
  outBtn.classList.toggle('active', isOut);
  filesBtn.classList.toggle('active', !isOut);
  outBtn.setAttribute('aria-selected', String(isOut));
  filesBtn.setAttribute('aria-selected', String(!isOut));
  $('output-panel').classList.toggle('hidden', !isOut);
  $('files-panel').classList.toggle('hidden', isOut);
  $('task-select').classList.toggle('hidden', !isOut);
}

/* ---------- connector panel ---------- */

function openPanel(connectorId) {
  state.panelOpen = true;
  state.panelConnectorId = connectorId || null;
  $('connector-panel').classList.add('open');
  $('connector-panel').setAttribute('aria-hidden', 'false');
  $('panel-backdrop').classList.remove('hidden');
  renderPanel();
  renderTopBar();
  if (connectorId) {
    const el = $(`conn-card-${connectorId}`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function closePanel() {
  state.panelOpen = false;
  state.panelConnectorId = null;
  $('connector-panel').classList.remove('open');
  $('connector-panel').setAttribute('aria-hidden', 'true');
  $('panel-backdrop').classList.add('hidden');
  renderTopBar();
}

function connResultHtml(id) {
  const r = state.connectorResults[id];
  if (!r) return '<div class="conn-result">No result yet.</div>';
  return `<div class="conn-result ${r.ok ? 'ok' : 'err'}">${escapeHtml(r.text)}</div>`;
}

function renderPanel() {
  const list = state.connectors.length ? state.connectors : CONNECTOR_FALLBACK;
  $('connector-panel-body').innerHTML = list.map((c) => {
    const s = connectorStatusInfo(c);
    const detail = c.detail ? `<div class="conn-detail">${escapeHtml(c.detail)}</div>` : '';
    const head =
      `<div class="conn-card-head">` +
        `<span class="connector-icon" aria-hidden="true">${c.icon}</span>` +
        `<span class="conn-title">${escapeHtml(c.name)}</span>` +
        `<span class="pill ${s.cls}"><span class="dot"></span><span class="label">${s.label}</span></span>` +
        `<button type="button" class="btn ghost small" data-refresh="${escapeHtml(c.id)}" aria-label="Refresh ${escapeHtml(c.name)} status">Refresh</button>` +
      `</div>` + detail;

    let body = '';
        if (c.id === 'github') {
          body =
            `<div class="conn-form">` +
              `<div class="field-row">` +
                `<input id="gh-token" type="password" class="conn-input" placeholder="GitHub token (ghp_… / github_pat_…)" aria-label="GitHub personal access token">` +
                `<button type="button" class="btn small" data-save-tokens="github">Save token</button>` +
              `</div>` +
              `<div class="field-row">` +
                `<input id="gh-repo" class="conn-input" placeholder="owner/repo name" aria-label="Repository name">` +
                `<label class="check-label"><input type="checkbox" id="gh-private"> Private</label>` +
              `</div>` +
              `<div class="conn-actions">` +
                `<button type="button" class="btn small" data-action="create-repo" data-cid="github">Create repo</button>` +
                `<button type="button" class="btn small" data-action="push-files" data-cid="github">Push files</button>` +
                `<button type="button" class="btn small" data-action="list-repos" data-cid="github">List repos</button>` +
              `</div>` +
            `</div>` +
            connResultHtml('github') +
            `<div id="gh-repos" class="repo-list"></div>`;
        } else if (c.id === 'google-drive') {
          body =
            `<div class="conn-form">` +
              `<div class="field-row">` +
                `<input id="gd-client-id" type="password" class="conn-input" placeholder="OAuth client ID" aria-label="Google OAuth client ID">` +
              `</div>` +
              `<div class="field-row">` +
                `<input id="gd-client-secret" type="password" class="conn-input" placeholder="OAuth client secret" aria-label="Google OAuth client secret">` +
              `</div>` +
              `<div class="field-row">` +
                `<input id="gd-refresh" type="password" class="conn-input" placeholder="Refresh token" aria-label="Google OAuth refresh token">` +
                `<button type="button" class="btn small" data-save-tokens="drive">Save credentials</button>` +
              `</div>` +
              `<div class="field-row">` +
                `<input id="gd-folder" class="conn-input" placeholder="folderId (optional)" aria-label="Google Drive folder ID">` +
              `</div>` +
              `<div class="conn-actions">` +
                `<button type="button" class="btn small" data-action="upload-files" data-cid="google-drive">Upload files</button>` +
              `</div>` +
            `</div>` +
            connResultHtml('google-drive');
        } else if (c.id === 'webhook') {
      body =
        `<div class="conn-form">` +
          `<input id="wh-url" class="conn-input" placeholder="https://example.com/hook" aria-label="Webhook URL">` +
          `<textarea id="wh-payload" class="conn-input" placeholder='payload JSON (optional — defaults to run summary)' aria-label="Webhook payload"></textarea>` +
          `<div class="conn-actions">` +
            `<button type="button" class="btn small" data-action="send" data-cid="webhook">Send</button>` +
          `</div>` +
        `</div>` +
        connResultHtml('webhook');
    }
    return `<div class="conn-card" id="conn-card-${escapeHtml(c.id)}">${head}${body}</div>`;
  }).join('');

  renderRepoList();
}

function renderRepoList() {
  const box = $('gh-repos');
  if (!box) return;
  const r = state.connectorResults.github;
  if (!r || !r.ok || !Array.isArray(r.repos)) return;
  box.innerHTML = r.repos.map((repo) =>
    `<a href="${escapeHtml(repo.html_url || '#')}" target="_blank" rel="noopener">${escapeHtml(repo.full_name || repo)}` +
    `${repo.private ? ' <span class="repo-private">private</span>' : ''}</a>`
  ).join('');
}

function summarizeConnectorResult(action, result) {
  if (!result) return `${action}: ok`;
  if (action === 'list-repos' && Array.isArray(result.repos)) {
    return `Found ${result.repos.length} repos`;
  }
  if (action === 'push-files' && Array.isArray(result.pushed)) {
    return `Pushed ${result.pushed.length} files to ${result.repo || 'repo'}`;
  }
  if (action === 'upload-files' && Array.isArray(result.uploaded)) {
    return `Uploaded ${result.uploaded.length} files to Drive`;
  }
  if (action === 'create-repo' && result.repo) {
    return `Created ${result.repo.full_name || result.repo.html_url || ''}`;
  }
  if (action === 'send') {
    return `Webhook status ${result.status}`;
  }
  try { return JSON.stringify(result); } catch { return `${action}: ok`; }
}

function connectorFeedMessage(id, action) {
  if (id === 'github' && action === 'push-files') return 'Pushed to GitHub';
  if (id === 'github' && action === 'create-repo') return 'GitHub repo created';
  if (id === 'google-drive' && action === 'upload-files') return 'Uploaded to Drive';
  if (id === 'webhook' && action === 'send') return 'Webhook sent';
  return null;
}

/* ---------- api ---------- */

async function postJSON(url, body) {
  const opts = { method: 'POST' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function connectorAction(id, action, args = {}) {
  try {
    return await postJSON(`/api/connectors/${id}/action`, { action, ...args });
  } catch (err) {
    state.connectorResults[id] = { ok: false, text: err.message };
    toast(`${id}: ${err.message}`, 'error');
    pushFeed(`${id}: ${err.message}`, 'bad');
    if (state.panelOpen) renderPanel();
    return null;
  }
}

async function saveTokens(kind) {
  let tokens = {};
  if (kind === 'github') {
    const v = ($('gh-token')?.value || '').trim();
    if (!v) { toast('Paste a GitHub token first', 'error'); return; }
    tokens = { github: v };
  } else if (kind === 'drive') {
    const id = ($('gd-client-id')?.value || '').trim();
    const secret = ($('gd-client-secret')?.value || '').trim();
    const refresh = ($('gd-refresh')?.value || '').trim();
    if (!id || !secret || !refresh) { toast('Fill all three Drive fields', 'error'); return; }
    tokens = { googleClientId: id, googleClientSecret: secret, googleRefreshToken: refresh };
  } else {
    return;
  }
  try {
    const out = await postJSON('/api/connector-tokens', { tokens });
    // Clear the secret inputs immediately after a successful save.
    for (const el of document.querySelectorAll('#gh-token, #gd-client-id, #gd-client-secret, #gd-refresh')) el.value = '';
    const summary = (out.connectors || []).map((c) => `${c.id}: ${c.status}`).join(', ');
    toast(`Saved. ${summary}`, 'good');
    pushFeed(`${kind === 'github' ? 'GitHub' : 'Google Drive'} credentials saved`, 'good');
    await loadConnectors();
    if (state.panelOpen) renderPanel();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
}

async function refreshConnector(id) {
  try {
    const status = await postJSON(`/api/connectors/${id}/refresh`);
    if (status && status.id) {
      const idx = state.connectors.findIndex((c) => c.id === id);
      if (idx >= 0) state.connectors[idx] = status;
      else state.connectors.push(status);
      renderConnectors();
      if (state.panelOpen) renderPanel();
    }
    return status;
  } catch (err) {
    toast(`Refresh failed: ${err.message}`, 'error');
    return null;
  }
}

async function loadConnectors() {
  try {
    const list = await getJSON('/api/connectors');
    if (Array.isArray(list) && list.length) {
      state.connectors = list;
      renderConnectors();
      if (state.panelOpen) renderPanel();
    }
  } catch { /* keep fallback rows */ }
}

async function resolveRunDir() {
  try {
    const runs = await getJSON('/api/runs');
    if (Array.isArray(runs) && runs.length) {
      const latest = runs[0];
      if (!state.runDir && latest.dir) state.runDir = latest.dir;
      if (!state.lastRun) {
        state.lastRun = {
          ok: true,
          files: (latest.files || []).map((n) => ({ name: n, bytes: null, status: '' })),
          zipPath: latest.zip || null,
          error: null,
          tasks: [],
        };
        renderFiles();
      } else if (state.lastRun.files && state.lastRun.files.length) {
        // enrich string-only file lists with names from runs if needed
        renderFiles();
      }
      renderFiles();
    }
  } catch { /* runs endpoint unavailable */ }
}

async function loadInitialState() {
  try {
    const s = await getJSON('/api/state');
    applyServerState(s);
    renderTopBar();
    renderChips();
    renderAgents();
    renderProviders();
    renderConnectors();
    renderFiles();
  } catch (err) {
    toast(`State load failed: ${err.message}`, 'error');
  }
  await loadConnectors();
  await resolveRunDir();
}

/* ---------- run / cancel ---------- */

async function startRun() {
  const goal = $('goal').value.trim();
  if (!goal) {
    toast('Enter a goal first', 'error');
    $('goal').focus();
    return;
  }
  if (!state.selected.length) {
    toast('Select at least one agent', 'error');
    return;
  }
  // reset run view
  state.tasks = [];
  state.selectedTaskId = null;
  renderedOutputTask = null;
  renderedFeedCount = 0;
  $('feed').innerHTML = '';
  state.feed = [];
  state.lastRun = null;
  state.runDir = null;
  readingTimers.forEach((t) => clearTimeout(t));
  readingTimers.clear();
  renderTasks();
  renderOutput();
  renderFiles();

  try {
    await postJSON('/api/run', { goal, agents: state.selected });
    state.running = true;
    state.status = 'running';
    pushFeed(`Run started: ${goal.slice(0, 100)}`, 'accent');
    renderTopBar();
  } catch (err) {
    toast(`Run failed: ${err.message}`, 'error');
  }
}

async function cancelRun() {
  try {
    await postJSON('/api/cancel');
    state.running = false;
    state.status = 'idle';
    pushFeed('Cancelled by user', 'bad');
    renderTopBar();
    renderTasks();
  } catch (err) {
    toast(`Cancel failed: ${err.message}`, 'error');
  }
}

/* ---------- events: UI wiring ---------- */

function selectTask(taskId) {
  if (!getTask(taskId)) return;
  state.selectedTaskId = taskId;
  renderedOutputTask = null;
  state.tab = 'output';
  renderTabs();
  renderTasks();
  renderOutput();
}

function bindUI() {
  $('run-btn').addEventListener('click', startRun);
  $('cancel-btn').addEventListener('click', cancelRun);

  $('goal').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      startRun();
    }
  });

  $('agent-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.agent;
    if (state.selected.includes(id)) {
      if (state.selected.length === 1) return; // keep at least one
      state.selected = state.selected.filter((a) => a !== id);
    } else {
      state.selected.push(id);
    }
    renderChips();
  });

  $('task-board').addEventListener('click', (e) => {
    const card = e.target.closest('.task-card');
    if (card) selectTask(card.dataset.task);
  });
  $('task-board').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.task-card');
    if (card) {
      e.preventDefault();
      selectTask(card.dataset.task);
    }
  });

  $('task-select').addEventListener('change', () => selectTask($('task-select').value));

  $('tab-output-btn').addEventListener('click', () => { state.tab = 'output'; renderTabs(); });
  $('tab-files-btn').addEventListener('click', () => { state.tab = 'files'; renderTabs(); });

  $('connector-list').addEventListener('click', (e) => {
    const row = e.target.closest('.connector-row');
    if (row) openPanel(row.dataset.connector);
  });

  $('connectors-toggle').addEventListener('click', () => {
    if (state.panelOpen) closePanel();
    else openPanel(null);
  });
  $('provider-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-provider]');
    if (!row) return;
    toast('Install the Cookie Bridge extension: chrome://extensions → Developer mode → Load unpacked → extension/ folder. It auto-captures provider cookies.', 'info');
  });
  $('connector-panel-close').addEventListener('click', closePanel);
  $('panel-backdrop').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.panelOpen) closePanel();
  });

  $('connector-panel-body').addEventListener('click', async (e) => {
      const saveBtn = e.target.closest('[data-save-tokens]');
      if (saveBtn) {
        saveBtn.disabled = true;
        await saveTokens(saveBtn.dataset.saveTokens);
        saveBtn.disabled = false;
        return;
      }
      const refreshBtn = e.target.closest('[data-refresh]');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      await refreshConnector(refreshBtn.dataset.refresh);
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const cid = btn.dataset.cid;
    const action = btn.dataset.action;
    btn.disabled = true;
    try {
      let args = {};
      if (cid === 'github') {
        if (action === 'create-repo') {
          const name = ($('gh-repo')?.value || '').trim();
          if (!name) { toast('Enter a repo name', 'error'); btn.disabled = false; return; }
          args = { name, private: !!$('gh-private')?.checked };
        } else if (action === 'push-files') {
          const repo = ($('gh-repo')?.value || '').trim();
          if (!repo) { toast('Enter a repo (owner/name) to push to', 'error'); btn.disabled = false; return; }
          args = { repo };
        }
      } else if (cid === 'google-drive' && action === 'upload-files') {
        const folderId = ($('gd-folder')?.value || '').trim();
        if (folderId) args = { folderId };
      } else if (cid === 'webhook' && action === 'send') {
        const url = ($('wh-url')?.value || '').trim();
        if (!url) { toast('Enter a webhook URL', 'error'); btn.disabled = false; return; }
        args = { url };
        const payload = ($('wh-payload')?.value || '').trim();
        if (payload) {
          try { args.payload = JSON.parse(payload); }
          catch { toast('Payload must be valid JSON', 'error'); btn.disabled = false; return; }
        }
      }
      const result = await connectorAction(cid, action, args);
      if (result) {
        state.connectorResults[cid] = {
          ok: true,
          text: summarizeConnectorResult(action, result),
          repos: action === 'list-repos' ? (result.repos || []) : undefined,
        };
        renderPanel();
      }
    } finally {
      btn.disabled = false;
    }
  });

  // Files-tab quick actions
  $('qa-push-btn').addEventListener('click', async () => {
    const repo = $('qa-repo').value.trim();
    if (!repo) { toast('Enter a repo (owner/name) first', 'error'); $('qa-repo').focus(); return; }
    $('qa-push-btn').disabled = true;
    try {
      const result = await connectorAction('github', 'push-files', { repo });
      if (result) toast(summarizeConnectorResult('push-files', result), 'good');
    } finally {
      $('qa-push-btn').disabled = false;
    }
  });

  $('qa-drive-btn').addEventListener('click', async () => {
    $('qa-drive-btn').disabled = true;
    try {
      const result = await connectorAction('google-drive', 'upload-files', {});
      if (result) toast(summarizeConnectorResult('upload-files', result), 'good');
    } finally {
      $('qa-drive-btn').disabled = false;
    }
  });

  $('zip-btn').addEventListener('click', (e) => {
    if (!state.runDir) { e.preventDefault(); toast('No run directory yet', 'error'); }
  });

  // mobile sidebar
  $('menu-btn').addEventListener('click', () => {
    const open = $('sidebar').classList.toggle('open');
    $('menu-btn').setAttribute('aria-expanded', String(open));
  });
}

/* ---------- SSE ---------- */

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }
    reducer(data);
  };
  es.onerror = () => {
    // EventSource reconnects automatically; hello event re-syncs state.
  };
  return es;
}

/* ---------- init ---------- */

function init() {
  renderAll();
  renderTabs();
  bindUI();
  loadInitialState();
  connectEvents();
}

init();
