/* shared.js v2.1 — Production core: hidden tabs, 1s poll, output limits, lifecycle */

/* ── Constants ── */
const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const CHATGPT_URL = 'https://chatgpt.com/';
const GEMINI_URL = 'https://gemini.google.com/';
const PERPLEXITY_URL = 'https://www.perplexity.ai/';
const HUGGINGFACE_URL = 'https://huggingface.co/chat/';

const MAX_OUTPUT_KB = 48;  /* Keep outputs under 50KB for storage limits */
const POLL_INTERVAL_MS = 1000; /* Exactly 1 second as requested */
const KEEPALIVE_INTERVAL_MS = 20000; /* Keep service worker alive */

/* ── Pipeline globals ── */
let cancelled = false;
let running = false;
let pipelineGen = 0;
let loginRetryRequested = false;
let _hiddenWindowId = null; /* Hidden window for background tab execution */

class CancelError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelError'; }
}

/* ── Multi-agent state (with size limits) ── */
let multiRunning = false;
let multiCancelled = false;
const DEFAULT_MULTI_STATE = {
  step: 'idle', goal: '', error: null,
  tasks: [], agentOutputs: {}, synthesis: '',
  selectedAgents: [], agentReasoning: '',
  loopCount: 2, loopIndex: 0,
  sharedContext: { goal: '', files: [], agentSummaries: {} },
};

function truncateForStorage(obj, maxKB = MAX_OUTPUT_KB) {
  if (!obj || typeof obj !== 'object') return obj;
  const str = JSON.stringify(obj);
  const maxBytes = maxKB * 1024;
  if (str.length <= maxBytes) return obj;
  /* Truncate agent outputs and synthesis */
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy.agentOutputs) {
    for (const [k, v] of Object.entries(copy.agentOutputs)) {
      if (v.output && v.output.length > maxBytes / 4) {
        v.output = v.output.slice(0, maxBytes / 4) + '\n\n[truncated]';
      }
    }
  }
  if (copy.synthesis && copy.synthesis.length > maxBytes / 2) {
    copy.synthesis = copy.synthesis.slice(0, maxBytes / 2) + '\n\n[truncated]';
  }
  return copy;
}

function setMultiState(partial) {
  return chrome.storage.session.get('multiState').then(({ multiState }) => {
    const next = truncateForStorage({ ...(multiState || DEFAULT_MULTI_STATE), ...partial });
    return chrome.storage.session.set({ multiState: next });
  });
}

async function getMultiState() {
  const { multiState } = await chrome.storage.session.get('multiState');
  return multiState || { ...DEFAULT_MULTI_STATE };
}

/* ── Off-screen background tab execution ──
 *
 * Chrome does NOT fully render tabs in minimized windows — content scripts
 * won't inject, DOM events won't fire, and AI sites won't initialize.
 *
 * Solution: Create a tiny off-screen popup window positioned at (-2000, -2000).
 * Chrome fully renders ALL popup windows, so content scripts inject properly
 * and the page loads completely — but the user never sees it.
 */

let _offScreenWindowId = null;

async function ensureOffScreenWindow() {
  if (_offScreenWindowId) {
    try {
      const win = await chrome.windows.get(_offScreenWindowId);
      if (win) return _offScreenWindowId;
    } catch { _offScreenWindowId = null; }
  }
  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      left: -2000, top: -2000,    /* Off-screen — user can't see it */
      width: 400, height: 300,    /* Small but valid size */
      type: 'popup',              /* Popup renders fully even when off-screen */
      focused: false,
      state: 'normal',
    });
    _offScreenWindowId = win.id;
    return win.id;
  } catch {
    return null; /* Fallback: regular background tabs */
  }
}

async function openHiddenTab(url) {
  let target;
  try { target = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }

  const hiddenWin = await ensureOffScreenWindow();

  if (hiddenWin) {
    /* Open with active:true so the tab fully loads + injects content script.
     * In an off-screen popup, the user never sees this activation. */
    return new Promise((resolve, reject) => {
      chrome.tabs.create({ url: target.href, active: true, windowId: hiddenWin }, (tab) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!tab || typeof tab.id !== 'number') { reject(new Error('Could not create hidden tab')); return; }
        resolve(tab);
      });
    });
  }

  /* Fallback: background tab in current window (still works, just visible) */
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: target.href, active: false }, (tab) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!tab || typeof tab.id !== 'number') { reject(new Error('Could not create tab')); return; }
      resolve(tab);
    });
  });
}

/* ── Activate a tab briefly so its content script stays alive ── */
async function pokeTab(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(200);
  } catch { /* tab may be gone */ }
}

