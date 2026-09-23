/* background.js — The Orchestrator service worker (MV3 module).
   Fully self-contained: runs the multi-agent pipeline in-browser using the
   user's real session cookies (fetch + credentials:'include' + host_permissions).
   No node, no python, no npm, no external server. */

import { providers, chat, ProviderError } from './core/providers.js';
import { runPipeline, slugify } from './core/orchestrator.js';
import { zipFiles } from './core/zip.js';
import { ChromeStore } from './core/store.js';
import { listConnectorStatuses, connectorStatus, runConnectorAction } from './core/connectors.js';

const store = new ChromeStore('local');

function log(...args) {
  console.log('[Orchestrator]', ...args);
}

/* ── Run state ── */
let activeRun = null; // { controller, port, goal, startedAt }

function emit(port, event) {
  try {
    if (port && port.postMessage) port.postMessage({ type: 'event', event });
  } catch {
    /* port closed */
  }
}

async function handleRun(port, msg) {
  if (activeRun) {
    emit(port, { type: 'event', event: { type: 'error', message: 'A run is already in progress.' } });
    return;
  }
  const goal = String(msg.goal || '').trim();
  if (!goal) {
    emit(port, { type: 'event', event: { type: 'error', message: 'Goal is required.' } });
    return;
  }

  const controller = new AbortController();
  activeRun = { controller, port, goal, startedAt: Date.now() };
  log('run start:', goal.slice(0, 100));

  const keepalive = setInterval(() => {
    try { port.postMessage({ type: 'ping' }); } catch { /* closed */ }
  }, 15000);

  try {
    const result = await runPipeline({
      goal,
      selectedAgents: Array.isArray(msg.selectedAgents) && msg.selectedAgents.length ? msg.selectedAgents : null,
      projectFiles: msg.projectFiles || {},
      autoConfirm: msg.autoConfirm !== false,
      runSettings: { signal: controller.signal, retries: msg.retries ?? 2, maxAgents: msg.maxAgents ?? 4 },
      onEvent: (event) => emit(port, event),
      client: { providers, chat },
      store,
    });

    if (result.ok && result.files && result.files.length) {
      emit(port, { type: 'event', event: { type: 'files-ready', files: result.files.map((f) => f.name), zipName: result.zipName } });
    }
    const summary = summarizeResult(result);
    await store.set('lastRun', { ...summary, files: result.files || [], zipName: result.zipName || null });
    emit(port, { type: 'done', result: summary });
  } catch (err) {
    log('run failed:', err?.message || err);
    emit(port, { type: 'done', result: { ok: false, error: err?.message || String(err), step: 'error' } });
  } finally {
    clearInterval(keepalive);
    activeRun = null;
  }
}

function summarizeResult(result) {
  if (!result) return { ok: false, error: 'No result' };
  const taskCount = (result.tasks || []).length;
  const doneCount = (result.tasks || []).filter((t) => t.status === 'done').length;
  const fileCount = (result.files || []).length;
  return {
    ok: result.ok,
    error: result.error || null,
    step: result.step || null,
    taskCount,
    doneCount,
    fileCount,
    zipName: result.zipName || null,
    files: (result.files || []).map((f) => f.name),
    conflicts: result.conflicts || [],
    selectedAgents: result.selectedAgents || [],
    synthesis: result.synthesis ? String(result.synthesis).slice(0, 2000) : '',
  };
}

async function handleDownloadZip(port, msg) {
  try {
    const lastRun = await store.get('lastRun', null);
    const files = (lastRun && lastRun.files) || [];
    if (!files.length) {
      emit(port, { type: 'done', result: { ok: false, error: 'No files from the last run.' } });
      return;
    }
    const zipName = (lastRun && lastRun.zipName) || `orchestrator-${Date.now()}.zip`;
    const blob = await zipFiles(files.map((f) => ({ name: f.name, content: f.content })));
    const url = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url, filename: zipName, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    emit(port, { type: 'done', result: { ok: true, downloadId: id, zipName } });
  } catch (err) {
    emit(port, { type: 'done', result: { ok: false, error: `Download failed: ${err?.message || err}` } });
  }
}

