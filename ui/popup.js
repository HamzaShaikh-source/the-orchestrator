const $ = (id) => document.getElementById(id);
let isRunning = false;

async function saveForm() {
  await chrome.storage.session.set({
    form: { prompt: $('input').value, task: $('task').value }
  });
}

async function restoreForm() {
  const { form } = await chrome.storage.session.get('form');
  if (form) {
    if (form.prompt) $('input').value = form.prompt;
    if (form.task) $('task').value = form.task;
  }
}

function getLoopCount() {
  return Math.max(0, Math.min(10, parseInt($('loop-count').value) || 3));
}

$('run').addEventListener('click', async () => {
  if (isRunning) return;
  const prompt = $('input').value.trim();
  if (!prompt) {
    $('status-text').textContent = 'Enter a prompt to start';
    $('status-dot').className = 'error';
    $('input').focus();
    return;
  }

  isRunning = true;
  $('run').disabled = true;
  $('stop-btn').classList.remove('hidden');
  $('ds-result').innerHTML = '<span class="spinner"></span><span class="placeholder">Waiting...</span>';
  $('gpt-result').innerHTML = '<span class="spinner"></span><span class="placeholder">Waiting...</span>';
  $('loop-results').innerHTML = '';
  $('copy-btn').style.display = 'none';

  await saveForm();
  startPoll();
  const task = $('task').value.trim() || 'Execute the task below. Do not ask questions or offer options \u2014 just produce the output directly:';
  const loopCount = getLoopCount();
  const manualDS = $('ds-url').value.trim();
  const manualGPT = $('gpt-url').value.trim();

  chrome.runtime.sendMessage({
    action: 'run', prompt, task, loopCount,
    manualDS: $('use-ds-url').classList.contains('active') ? manualDS : '',
    manualGPT: $('use-gpt-url').classList.contains('active') ? manualGPT : '',
  });
});

$('use-ds-url').addEventListener('click', () => {
  $('use-ds-url').classList.toggle('active');
  $('use-ds-url').textContent = $('use-ds-url').classList.contains('active') ? 'Using' : 'Use';
});
$('use-gpt-url').addEventListener('click', () => {
  $('use-gpt-url').classList.toggle('active');
  $('use-gpt-url').textContent = $('use-gpt-url').classList.contains('active') ? 'Using' : 'Use';
});

$('stop-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stop' }).catch(() => {});
  $('stop-btn').classList.add('hidden');
  resetUI();
  $('status-text').textContent = 'Cancelled';
  $('status-dot').className = 'error';
  $('ds-result').innerHTML = '<span class="placeholder">Cancelled</span>';
  $('gpt-result').innerHTML = '<span class="placeholder">Cancelled</span>';
});

$('clear-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearState' }).catch(() => {});
  $('input').value = '';
  $('task').value = 'Execute the task below. Do not ask questions or offer options \u2014 just produce the output directly:';
  $('ds-url').value = '';
  $('gpt-url').value = '';
  $('use-ds-url').classList.remove('active');
  $('use-ds-url').textContent = 'Use';
  $('use-gpt-url').classList.remove('active');
  $('use-gpt-url').textContent = 'Use';
  $('ds-result').innerHTML = '<span class="spinner"></span><span class="placeholder">Waiting...</span>';
  $('gpt-result').innerHTML = '<span class="spinner"></span><span class="placeholder">Waiting...</span>';
  $('loop-results').innerHTML = '';
  $('copy-btn').style.display = 'none';
  saveForm();
});

$('open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

$('open-multi').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('multi-agent.html') });
});

$('clear-conv').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearConvHistory' }).catch(() => {});
  $('conv-list').innerHTML = '<span style="color:#5a5e72;font-size:11px;">No saved conversations</span>';
});

function resetUI() {
  $('run').disabled = false;
  $('run').textContent = '\u25b6 Run Pipeline';
  $('stop-btn').classList.add('hidden');
  isRunning = false;
  stopPoll();
}

let pollTimer;

function startPoll() {
  stopPoll();
  pollTimer = setInterval(fetchState, 800);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function fetchState() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ action: 'status' });
  } catch { return; }
  if (!s) return;
  render(s);
}

function statusText(s) {
  if (s.step === 'deepseek-wait' && s.loopPhase === 'critique') return `Loop ${s.loopIndex}: DeepSeek critiquing...`;
  if (s.step === 'deepseek-wait' && s.loopPhase === 'critique-done') return `Loop ${s.loopIndex}: DeepSeek critique done`;
  if (s.step === 'chatgpt-wait' && s.loopPhase === 'improve') return `Loop ${s.loopIndex}: ChatGPT improving...`;
  if (s.step === 'chatgpt-wait' && s.loopPhase === 'improve-done') return `Loop ${s.loopIndex}: ChatGPT improved`;
  switch (s.step) {
    case 'idle': return 'Ready';
    case 'deepseek-open': return 'Opening DeepSeek...';
    case 'deepseek-inject': return 'Sending to DeepSeek...';
    case 'deepseek-wait': return 'Waiting for DeepSeek...';
    case 'chatgpt-open': return 'Opening ChatGPT...';
    case 'chatgpt-inject': return 'Sending to ChatGPT...';
    case 'chatgpt-wait': return 'Waiting for ChatGPT...';
    case 'done': return 'Complete!';
    case 'error': return '\u26A0 Error: ' + readableError(s.error);
    case 'cancelled': return 'Cancelled';
    default: return s.step;
  }
}