/* ── Close off-screen window on cleanup ── */
async function cleanupHiddenWindow() {
  if (_offScreenWindowId) {
    try {
      const tabs = await chrome.tabs.query({ windowId: _offScreenWindowId });
      for (const t of tabs) {
        if (t.id && !t.url?.startsWith('about:blank')) await chrome.tabs.remove(t.id).catch(() => {});
      }
      await chrome.windows.remove(_offScreenWindowId).catch(() => {});
    } catch { /* window may already be gone */ }
    _offScreenWindowId = null;
  }
}

/* ── Agent Conversation URL Tracking ── */
function getAgentConv(agentId) {
  return chrome.storage.local.get('agentConvs').then(({ agentConvs }) => (agentConvs || {})[agentId] || '');
}
function setAgentConv(agentId, url) {
  return chrome.storage.local.get('agentConvs').then(({ agentConvs }) => {
    const next = { ...(agentConvs || {}), [agentId]: url };
    return chrome.storage.local.set({ agentConvs: next });
  });
}
function isConversationUrl(agentId, url) {
  if (!url) return false;
  const agent = getAgent(agentId);
  return agent && agent.conversationPattern ? url.includes(agent.conversationPattern) : false;
}

async function findExistingTab(convUrl) {
  if (!convUrl) return null;
  let origin;
  try { origin = new URL(convUrl).origin; } catch { return null; }
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.url.startsWith(origin)) return tab;
  }
  return null;
}

async function getOrCreateTab(agent, preferredUrl) {
  if (!agent.conversationPattern) {
    const existing = await findExistingTab(agent.url);
    if (existing) return existing;
    return openHiddenTab(agent.url);
  }
  const savedUrl = preferredUrl || await getAgentConv(agent.id);
  const targetUrl = savedUrl || agent.url;
  const existing = await findExistingTab(targetUrl);
  if (existing) return existing;
  return openHiddenTab(targetUrl);
}

async function updateAgentConv(agentId, tabId) {
  const url = await getTabUrl(tabId);
  if (url && isConversationUrl(agentId, url)) {
    await setAgentConv(agentId, url);
    return url;
  }
  return '';
}

/* ── Tab utilities ── */

function openTab(url) { return openHiddenTab(url); } /* Legacy alias */

function waitTab(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(fn);
      reject(new Error('Tab load timeout'));
    }, timeout);
    function fn(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(fn);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(fn);
        resolve();
      }
    });
  });
}

