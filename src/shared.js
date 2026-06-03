/* shared.js - Core utilities, constants, login check, tab management */

/* ── Constants ── */
const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const CHATGPT_URL = 'https://chatgpt.com/';
const GEMINI_URL = 'https://gemini.google.com/';
const PERPLEXITY_URL = 'https://www.perplexity.ai/';
const HUGGINGFACE_URL = 'https://huggingface.co/chat/';

/* ── Pipeline globals ── */
let cancelled = false;
let running = false;
let pipelineGen = 0;
let loginRetryRequested = false;

class CancelError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelError'; }
}

/* ── Multi-agent state ── */
let multiRunning = false;
let multiCancelled = false;
const DEFAULT_MULTI_STATE = {
  step: 'idle', goal: '', error: null,
  tasks: [], agentOutputs: {}, synthesis: '',
  selectedAgents: [], agentReasoning: '',
  loopCount: 2, loopIndex: 0,
  sharedContext: { goal: '', files: [], agentSummaries: {} },
};

function setMultiState(partial) {
  return chrome.storage.session.get('multiState').then(({ multiState }) => {
    const next = { ...(multiState || DEFAULT_MULTI_STATE), ...partial };
    return chrome.storage.session.set({ multiState: next });
  });
}

async function getMultiState() {
  const { multiState } = await chrome.storage.session.get('multiState');
  return multiState || { ...DEFAULT_MULTI_STATE };
}

/* ── Agent Conversation URL Tracking ── */

function getAgentConv(agentId) {
  return chrome.storage.local.get('agentConvs').then(({ agentConvs }) => {
    return (agentConvs || {})[agentId] || '';
  });
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
  if (!agent || !agent.conversationPattern) return false;
  return url.includes(agent.conversationPattern);
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
    return openTab(agent.url);
  }
  const savedUrl = preferredUrl || await getAgentConv(agent.id);
  const targetUrl = savedUrl || agent.url;
  const existing = await findExistingTab(targetUrl);
  if (existing) return existing;
  return openTab(targetUrl);
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

function openTab(url) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    chrome.tabs.create({ url: target.href, active: false }, (tab) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) { reject(new Error(`Could not open tab: ${lastError.message}`)); return; }
      if (!tab || typeof tab.id !== 'number') { reject(new Error(`Could not open tab for ${url}`)); return; }
      resolve(tab);
    });
  });
}

function waitTab(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(fn);
      reject(new Error('Tab did not finish loading in time'));
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
    error: err?.message || 'Could not reach content script. Refresh the target tab and try again.',
  }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PLACEHOLDER_RE = /^(thinking|searching|generating|preparing|loading|analyzing)/i;

async function poll(tabId, prompt, maxSec = 120) {
  let last = '';
  let stable = 0;
  let maxLen = 0;
  let readFailures = 0;
  const isCancelled = () => cancelled || multiCancelled;
  for (let i = 0; i < maxSec; i++) {
    if (isCancelled()) throw new CancelError();

    /* Check if the AI is still generating before reading */
    const genCheck = await send(tabId, { action: 'isGenerating' });
    const isGenerating = genCheck?.generating === true;

    const r = await send(tabId, { action: 'read' });
    if (r?.error) {
      readFailures++;
      if (readFailures >= 8) throw new Error(r.error);
      await sleep(1000);
      continue;
    }
    readFailures = 0;
    const cur = (r?.text || '').trim();

    if (!cur || PLACEHOLDER_RE.test(cur) || isEcho(cur, prompt)) {
      stable = 0; last = ''; await sleep(1000); continue;
    }

    /* Text is growing — still streaming, don't count as stable */
    if (cur.length > maxLen) {
      maxLen = cur.length;
      stable = 0;
      last = cur;
    } else if (cur === last) {
      stable++;
      /* Only return if AI is NOT still generating */
      if (!isGenerating) {
        const required = cur.length > 1000 ? 8 : cur.length > 200 ? 5 : 3;
        if (stable >= required && cur.length > 10) return cur;
      } else {
        /* AI is still generating — reset stable count to avoid false completion */
        stable = Math.min(stable, 2);
      }
    } else {
      stable = 0;
      last = cur;
    }
    await sleep(1000);
  }
  if (last && !PLACEHOLDER_RE.test(last) && last.length > 10 && !isEcho(last, prompt)) return last;
  return '\u26a0\ufe0f Timeout';
}

function isEcho(text, prompt) {
  if (!prompt) return false;
  return text.includes(prompt) || prompt.includes(text);
}

function tabAlive(tabId) {
  return chrome.tabs.get(tabId).then(
    (tab) => tab && !tab.discarded,
    () => false
  );
}

function isDeepseekConversationUrl(url) {
  return Boolean(url && url.includes('chat.deepseek.com') && url.includes('/chat/s/'));
}

function isChatgptConversationUrl(url) {
  return Boolean(url && url.includes('chatgpt.com') && url.includes('/c/'));
}

/* ── Content script readiness ── */

async function waitForContentScript(tabId, maxSec = 15) {
  for (let i = 0; i < maxSec; i++) {
    const r = await send(tabId, { action: 'ping' });
    if (!r?.error) return true;
    await sleep(1000);
  }
  return false;
}

/* ── Shared Context / Task Prompt Builder ── */

function buildTaskPrompt(task, allTasks, allOutputs, goal) {
  const role = task.assignedTo ? getAgent(task.assignedTo)?.name || task.assignedTo : 'agent';
  const otherTasks = allTasks.filter(t => t !== task);
  const doneTasks = otherTasks.filter(t => t.status === 'done');
  const pendingTasks = otherTasks.filter(t => t.status !== 'done');

  const existingFiles = [];
  if (allOutputs) {
    for (const [, data] of Object.entries(allOutputs)) {
      if (data.output) {
        const matches = data.output.match(/<file\s+name=["']([^"']+)["']>/gi);
        if (matches) matches.forEach(m => existingFiles.push(m.replace(/<file\s+name=["']|["']>/g, '')));
      }
    }
  }

  let parts = [];
  parts.push(`## The Goal\n${goal}\n`);
  parts.push(`## Your Role\nYou are acting as "${role}". Your specific task: ${task.description}\n`);
  
  if (doneTasks.length > 0) {
    parts.push(`## What Other Agents Have Already Completed\n${doneTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`);
  }
  if (pendingTasks.length > 0) {
    parts.push(`## What Other Agents Are Working On\n${pendingTasks.map(t => `- ${t.assignedTo || 'agent'}: ${t.description}`).join('\n')}\n`);
  }
  if (existingFiles.length > 0) {
    parts.push(`## Already Created Files\n${[...new Set(existingFiles)].join(', ')}\nOnly create NEW files not in this list.\n`);
  }
  if (task.type === 'code') {
    parts.push(`## Output Format\nSplit your code into separate files. Wrap each file in <file name="filename.ext"> and </file> tags.\nExample:\n<file name="index.html">\n<!DOCTYPE html>\n<html>\n</file>\n<file name="style.css">\n/* CSS */\n</file>\n<file name="script.js">\n// JS\n</file>`);
  }

  return parts.join('\n---\n');
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
    tab = await openTab(baseUrl);
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
    if (!agent) {
      results[id] = { status: 'error', error: 'Unknown agent' };
      continue;
    }

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
          results[id] = { status: 'cancelled', error: 'Tab closed', agentName: agent.name };
          await setMultiState({
            step: 'login-check',
            loginCheck: { status: 'cancelled', currentAgent: id, agentName: agent.name, agents: results, error: `Login tab for ${agent.name} was closed. Click Retry to try again.` },
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
