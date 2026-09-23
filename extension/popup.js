/* popup.js — The Orchestrator popup: provider login status + open dashboard. */

const PROVIDERS = [
  { id: 'chatgpt', domain: 'chatgpt.com' },
  { id: 'gemini', domain: 'google.com' },
  { id: 'perplexity', domain: 'perplexity.ai' },
];

function setStatus(id, text, cls) {
  const el = document.getElementById(`status-${id}`);
  if (el) {
    el.textContent = text;
    el.className = `status ${cls || ''}`.trim();
  }
}

async function refresh() {
  document.getElementById('status-pill-text').textContent = 'Checking…';
  for (const p of PROVIDERS) setStatus(p.id, '…', '');

  try {
    const cookies = await chrome.cookies.getAll({});
    for (const p of PROVIDERS) {
      const count = cookies.filter((c) => c.domain.includes(p.domain) && typeof c.value === 'string' && c.value.length > 0).length;
      setStatus(p.id, count > 0 ? 'Logged in' : 'Not logged in', count > 0 ? 'status-green' : 'status-amber');
    }
    document.getElementById('status-pill-text').textContent = 'Ready';
    document.getElementById('status-pill').className = 'pill pill-green';
  } catch (err) {
    document.getElementById('status-pill-text').textContent = 'Error';
    document.getElementById('status-pill').className = 'pill pill-red';
    for (const p of PROVIDERS) setStatus(p.id, '?', 'status-amber');
  }
}

document.getElementById('dashboard-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

refresh();