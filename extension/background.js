const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';

const GEMINI_ALLOWED_KEYS = new Set([
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
  'NID',
  'COMPASS',
]);

function log(...args) {
  console.log('[Bridge]', ...args);
}

async function getStored(keys) {
  return chrome.storage.local.get(keys);
}

function buildCookieMap(cookies) {
  const map = {};
  for (const c of cookies) {
    if (typeof c.value === 'string' && c.value.length > 0) {
      map[c.name] = c.value;
    }
  }
  return map;
}

async function postJson(url, body, timeoutMs = 5000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function captureAll() {
  const stored = await getStored(['token', 'serverUrl', 'accessToken']);
  const token = stored.token;
  const serverUrl = stored.serverUrl || DEFAULT_SERVER_URL;
  const results = {};

  const providers = [
    { id: 'perplexity', domain: 'perplexity.ai' },
    { id: 'gemini', domain: 'google.com' },
    { id: 'chatgpt', domain: 'chatgpt.com' },
  ];

  for (const { id, domain } of providers) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const cookieMap = buildCookieMap(cookies);
      if (Object.keys(cookieMap).length === 0) {
        results[id] = { ok: false, reason: 'not-logged-in', cookieCount: 0 };
        log('no cookies for', id);
        continue;
      }

      const body = { provider: id, cookies: cookieMap, token };
      if (id === 'chatgpt') {
        body.headers = {};
        if (stored.accessToken) {
          body.headers.authorization = `Bearer ${stored.accessToken}`;
        }
        body.account_id = '';
      }
      if (id === 'gemini') {
        const filtered = {};
        for (const [name, value] of Object.entries(cookieMap)) {
          if (GEMINI_ALLOWED_KEYS.has(name) && value.length > 0) {
            filtered[name] = value;
          }
        }
        if (Object.keys(filtered).length === 0) {
          results[id] = { ok: false, reason: 'not-logged-in', cookieCount: 0 };
          log('no allowed cookies for', id);
          continue;
        }
        body.cookies = filtered;
      }

      const res = await postJson(`${serverUrl}/api/cookies`, body);
      results[id] = {
        ok: res.ok,
        status: res.status,
        cookieCount: Object.keys(body.cookies).length,
        data: res.data,
      };
      log('sent', id, 'count=', results[id].cookieCount, 'status=', res.status, 'ok=', res.ok);
    } catch (err) {
      results[id] = { ok: false, error: String(err && err.message ? err.message : err) };
      log('capture failed for', id, results[id].error);
    }
  }

  await chrome.storage.local.set({ lastResults: results });
  return results;
}

async function probeServer(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/api/state`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch (err) {
    log('server probe failed:', String(err && err.message ? err.message : err));
    return false;
  }
}

async function getStatus() {
  const stored = await getStored(['token', 'serverUrl', 'lastResults']);
  const serverUrl = stored.serverUrl || DEFAULT_SERVER_URL;
  const serverReachable = await probeServer(serverUrl);
  const lastResults = stored.lastResults || {};

  const domains = {
    chatgpt: 'chatgpt.com',
    gemini: 'google.com',
    perplexity: 'perplexity.ai',
  };

  const providers = [];
  for (const id of ['chatgpt', 'gemini', 'perplexity']) {
    let cookieCount = 0;
    try {
      const cookies = await chrome.cookies.getAll({ domain: domains[id] });
      if (id === 'gemini') {
        cookieCount = cookies.filter(
          (c) => GEMINI_ALLOWED_KEYS.has(c.name) && typeof c.value === 'string' && c.value.length > 0
        ).length;
      } else {
        cookieCount = cookies.filter((c) => typeof c.value === 'string' && c.value.length > 0).length;
      }
    } catch (err) {
      log('cookie check failed for', id, String(err && err.message ? err.message : err));
    }
    const last = lastResults[id];
    providers.push({
      id,
      loggedIn: cookieCount > 0,
      sent: Boolean(last && last.ok),
    });
  }

  return {
    serverUrl,
    token: stored.token,
    serverReachable,
    providers,
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const token = crypto.randomUUID();
    await chrome.storage.local.set({ token, serverUrl: DEFAULT_SERVER_URL });
    log('installed, token generated');
    await captureAll();
  } catch (err) {
    log('onInstalled failed:', String(err && err.message ? err.message : err));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'capture') {
        const results = await captureAll();
        sendResponse({ ok: true, results });
      } else if (message.type === 'status') {
        const status = await getStatus();
        sendResponse({ ok: true, ...status });
      } else if (message.type === 'set-server-url') {
        const url = String(message.url || '').trim();
        if (!/^https?:\/\//.test(url)) {
          sendResponse({ ok: false, error: 'invalid-url' });
          return;
        }
        await chrome.storage.local.set({ serverUrl: url.replace(/\/+$/, '') });
        log('server url set');
        await captureAll();
        sendResponse({ ok: true });
      } else if (message.type === 'access-token') {
        if (typeof message.token === 'string' && message.token.length > 0) {
          await chrome.storage.local.set({ accessToken: message.token });
          log('accessToken stored from content script');
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown-type' });
      }
    } catch (err) {
      log('message handler error:', String(err && err.message ? err.message : err));
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});
