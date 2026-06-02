const $ = (id) => document.getElementById(id);
let isRunning = false;
const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 620;

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
  $('ds-result').innerHTML = '<span class="placeholder">Waiting...</span>';
  $('gpt-result').innerHTML = '<span class="placeholder">Waiting...</span>';
  $('loop-results').innerHTML = '';
  $('copy-btn').style.display = 'none';

  await saveForm();
  startPoll();
  const task = $('task').value.trim() || 'Execute the task below. Do not ask questions or offer options \u2014 just produce the output directly:';
  const loopCount = getLoopCount();

  chrome.runtime.sendMessage({
    action: 'run', prompt, task, loopCount,
    manualDS: $('use-ds-url').classList.contains('active') ? $('ds-url').value.trim() : '',
    manualGPT: $('use-gpt-url').classList.contains('active') ? $('gpt-url').value.trim() : '',
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
  $('ds-result').innerHTML = '<span class="placeholder">Waiting...</span>';
  $('gpt-result').innerHTML = '<span class="placeholder">Waiting...</span>';
  $('loop-results').innerHTML = '';
  $('copy-btn').style.display = 'none';
  saveForm();
});

$('open-multi').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('multi-agent.html') });
});

$('clear-conv').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearConvHistory' }).catch(() => {});
  $('conv-list').innerHTML = '<div style="color:#4a4e62;font-size:12px;padding:4px 0;">No saved conversations</div>';
});

function resetUI() {
  $('run').disabled = false;
  $('run').textContent = '\u25b6 Run';
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
    case 'error': return 'Error: ' + readableError(s.error);
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
    html += `<div class="feedback-card">
      <div class="loop-num">Feedback Loop ${i + 1}</div>
      <div class="fb-section">
        <div class="fb-label">Critique</div>
        <div class="fb-text">${escapeHtml(s.critiques[i] || 'Waiting...')}</div>
      </div>`;
    if (s.improvements && s.improvements[i]) {
      html += `<div class="fb-section">
        <div class="fb-label">Improved Output</div>
        <div class="fb-text">${escapeHtml(s.improvements[i])}</div>
      </div>`;
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
      list.innerHTML = '<div style="color:#4a4e62;font-size:12px;padding:4px 0;">No saved conversations</div>';
      return;
    }
    list.innerHTML = history.map((c) => `
      <div class="conv-item" data-url="${escapeAttr(c.url)}" data-type="${escapeAttr(c.type)}">
        <span class="type ${c.type === 'deepseek' ? 'ds' : 'gpt'}">${c.type === 'deepseek' ? 'DS' : 'GPT'}</span>
        <span class="label" title="${escapeAttr(c.url)}">${escapeHtml(c.label)}</span>
      </div>
    `).join('');

    list.querySelectorAll('.conv-item').forEach(item => {
      item.addEventListener('click', () => {
        const url = item.dataset.url;
        if (item.dataset.type === 'deepseek') {
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

function clampSidebarWidth(width) {
  const viewportMax = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(window.innerWidth * 0.58)));
  return Math.max(SIDEBAR_MIN, Math.min(viewportMax, Math.round(width)));
}

async function restoreSidebarWidth() {
  try {
    const { sidebarWidth } = await chrome.storage.local.get('sidebarWidth');
    if (sidebarWidth) {
      document.documentElement.style.setProperty('--sidebar-width', `${clampSidebarWidth(sidebarWidth)}px`);
    }
  } catch {
    // Width persistence is optional, so preview contexts can ignore storage errors.
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

function setupSidebarResize() {
  const app = document.querySelector('.app');
  const sidebar = document.querySelector('.sidebar');
  const resizer = $('sidebar-resizer');
  if (!app || !sidebar || !resizer) return;

  let startX = 0;
  let startWidth = 0;

  const setWidth = (width) => {
    const nextWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--sidebar-width', `${nextWidth}px`);
    return nextWidth;
  };

  const onResize = (event) => {
    setWidth(startWidth + event.clientX - startX);
  };

  const stopResize = async () => {
    if (!app.classList.contains('resizing')) return;
    app.classList.remove('resizing');
    document.removeEventListener('pointermove', onResize);
    document.removeEventListener('pointerup', stopResize);
    try {
      const width = parseInt(getComputedStyle(sidebar).width, 10);
      if (width) await chrome.storage.local.set({ sidebarWidth: width });
    } catch {
      // Ignore storage errors in non-extension preview contexts.
    }
  };

  resizer.addEventListener('pointerdown', (event) => {
    if (window.innerWidth <= 1040) return;
    startX = event.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    app.classList.add('resizing');
    try {
      if (typeof event.pointerId === 'number' && resizer.setPointerCapture) {
        resizer.setPointerCapture(event.pointerId);
      }
    } catch {
      // Pointer capture is helpful but not required for resizing.
    }
    document.addEventListener('pointermove', onResize);
    document.addEventListener('pointerup', stopResize);
  });

  window.addEventListener('resize', () => {
    setWidth(sidebar.getBoundingClientRect().width);
  });
}

async function init() {
  await clearLegacyTabIdError();
  restoreForm();
  restoreSidebarWidth();
  setupSidebarResize();
  fetchState();
  startPoll();
  loadConvHistory();
}

init();