async function handleState(port) {
  const lastRun = await store.get('lastRun', null);
  const chats = await store.get('multiAgentChats', []);
  const connectorTokens = await store.get('connectorTokens', {});
  const hasTokens = {
    github: Boolean(connectorTokens.github),
    googleDrive: Boolean(connectorTokens.googleClientId && connectorTokens.googleClientSecret && connectorTokens.googleRefreshToken),
  };
  port.postMessage({
    type: 'state',
    state: {
      running: Boolean(activeRun),
      goal: activeRun ? activeRun.goal : null,
      startedAt: activeRun ? activeRun.startedAt : null,
      lastRun: lastRun ? summarizeResult(lastRun) : null,
      chats: Array.isArray(chats) ? chats.slice(0, 20).map((c) => ({ id: c.id, title: c.title, status: c.status, timestamp: c.timestamp })) : [],
      hasTokens,
    },
  });
}

async function handleProviders(port) {
  try {
    const list = await providers();
    port.postMessage({ type: 'providers', providers: list });
  } catch (err) {
    port.postMessage({ type: 'providers', providers: [], error: err?.message || String(err) });
  }
}

async function handleConnectors(port) {
  try {
    const list = await listConnectorStatuses({ store });
    port.postMessage({ type: 'connectors', connectors: list });
  } catch (err) {
    port.postMessage({ type: 'connectors', connectors: [], error: err?.message || String(err) });
  }
}

async function handleConnectorAction(port, msg) {
  try {
    const lastRun = await store.get('lastRun', null);
    const result = await runConnectorAction(msg.id, msg.action, msg.args || {}, {
      store,
      lastRunFiles: (lastRun && lastRun.files) || [],
    });
    port.postMessage({ type: 'connector-result', id: msg.id, action: msg.action, result });
  } catch (err) {
    port.postMessage({ type: 'connector-result', id: msg.id, action: msg.action, result: { ok: false, error: err?.message || String(err) } });
  }
}

async function handleSaveTokens(port, msg) {
  try {
    const current = (await store.get('connectorTokens', {})) || {};
    const next = { ...current };
    if (msg.tokens && typeof msg.tokens === 'object') {
      for (const [k, v] of Object.entries(msg.tokens)) {
        if (typeof v === 'string' && v.trim()) next[k] = v.trim();
        else if (v === null || v === '') delete next[k];
      }
    }
    await store.set('connectorTokens', next);
    port.postMessage({ type: 'tokens-saved', ok: true });
  } catch (err) {
    port.postMessage({ type: 'tokens-saved', ok: false, error: err?.message || String(err) });
  }
}

async function handleCookies(port) {
  const domains = { chatgpt: 'chatgpt.com', gemini: 'google.com', perplexity: 'perplexity.ai' };
  const out = {};
  for (const [id, domain] of Object.entries(domains)) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const count = cookies.filter((c) => typeof c.value === 'string' && c.value.length > 0).length;
      out[id] = { loggedIn: count > 0, cookieCount: count };
    } catch (err) {
      out[id] = { loggedIn: false, cookieCount: 0, error: err?.message || String(err) };
    }
  }
  port.postMessage({ type: 'cookies', cookies: out });
}

/* ── Port hub ── */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dash') return;
  log('dashboard connected');

  const onMessage = (msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'run':
        handleRun(port, msg);
        break;
      case 'cancel':
        if (activeRun) {
          activeRun.controller.abort();
          log('cancel requested');
        }
        break;
      case 'state':
        handleState(port);
        break;
      case 'providers':
        handleProviders(port);
        break;
      case 'connectors':
        handleConnectors(port);
        break;
      case 'connector-action':
        handleConnectorAction(port, msg);
        break;
      case 'save-tokens':
        handleSaveTokens(port, msg);
        break;
      case 'cookies':
        handleCookies(port);
        break;
      case 'download-zip':
        handleDownloadZip(port, msg);
        break;
      default:
        port.postMessage({ type: 'error', error: `Unknown message type: ${msg.type}` });
    }
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    log('dashboard disconnected');
    if (activeRun && activeRun.port === port) {
      activeRun.controller.abort();
      activeRun = null;
    }
  });
});

/* Persist last run summary for the dashboard + connectors */