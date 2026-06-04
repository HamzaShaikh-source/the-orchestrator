importScripts('shared.js', 'agents.js', 'task-planner.js', 'task-router.js', 'orchestrator.js');

const DEFAULT_STATE = {
  step: 'idle', prompt: '', task: '',
  deepseekResponse: '', chatgptResponse: '',
  error: null,
  loopCount: 3, loopIndex: 0, loopPhase: '',
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

const AGENT_DOMAINS = [
  'chat.deepseek.com', 'chatgpt.com', 'gemini.google.com',
  'www.perplexity.ai', 'huggingface.co',
];

async function refreshAgentTabs() {
  console.log('[BG] Extension installed/reloaded — refreshing agent tabs');
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
    await setState({ step: 'error', error: 'A pipeline is already running. Stop it before starting another run.' });
    return;
  }
  console.log('=== Pipeline starting ===');
  const gen = ++pipelineGen;
  running = true; cancelled = false;
  await chrome.storage.session.set({ form: { prompt, task } });
  await setState({ step: 'deepseek-open', prompt, task, deepseekResponse: '', chatgptResponse: '', error: null, loopCount, loopIndex: 0, loopPhase: '', critiques: [], improvements: [] });

  try {
    if (cancelled) throw new CancelError();
    let dsResponse, gptResponse;
    let dsTabId, gptTabId;

    // Step 1: DeepSeek
    {
      const dsUrl = manualDS || DEEPSEEK_URL;
      const ds = await openTab(dsUrl);
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

    // Step 2: ChatGPT initial
    {
      const gptUrl = manualGPT || CHATGPT_URL;
      const gpt = await openTab(gptUrl);
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

    // Step 3: Cross-model feedback loop
    const critiques = []; const improvements = [];
    let currentOutput = gptResponse;
    for (let i = 1; i <= loopCount; i++) {
      if (cancelled) throw new CancelError();
      await setState({ step: 'deepseek-wait', loopIndex: i, loopPhase: 'critique' });
      const dsCritiquePrompt = `Critique the following output. Identify 3-5 specific ways to improve it. Be direct, constructive, and detailed.\n\nOutput to review:\n${currentOutput}`;
      let r = await send(dsTabId, { action: 'inject', text: dsCritiquePrompt });
      if (r?.error) throw new Error('DS inject critique: ' + r.error);
      await sleep(1500);
      r = await send(dsTabId, { action: 'submit' });
      if (r?.error) throw new Error('DS submit critique: ' + r.error);
      const critique = await poll(dsTabId, dsCritiquePrompt, 120);
      if (cancelled) throw new CancelError();
      critiques.push(critique);
      await setState({ critiques: [...critiques], loopPhase: 'critique-done' });

      await setState({ step: 'chatgpt-wait', loopPhase: 'improve' });
      const improvePrompt = `Apply the following critique to improve the output.\n\nCritique:\n${critique}\n\nOriginal:\n${currentOutput}\n\nImproved:`;
      r = await send(gptTabId, { action: 'inject', text: improvePrompt });
      if (r?.error) throw new Error('GPT inject improve: ' + r.error);
      await sleep(1500);
      r = await send(gptTabId, { action: 'submit' });
      if (r?.error) throw new Error('GPT submit improve: ' + r.error);
      const improved = await poll(gptTabId, improvePrompt, 120);
      if (cancelled) throw new CancelError();
      improvements.push(improved);
      currentOutput = improved;
      await setState({ improvements: [...improvements], loopPhase: 'improve-done' });
    }

    await setState({ chatgptResponse: currentOutput, critiques, improvements, step: 'done' });
    console.log('=== Pipeline complete ===');
  } catch (err) {
    if (err instanceof CancelError) { console.log('=== Pipeline cancelled ==='); await setState({ step: 'cancelled', error: null }); return; }
    console.error('Pipeline failed:', err);
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
  if (msg.action === 'run') {
    run(msg.prompt, msg.task, msg.loopCount || 3, msg.manualDS || '', msg.manualGPT || '');
    sendResponse({ ok: true });
  } else if (msg.action === 'stop') {
    cancelled = true;
    setState({ step: 'cancelled', error: null }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.action === 'status') {
    getState().then(sendResponse);
    return true;
  } else if (msg.action === 'getConvHistory') {
    getConvHistory().then(sendResponse);
    return true;
  } else if (msg.action === 'clearState') {
    cancelled = true; running = false; pipelineGen++;
    chrome.storage.session.set({ state: { ...DEFAULT_STATE } }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.action === 'multiStatus') {
    getMultiState().then(sendResponse);
    return true;
  } else if (msg.action === 'stopMulti') {
    multiCancelled = true;
    setMultiState({ step: 'cancelled', error: null }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.action === 'getAgentConvs') {
    chrome.storage.local.get('agentConvs').then(({ agentConvs }) => sendResponse(agentConvs || {}));
    return true;
  } else if (msg.action === 'runMulti') {
    runMulti(msg.goal, msg.manualUrls || {}, msg.selectedAgents || null, msg.chatId || null, msg.projectFiles || {});
    sendResponse({ ok: true });
  } else if (msg.action === 'loginRetry') {
    loginRetryRequested = true;
    sendResponse({ ok: true });
  } else if (msg.action === 'listChats') {
    listChats().then(sendResponse);
    return true;
  } else if (msg.action === 'getChat') {
    getChat(msg.chatId).then(sendResponse);
    return true;
  } else if (msg.action === 'deleteChat') {
    deleteChat(msg.chatId).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.action === 'getChatAgentConvs') {
    getChat(msg.chatId).then(chat => sendResponse(chat?.agentConvs || {}));
    return true;
  } else if (msg.action === 'confirmTasks') {
    setMultiState({ tasksConfirmed: true }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.action === 'rejectTasks') {
    setMultiState({ tasksConfirmed: false }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.action === 'downloadFile') {
    /* Download a file via base64 data */
    const byteStr = atob(msg.data);
    const bytes = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: msg.filename || 'download.zip',
      saveAs: true
    }).catch(err => {
      /* Fallback to direct download */
      const a = document.createElement('a');
      a.href = url;
      a.download = msg.filename || 'download.zip';
      a.click();
    });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
