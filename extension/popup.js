const STATUS_LABELS = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
};

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'no-response' });
    });
  });
}

function renderServerPill(reachable) {
  const pill = document.getElementById('server-pill');
  const text = document.getElementById('server-pill-text');
  pill.classList.remove('pill-green', 'pill-red', 'pill-gray');
  if (reachable) {
    pill.classList.add('pill-green');
    text.textContent = 'Connected';
  } else {
    pill.classList.add('pill-red');
    text.textContent = 'Offline';
  }
}

function renderProvider(provider) {
  const el = document.getElementById(`status-${provider.id}`);
  if (!el) return;
  el.classList.remove('status-green', 'status-amber', 'status-gray');
  if (!provider.loggedIn) {
    el.textContent = 'Not logged in';
    el.classList.add('status-gray');
  } else if (provider.sent) {
    el.textContent = 'Logged in · Sent';
    el.classList.add('status-green');
  } else {
    el.textContent = 'Logged in · Not sent';
    el.classList.add('status-amber');
  }
}

async function refresh() {
  const status = await sendMessage({ type: 'status' });
  if (!status.ok) return;
  renderServerPill(Boolean(status.serverReachable));
  (status.providers || []).forEach(renderProvider);
  const input = document.getElementById('server-url-input');
  if (status.serverUrl && document.activeElement !== input) {
    input.value = status.serverUrl;
  }
}

async function onCaptureClick() {
  const btn = document.getElementById('capture-btn');
  btn.disabled = true;
  btn.textContent = 'Capturing…';
  const res = await sendMessage({ type: 'capture' });
  btn.disabled = false;
  btn.textContent = 'Capture & send now';
  if (res.ok) {
    await refresh();
  }
}

async function onDashboardClick() {
  const status = await sendMessage({ type: 'status' });
  const base = (status && status.serverUrl) || 'http://127.0.0.1:3000';
  chrome.tabs.create({ url: `${base.replace(/\/+$/, '')}/` });
}

function onServerUrlChange() {
  const input = document.getElementById('server-url-input');
  const url = input.value.trim();
  if (!/^https?:\/\//.test(url)) {
    input.style.borderColor = '#f44336';
    return;
  }
  input.style.borderColor = '';
  sendMessage({ type: 'set-server-url', url });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.row').forEach((row) => {
    row.addEventListener('click', () => {
      chrome.tabs.create({ url: row.dataset.url });
    });
  });
  document.getElementById('capture-btn').addEventListener('click', onCaptureClick);
  document.getElementById('dashboard-btn').addEventListener('click', onDashboardClick);
  document.getElementById('server-url-input').addEventListener('change', onServerUrlChange);
  refresh();
});