function readableError(error) {
  const message = String(error || 'unknown');
  if (message.includes("reading 'id'") || message.includes('reading "id"')) {
    return 'Could not open an automation tab. Reload the extension and try again.';
  }
  return message;
}

function statusDot(s) {
  if (s.step === 'done') return 'done';
  if (s.step === 'error' || s.step === 'cancelled') return 'error';
  return 'running';
}

function render(s) {
  const dot = $('status-dot');
  const text = $('status-text');
  dot.className = statusDot(s);
  text.textContent = statusText(s);

  if (s.deepseekResponse) $('ds-result').textContent = s.deepseekResponse;
  if (s.chatgptResponse) {
    $('gpt-result').textContent = s.chatgptResponse;
    $('copy-btn').style.display = 'block';
  }

  if (s.deepseekUrl && !$('ds-url').value) $('ds-url').value = s.deepseekUrl;
  if (s.chatgptUrl && !$('gpt-url').value) $('gpt-url').value = s.chatgptUrl;

  renderLoopResults(s);

  if (s.step === 'done' || s.step === 'error' || s.step === 'cancelled') {
    resetUI();
    loadConvHistory();
  }
}

function renderLoopResults(s) {
  const container = $('loop-results');
  if (!s.critiques || s.critiques.length === 0) return;

  let html = '';
  for (let i = 0; i < s.critiques.length; i++) {
    html += `<div class="loop-box">
      <div class="loop-header">Feedback Loop ${i + 1}</div>
      <div class="sub">Critique:</div>
      <div class="sub-content">${escapeHtml(s.critiques[i] || 'Waiting...')}</div>`;
    if (s.improvements && s.improvements[i]) {
      html += `<div class="sub">Improved:</div>
      <div class="sub-content">${escapeHtml(s.improvements[i])}</div>`;
    }
    html += `</div>`;
  }
  container.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

$('copy-btn').addEventListener('click', () => {
  const text = $('gpt-result').textContent;
  navigator.clipboard.writeText(text).then(() => {
    $('copy-btn').textContent = 'Copied';
    setTimeout(() => { $('copy-btn').textContent = 'Copy'; }, 1200);
  }).catch(() => {});
});

async function loadConvHistory() {
  try {
    const history = await chrome.runtime.sendMessage({ action: 'getConvHistory' });
    const list = $('conv-list');
    if (!history || history.length === 0) {
      list.innerHTML = '<span style="color:#5a5e72;font-size:11px;">No saved conversations</span>';
      return;
    }
    list.innerHTML = history.map((c, i) => `
      <div class="conv-item">
        <span class="type ${c.type === 'deepseek' ? 'ds' : 'gpt'}">${c.type === 'deepseek' ? 'DS' : 'GPT'}</span>
        <span class="url-text" title="${escapeAttr(c.url)}">${escapeHtml(c.label)}</span>
        <button class="load-btn" data-url="${escapeAttr(c.url)}" data-idx="${i}">Load</button>
      </div>
    `).join('');

    list.querySelectorAll('.load-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        if (url.includes('deepseek')) {
          $('ds-url').value = url;
          $('use-ds-url').classList.add('active');
          $('use-ds-url').textContent = 'Using';
        } else {
          $('gpt-url').value = url;
          $('use-gpt-url').classList.add('active');
          $('use-gpt-url').textContent = 'Using';
        }
      });
    });
  } catch (e) {
    console.error('Failed to load conv history:', e);
  }
}

async function clearLegacyTabIdError() {
  try {
    const { state } = await chrome.storage.session.get('state');
    const error = String(state?.error || '');
    if (state?.step === 'error' && (error.includes("reading 'id'") || error.includes('reading "id"'))) {
      await chrome.storage.session.set({
        state: {
          ...state,
          step: 'idle',
          error: null,
        }
      });
    }
  } catch {
    // Ignore cleanup errors; normal status polling will still run.
  }
}

function loadTheme() {
  const theme = localStorage.getItem('theme');
  if (theme === 'light') {
    document.body.classList.add('light');
    $('theme-toggle').textContent = '\u2600';
  }
}

function toggleTheme() {
  document.body.classList.toggle('light');
  const isLight = document.body.classList.contains('light');
  $('theme-toggle').textContent = isLight ? '\u2600' : '\u264E';
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

async function init() {
  await clearLegacyTabIdError();
  restoreForm();
  fetchState();
  startPoll();
  loadConvHistory();
  loadTheme();
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('input').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); $('run').click(); }
  });
  $('input').focus();
}

init();
