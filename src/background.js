/* background.js v2.1 — Production service worker with keepalive */

importScripts('shared.js', 'agents.js', 'prompts.js', 'task-planner.js', 'task-router.js', 'orchestrator.js');

/* Initialize reliability tracking */
initReliability();

/* Pipeline log (rotating, last 50 lines) */
const pipelineLog = [];
const MAX_LOG_LINES = 50;
function addPipelineLog(message) {
  pipelineLog.push({ ts: Date.now(), msg: message });
  if (pipelineLog.length > MAX_LOG_LINES) pipelineLog.splice(0, pipelineLog.length - MAX_LOG_LINES);
}

const DEFAULT_STATE = {
  step: 'idle', prompt: '', task: '',
  deepseekResponse: '', chatgptResponse: '',
  error: null, loopCount: 3, loopIndex: 0, loopPhase: '',
  critiques: [], improvements: [],
  deepseekUrl: '', chatgptUrl: '',
};

function setState(partial) {
  return chrome.storage.session.get('state').then(({ state }) => {
    const next = { ...(state || {}), ...partial };
    return chrome.storage.session.set({ state: next });
  });
}
async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state || { ...DEFAULT_STATE };
}
async function getConvHistory() {
  const { convHistory } = await chrome.storage.local.get('convHistory');
  return convHistory || [];
}

/* ── Auto-update system ── */
const GITHUB_REPO = 'HamzaShaikh-source/the-orchestrator';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;
const GITHUB_ZIP = `https://github.com/${GITHUB_REPO}/archive/main.zip`;
const UPDATE_CHECK_KEY = 'lastUpdateSha';
let _lastUpdateCheck = 0;