function getTabUrl(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { resolve(''); return; }
      resolve(tab?.url || '');
    });
  });
}

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch((err) => ({
    error: err?.message || 'Content script unreachable. Refresh the agent tab.',
  }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PLACEHOLDER_RE = /^(thinking|searching|generating|preparing|loading|analyzing|researching)/i;

/* ── Smarter 1s-interval poll with adaptive stability + readDeep fallback ── */
async function poll(tabId, prompt, maxSec = 180) {
  let last = '';
  let stable = 0;
  let maxLen = 0;
  let readFailures = 0;
  let emptyReads = 0; /* Track consecutive empty reads for fallback */
  const isCancelled = () => cancelled || multiCancelled;

  for (let i = 0; i < maxSec; i++) {
    if (isCancelled()) throw new CancelError();

    const r = await send(tabId, { action: 'read' });
    if (r?.error) {
      readFailures++;
      if (readFailures >= 10) {
        const deep = await send(tabId, { action: 'readDeep' });
        if (deep?.text && deep.text.length > 50) return deep.text;
        throw new Error(r.error);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    readFailures = 0;
    const cur = (r?.text || '').trim();

    if (!cur || PLACEHOLDER_RE.test(cur) || isEcho(cur, prompt)) {
      stable = 0; last = '';
      emptyReads++;
      /* After 30 empty reads (~30s), try readDeep as fallback */
      if (emptyReads === 30) {
        const deep = await send(tabId, { action: 'readDeep' });
        if (deep?.text && deep.text.length > 50) {
          emptyReads = 0;
          last = deep.text; maxLen = deep.text.length;
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    emptyReads = 0;

    if (cur.length > maxLen) {
      const growth = cur.length - maxLen;
      maxLen = cur.length;
      stable = 0;
      last = cur;
    } else if (cur === last && cur.length > 10) {
      stable++;
      const required = Math.min(20, Math.max(5, Math.floor(cur.length / 200)));
      if (stable >= required) return cur;
    } else {
      stable = 0;
      last = cur;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (last && !PLACEHOLDER_RE.test(last) && last.length > 10 && !isEcho(last, prompt)) return last;
  const deepScan = await send(tabId, { action: 'readDeep' });
  if (deepScan?.text && deepScan.text.length > 20) return deepScan.text;
  return '\u26a0\ufe0f Timeout';
}

function isEcho(text, prompt) { return false; }

/* ── Tab life-cycle management ── */
function tabAlive(tabId) {
  return chrome.tabs.get(tabId).then(
    (tab) => tab && !tab.discarded,
    () => false
  );
}

async function tabAliveWithRetry(tabId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (await tabAlive(tabId)) return true;
    await sleep(1500);
  }
  return false;
}

function isDeepseekConversationUrl(url) {
  return Boolean(url && url.includes('chat.deepseek.com') && url.includes('/chat/s/'));
}
function isChatgptConversationUrl(url) {
  return Boolean(url && url.includes('chatgpt.com') && url.includes('/c/'));
}

/* ── Content script readiness ── */
async function waitForContentScript(tabId, maxSec = 20) {
  for (let i = 0; i < maxSec; i++) {
    const r = await send(tabId, { action: 'ping' });
    if (!r?.error) return true;
    await sleep(1000);
  }
  return false;
}

/* ── Keepalive ── */
let _keepaliveTimer = null;
function startKeepalive() {
  stopKeepalive();
  _keepaliveTimer = setInterval(() => {
    chrome.storage.local.get('_keepalive').catch(() => {});
  }, KEEPALIVE_INTERVAL_MS);
}
function stopKeepalive() {
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
}

/* ── Login check ── */
const AGENT_LOGIN_URLS = {
  deepseek: DEEPSEEK_URL,
  chatgpt: CHATGPT_URL,
  gemini: GEMINI_URL,
  perplexity: PERPLEXITY_URL,
  huggingface: HUGGINGFACE_URL,
};

async function checkAgentLogin(agentId) {
  const baseUrl = AGENT_LOGIN_URLS[agentId];
  if (!baseUrl) return { loggedIn: false, error: 'Unknown agent' };

  let tab;
  try {
    tab = await openHiddenTab(baseUrl);
    await waitTab(tab.id);
    await sleep(3000);
    const r = await send(tab.id, { action: 'checkLogin' });
    const loggedIn = r?.error ? false : r?.loggedIn === true;
    return { loggedIn, tabId: tab.id, error: r?.error || null };
  } catch (err) {
    return { loggedIn: false, tabId: tab?.id, error: err.message };
  }
}

async function runLoginCheck(selectedAgents) {
  const results = {};
  for (const id of selectedAgents) {
    const agent = getAgent(id);
    if (!agent) { results[id] = { status: 'error', error: 'Unknown agent' }; continue; }

    let done = false;
    while (!done) {
      if (multiCancelled) throw new CancelError();
      loginRetryRequested = false;

      await setMultiState({
        step: 'login-check',
        loginCheck: { status: 'checking', currentAgent: id, agentName: agent.name, agents: results, error: null },
      });

      const check = await checkAgentLogin(id);
      results[id] = { status: check.loggedIn ? 'done' : 'not-logged-in', tabId: check.tabId, agentName: agent.name };
      if (check.loggedIn) { done = true; continue; }

      const start = Date.now();
      const TIMEOUT = 300000;
      let waiting = true;

      while (waiting && Date.now() - start < TIMEOUT) {
        if (multiCancelled) throw new CancelError();
        if (loginRetryRequested) { waiting = false; break; }

        await setMultiState({
          step: 'login-check',
          loginCheck: { status: 'waiting', currentAgent: id, agentName: agent.name, agents: results, error: null },
        });

        const alive = check.tabId ? await tabAlive(check.tabId) : false;
        if (!alive) {
          results[id] = { status: 'tab-closed', error: 'Tab closed', agentName: agent.name };
          await setMultiState({
            step: 'login-check',
            loginCheck: { status: 'cancelled', currentAgent: id, agentName: agent.name, agents: results, error: `Login tab for ${agent.name} was closed.` },
          });
          const retryStart = Date.now();
          while (Date.now() - retryStart < TIMEOUT) {
            if (multiCancelled) throw new CancelError();
            if (loginRetryRequested) { waiting = false; break; }
            await sleep(1000);
          }
          if (!loginRetryRequested) {
            results[id] = { status: 'timeout', error: 'No retry', agentName: agent.name };
            return { results, allDone: false };
          }
          break;
        }

        const r = await send(check.tabId, { action: 'checkLogin' });
        if (!r?.error && r?.loggedIn === true) {
          results[id] = { status: 'done', tabId: check.tabId, agentName: agent.name };
          done = true; waiting = false; break;
        }
        await sleep(3000);
      }

      if (waiting && results[id].status !== 'done') {
        results[id] = { status: 'timeout', error: 'Login timed out', agentName: agent.name };
        await setMultiState({
          step: 'login-check',
          loginCheck: { status: 'cancelled', currentAgent: id, agentName: agent.name, agents: results, error: 'Timed out waiting for login.' },
        });
        return { results, allDone: false };
      }
    }
  }
  await setMultiState({
    step: 'login-check',
    loginCheck: { status: 'done', currentAgent: '', agentName: '', agents: results, error: null },
  });
  return { results, allDone: true };
}