async function checkForUpdate() {
  const now = Date.now();
  if (now - _lastUpdateCheck < 300000) {
    return { available: false, cached: true };
  }
  _lastUpdateCheck = now;
  try {
    const res = await fetch(GITHUB_API, { cache: 'no-cache' });
    if (!res.ok) return { available: false, error: `GitHub API: ${res.status}` };
    const data = await res.json();
    const latestSha = data.sha || '';
    if (!latestSha) return { available: false, error: 'No SHA returned' };
    /* Get the stored SHA */
    const { [UPDATE_CHECK_KEY]: storedSha } = await chrome.storage.local.get(UPDATE_CHECK_KEY);
    const available = latestSha !== storedSha;
    /* Get last commit message for display */
    const message = data.commit?.message?.split('\n')[0] || 'New update available';
    return { available, latestSha, message, currentVersion: chrome.runtime.getManifest().version };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

async function downloadLatestUpdate() {
  try {
    /* Download ZIP via chrome.downloads API — fixed filename so it overwrites each time */
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: GITHUB_ZIP,
        filename: 'the-orchestrator-update.zip',
        saveAs: false,
        conflictAction: 'overwrite',
      }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
    /* Wait for download to complete, then get the file path */
    const path = await new Promise((resolve) => {
      const handler = (delta) => {
        if (delta.id === downloadId && delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(handler);
          chrome.downloads.search({ id: downloadId }, (results) => {
            resolve(results[0]?.filename || '');
          });
        }
      };
      chrome.downloads.onChanged.addListener(handler);
      /* Timeout fallback */
      setTimeout(() => { chrome.downloads.onChanged.removeListener(handler); resolve(''); }, 30000);
    });
    return { success: true, downloadId, path, message: 'Downloaded!' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* After successful check, store the SHA to suppress re-notification */
async function acknowledgeUpdate(sha) {
  await chrome.storage.local.set({ [UPDATE_CHECK_KEY]: sha });
}

const AGENT_DOMAINS = [
  'chat.deepseek.com', 'chatgpt.com', 'gemini.google.com',
  'www.perplexity.ai', 'huggingface.co',
];

async function refreshAgentTabs() {
  console.log('[BG] Extension reloaded — refreshing agent tabs');
  const tabs = await chrome.tabs.query({});
  let refreshed = 0;
  for (const tab of tabs) {
    if (!tab.url) continue;
    try {
      const url = new URL(tab.url);
      if (AGENT_DOMAINS.some(d => url.hostname.includes(d.replace('www.', '')))) {
        await chrome.tabs.reload(tab.id);
        refreshed++;
      }
    } catch {}
  }
  console.log(`[BG] Refreshed ${refreshed} agent tab(s)`);
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[BG] Extension installed/updated:', details.reason);
  chrome.storage.session.remove('multiState');
  chrome.storage.session.remove('state');
  if (details.reason === 'update' || details.reason === 'install') refreshAgentTabs();
});
chrome.runtime.onStartup.addListener(() => refreshAgentTabs());

/* ── Keepalive (prevents service worker idle shutdown) ── */
let bgKeepaliveTimer = null;
function startBgKeepalive() {
  stopBgKeepalive();
  bgKeepaliveTimer = setInterval(() => {
    chrome.storage.local.get('_ping').catch(() => {});
  }, 20000);
}
function stopBgKeepalive() {
  if (bgKeepaliveTimer) { clearInterval(bgKeepaliveTimer); bgKeepaliveTimer = null; }
}
startBgKeepalive();

/* ── Single-agent pipeline (legacy) ── */
async function saveConv(entry) {
  if (!entry?.url) return;
  let history = await getConvHistory();
  history = history.filter(h => h.url !== entry.url);
  history.unshift({
    ...entry,
    label: (entry.label || entry.type || 'Conversation').trim() || 'Conversation',
    date: entry.date || Date.now(),
  });
  if (history.length > 50) history.length = 50;
  await chrome.storage.local.set({ convHistory: history });
}

async function run(prompt, task, loopCount = 3, manualDS = '', manualGPT = '') {
  if (running) {
    await setState({ step: 'error', error: 'A pipeline is already running.' });
    return;
  }
  console.log('=== Legacy pipeline starting ===');
  const gen = ++pipelineGen;
  running = true; cancelled = false;
  await chrome.storage.session.set({ form: { prompt, task } });
  await setState({ step: 'deepseek-open', prompt, task, deepseekResponse: '', chatgptResponse: '', error: null, loopCount, loopIndex: 0, loopPhase: '', critiques: [], improvements: [] });

  try {
    if (cancelled) throw new CancelError();
    let dsResponse, gptResponse;
    let dsTabId, gptTabId;

    /* Step 1: DeepSeek */
    {
      const dsUrl = manualDS || DEEPSEEK_URL;
      const ds = await openHiddenTab(dsUrl);
      dsTabId = ds.id;
      await waitTab(ds.id);
      await sleep(4000);
      await setState({ step: 'deepseek-inject' });
      let r = await send(ds.id, { action: 'inject', text: prompt });
      if (r?.error) throw new Error('DS inject: ' + r.error);
      await sleep(800);
      await setState({ step: 'deepseek-wait' });
      r = await send(ds.id, { action: 'submit' });
      if (r?.error) throw new Error('DS submit: ' + r.error);
      dsResponse = await poll(ds.id, prompt, 120);
      if (cancelled) throw new CancelError();
      await setState({ deepseekResponse: dsResponse });
      const url = await getTabUrl(ds.id);
      if (isDeepseekConversationUrl(url)) { await setState({ deepseekUrl: url }); await saveConv({ type: 'deepseek', url, label: prompt.slice(0, 50), date: Date.now() }); }
    }

    /* Step 2: ChatGPT initial */
    {
      const gptUrl = manualGPT || CHATGPT_URL;
      const gpt = await openHiddenTab(gptUrl);
      gptTabId = gpt.id;
      await waitTab(gpt.id);
      await sleep(5000);
      await setState({ step: 'chatgpt-inject' });
      const gptPrompt = `${task}\n\n${dsResponse}`;
      let r = await send(gpt.id, { action: 'inject', text: gptPrompt });
      if (r?.error) throw new Error('GPT inject: ' + r.error);
      await sleep(1500);
      await setState({ step: 'chatgpt-wait' });
      r = await send(gpt.id, { action: 'submit' });
      if (r?.error) throw new Error('GPT submit: ' + r.error);
      gptResponse = await poll(gpt.id, gptPrompt, 120);
      if (cancelled) throw new CancelError();
      await setState({ chatgptResponse: gptResponse });
      const url = await getTabUrl(gpt.id);
      if (isChatgptConversationUrl(url)) { await setState({ chatgptUrl: url }); await saveConv({ type: 'chatgpt', url, label: prompt.slice(0, 50), date: Date.now() }); }
    }

    /* Step 3: Cross-model feedback loop */
    const critiques = []; const improvements = [];
    let currentOutput = gptResponse;
    for (let i = 1; i <= loopCount; i++) {
      if (cancelled) throw new CancelError();
      await setState({ step: 'deepseek-wait', loopIndex: i, loopPhase: 'critique' });
      const dsCritiquePrompt = `Critique the following output. Identify 3-5 specific improvements.\n\n${currentOutput}`;
      let r = await send(dsTabId, { action: 'inject', text: dsCritiquePrompt });
      if (r?.error) throw new Error('DS critique inject: ' + r.error);
      await sleep(1500);
      r = await send(dsTabId, { action: 'submit' });
      if (r?.error) throw new Error('DS critique submit: ' + r.error);
      const critique = await poll(dsTabId, dsCritiquePrompt, 120);
      if (cancelled) throw new CancelError();
      critiques.push(critique);
      await setState({ critiques: [...critiques], loopPhase: 'critique-done' });

      await setState({ step: 'chatgpt-wait', loopPhase: 'improve' });
      const improvePrompt = `Apply this critique:\n${critique}\n\nOriginal:\n${currentOutput}\n\nImproved:`;
      r = await send(gptTabId, { action: 'inject', text: improvePrompt });
      if (r?.error) throw new Error('GPT improve inject: ' + r.error);
      await sleep(1500);
      r = await send(gptTabId, { action: 'submit' });
      if (r?.error) throw new Error('GPT improve submit: ' + r.error);
      const improved = await poll(gptTabId, improvePrompt, 120);
      if (cancelled) throw new CancelError();
      improvements.push(improved);
      currentOutput = improved;
      await setState({ improvements: [...improvements], loopPhase: 'improve-done' });
    }

    await setState({ chatgptResponse: currentOutput, critiques, improvements, step: 'done' });
    console.log('=== Legacy pipeline complete ===');
  } catch (err) {
    if (err instanceof CancelError) { console.log('=== Legacy pipeline cancelled ==='); await setState({ step: 'cancelled', error: null }); return; }
    console.error('Legacy pipeline failed:', err);
    await setState({ step: 'error', error: err.message });
  } finally { if (pipelineGen === gen) running = false; }
}

let trackedDSUrls = new Set();
let trackedGPTUrls = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (isDeepseekConversationUrl(changeInfo.url) && !trackedDSUrls.has(changeInfo.url)) {
    trackedDSUrls.add(changeInfo.url);
    setState({ deepseekUrl: changeInfo.url });
    chrome.storage.session.get('state').then(({ state }) => saveConv({ type: 'deepseek', url: changeInfo.url, label: (state?.prompt || 'DeepSeek').slice(0, 50), date: Date.now() }));
  }
  if (isChatgptConversationUrl(changeInfo.url) && !trackedGPTUrls.has(changeInfo.url)) {
    trackedGPTUrls.add(changeInfo.url);
    setState({ chatgptUrl: changeInfo.url });
    chrome.storage.session.get('state').then(({ state }) => saveConv({ type: 'chatgpt', url: changeInfo.url, label: (state?.prompt || 'ChatGPT').slice(0, 50), date: Date.now() }));
  }
});

/* ── Message handlers ── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    run: () => {
      if (!msg.prompt) return { error: 'Missing prompt' };
      addPipelineLog('Legacy pipeline started');
      run(msg.prompt, msg.task, msg.loopCount || 3, msg.manualDS || '', msg.manualGPT || '');
      return { ok: true };
    },
    stop: () => { cancelled = true; addPipelineLog('Pipeline stopped'); setState({ step: 'cancelled', error: null }); return { ok: true }; },
    status: () => { getState().then(sendResponse); return true; },
    getConvHistory: () => { getConvHistory().then(sendResponse); return true; },
    clearState: () => { cancelled = true; running = false; pipelineGen++; chrome.storage.session.set({ state: { ...DEFAULT_STATE } }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true })); return true; },
    multiStatus: () => { getMultiState().then(sendResponse); return true; },
    stopMulti: () => { multiCancelled = true; setMultiState({ step: 'cancelled', error: null }); return { ok: true }; },
    getAgentConvs: () => { chrome.storage.local.get('agentConvs').then(({ agentConvs }) => sendResponse(agentConvs || {})); return true; },
    runMulti: () => {
      if (!msg.goal) return { error: 'Missing goal' };
      addPipelineLog(`Multi-agent pipeline started: ${msg.goal.slice(0, 80)}`);
      runMulti(msg.goal, msg.manualUrls || {}, msg.selectedAgents || null, msg.chatId || null, msg.projectFiles || {}, msg.settings || {});
      return { ok: true };
    },
    loginRetry: () => { loginRetryRequested = true; return { ok: true }; },
    listChats: () => { listChats().then(sendResponse); return true; },
    getChat: () => { getChat(msg.chatId).then(sendResponse); return true; },
    deleteChat: () => { deleteChat(msg.chatId).then(() => sendResponse({ ok: true })); return true; },
    confirmTasks: () => { setMultiState({ tasksConfirmed: true }); return { ok: true }; },
    rejectTasks: () => { setMultiState({ tasksConfirmed: false }); return { ok: true }; },
    retryTask: () => {
      getMultiState().then(s => {
        const tasks = [...(s.tasks || [])];
        const taskIdx = msg.taskIndex;
        if (taskIdx >= 0 && taskIdx < tasks.length) {
          const task = tasks[taskIdx];
          task.status = 'pending';
          task.error = null;
          task.retryCount = (task.retryCount || 0) + 1;
          setMultiState({ tasks: tasks, step: 'running' });
          setTimeout(() => {
            chrome.runtime.sendMessage({
              action: 'runMulti',
              goal: s.goal,
              selectedAgents: s.selectedAgents
            });
          }, 1000);
        }
      });
      return { ok: true };
    },
    skipTask: () => { getMultiState().then(s => { const tasks = s.tasks || []; if (msg.taskIndex >= 0 && msg.taskIndex < tasks.length) { tasks[msg.taskIndex].status = 'skipped'; setMultiState({ tasks: [...tasks] }); }}); return { ok: true }; },
    autoRetryTask: () => {
      const delay = Math.min(1000 * Math.pow(2, msg.retryCount || 0), 8000);
      setTimeout(() => {
        getMultiState().then(state => {
          const tasks = [...(state.tasks || [])];
          const task = tasks[msg.taskIdx];
          if (!task || (task.status !== 'pending' && task.status !== 'error')) return;
          task.status = 'pending';
          task.error = null;
          task.retryCount = (task.retryCount || 0) + 1;
          setMultiState({ tasks: tasks, step: 'running' }).then(() => {
            chrome.runtime.sendMessage({
              action: 'runMulti',
              goal: state.goal,
              selectedAgents: state.selectedAgents
            });
          });
        });
      }, delay);
      return { autoRetried: true, delay };
    },
    checkUpdate: () => { addPipelineLog('Checking for update'); checkForUpdate().then(sendResponse); return true; },
    downloadUpdate: () => { addPipelineLog('Downloading update'); downloadLatestUpdate().then(sendResponse); return true; },
    acknowledgeUpdate: () => { acknowledgeUpdate(msg.sha).then(() => sendResponse({ ok: true })); return true; },
    openDownloads: () => { chrome.downloads.showDefaultFolder(); sendResponse({ ok: true }); return true; },
    openExtensions: () => { chrome.tabs.create({ url: 'chrome://extensions', active: true }); sendResponse({ ok: true }); return true; },
    getPipelineLog: () => { sendResponse([...pipelineLog]); return true; },
  };

  const handler = handlers[msg.action];
  if (handler) {
    try {
      const result = handler();
      if (result === true) return true;
      sendResponse(result);
    } catch (err) {
      console.error(`[BG] Handler error for ${msg.action}:`, err);
      sendResponse({ error: err.message });
    }
  }
  return false;
});

/* ── Port-based state connection (for multi-agent.html real-time updates) ── */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'orchestrator-state') {
    handleStatePort(port);
  }
});
