/* providers.js — direct provider clients for the extension.
   Runs inside the MV3 service worker: fetch with credentials:'include' uses the
   user's real browser session cookies (host_permissions grant access).
   No cookie injection, no auth files, no external server. */

import { getConfig, getRequirementsToken, getAnswerToken } from './proofofwork.js';

export class ProviderError extends Error {
  constructor(message, { code = 'provider', retryable = true, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export const RETRY_POLICY = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 30000 };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function uuid() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── SSE stream parsing (fetch ReadableStream) ── */

async function readSSE(response, onEvent, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    if (signal && signal.aborted) throw new ProviderError('Request cancelled', { code: 'cancelled', retryable: false });
    const { value, done: d } = await reader.read();
    done = d;
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.trim()) onEvent(block);
    }
  }
  if (buffer.trim()) onEvent(buffer);
}

function parseSSEBlock(block) {
  const lines = block.split('\n');
  let event = 'message';
  const data = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  return { event, data: data.join('\n') };
}

/* ── Perplexity ── */

function enrichPerplexityChunk(contentJson) {
  const text = contentJson.text;
  if (!(text && typeof text === 'string')) return contentJson;
  let textParsed;
  try {
    textParsed = JSON.parse(text);
  } catch {
    return contentJson;
  }
  if (Array.isArray(textParsed)) {
    for (const step of textParsed) {
      if (step.step_type !== 'FINAL') continue;
      const finalContent = step.content || {};
      if (!('answer' in finalContent)) continue;
      try {
        const answerData = JSON.parse(finalContent.answer);
        contentJson.answer = answerData.answer || '';
        contentJson.chunks = answerData.chunks || [];
      } catch {
        /* keep as-is */
      }
      break;
    }
  }
  contentJson.text = textParsed;
  return contentJson;
}

function answerLen(chunk) {
  const a = chunk.answer;
  return typeof a === 'string' ? a.trim().length : 0;
}

function pickBestChunk(chunks) {
  if (!chunks || !chunks.length) return {};
  let best = chunks[0];
  for (const c of chunks) {
    if (answerLen(c) > answerLen(best)) best = c;
  }
  return answerLen(best) > 0 ? best : chunks[chunks.length - 1];
}

async function perplexityChat({ message, session, onDelta, signal }) {
  const frontendUuid = uuid();
  const body = {
    query_str: message,
    params: {
      attachments: [],
      frontend_context_uuid: uuid(),
      frontend_uuid: frontendUuid,
      is_incognito: false,
      language: 'en-US',
      last_backend_uuid: (session && session.backend_uuid) || null,
      mode: 'concise',
      model_preference: { auto: { null: 'turbo' } },
      source: 'default',
      sources: ['web'],
      version: '2.18',
    },
  };

  const res = await fetch('https://www.perplexity.ai/rest/sse/perplexity_ask', {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      origin: 'https://www.perplexity.ai',
      referer: 'https://www.perplexity.ai/',
      'user-agent': UA,
    },
    body: JSON.stringify(body),
    signal: signal || undefined,
  });
  if (res.status !== 200) {
    const detail = (await res.text()).slice(0, 200);
    throw new ProviderError(`Perplexity HTTP ${res.status}: ${detail}`, {
      code: res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider',
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }

  const chunks = [];
  await readSSE(
    res,
    (block) => {
      const { event, data } = parseSSEBlock(block);
      if (event === 'message' && data) {
        try {
          chunks.push(enrichPerplexityChunk(JSON.parse(data)));
        } catch {
          /* skip malformed */
        }
      }
    },
    signal,
  );

  const best = pickBestChunk(chunks);
  const answer = best.answer || '';
  if (!answer) throw new ProviderError('No response received from Perplexity.', { code: 'provider', retryable: true });
  if (onDelta) onDelta(answer);
  return {
    content: answer,
    session: {
      backend_uuid: best.backend_uuid || (session && session.backend_uuid) || null,
      attachments: best.attachments || [],
    },
  };
}

/* ── ChatGPT ── */

const CHATGPT_BASE = 'https://chatgpt.com/backend-api';
const DEFAULT_PARENT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';

async function chatgptAccountId() {
  try {
    const res = await fetch(`${CHATGPT_BASE}/me`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const json = await res.json();
      return (json && json.user && json.user.id) || undefined;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

async function chatgptRequirements(userAgent) {
  const config = getConfig(userAgent);
  const requirementsToken = getRequirementsToken(config);
  const res = await fetch(`${CHATGPT_BASE}/sentinel/chat-requirements`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p: requirementsToken }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new ProviderError(`sentinel/chat-requirements failed (${res.status})`, {
      code: res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider',
      retryable: res.status >= 500,
      status: res.status,
    });
  }
  const payload = await res.json();
  const chatToken = payload.token;
  if (!chatToken) throw new ProviderError('Missing sentinel chat token.', { code: 'provider', retryable: false });

  let proofToken = null;
  const pow = payload.proofofwork || {};
  if (pow.required) {
    if (!pow.seed || !pow.difficulty) throw new ProviderError('Incomplete proof-of-work challenge.', { code: 'provider', retryable: false });
    const { token, solved } = getAnswerToken(pow.seed, pow.difficulty, config);
    if (!solved) throw new ProviderError('Failed to solve proof-of-work challenge.', { code: 'provider', retryable: false });
    proofToken = token;
  }
  return { chatToken, proofToken };
}

async function chatgptChat({ message, session, onDelta, signal }) {
  const accountId = await chatgptAccountId();
  const { chatToken, proofToken } = await chatgptRequirements(UA);

  const conversationId = (session && session.conversation_id) || null;
  const parentMessageId = (session && session.parent_message_id) || DEFAULT_PARENT_MESSAGE_ID;
  const messageId = uuid();

  const payload = {
    action: 'next',
    messages: [
      {
        id: messageId,
        author: { role: 'user' },
        content: { content_type: 'text', parts: [message] },
        metadata: {},
      },
    ],
    parent_message_id: parentMessageId,
    model: 'auto',
    timezone_offset_min: -480,
    history_and_training_disabled: false,
    conversation_mode: { kind: 'primary_assistant' },
    force_paragen: false,
    force_rate_limit: false,
    force_use_sse: true,
    reset_rate_limits: false,
    websocket_request_id: uuid(),
    system_hints: [],
    supported_encodings: ['v1'],
    supports_buffering: true,
  };
  if (conversationId) payload.conversation_id = conversationId;

  const headers = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'openai-sentinel-chat-requirements-token': chatToken,
  };
  if (proofToken) headers['openai-sentinel-proof-token'] = proofToken;

  const url = accountId ? `${CHATGPT_BASE}/conversation?account_id=${encodeURIComponent(accountId)}` : `${CHATGPT_BASE}/conversation`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(payload),
    signal: signal || undefined,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new ProviderError(`ChatGPT conversation failed (${res.status}): ${detail}`, {
      code: res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider',
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }

  let lastText = '';
  let convId = null;
  let parentId = null;
  await readSSE(
    res,
    (block) => {
      const { event, data } = parseSSEBlock(block);
      if (event !== 'message' || !data) return;
      if (data === '[DONE]') return;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      if (ev.conversation_id) convId = ev.conversation_id;
      const msg = ev.message || {};
      const msgId = msg.id;
      const role = (msg.author || {}).role;
      if (msgId && role === 'assistant') parentId = msgId;
      const parts = (msg.content || {}).parts || [];
      if (parts.length && typeof parts[0] === 'string') {
        lastText = parts[0];
        if (onDelta) onDelta(parts[0]);
      }
      if (ev.error) throw new ProviderError(String(ev.error), { code: 'provider', retryable: false });
    },
    signal,
  );

  if (!lastText) throw new ProviderError('No response received from ChatGPT.', { code: 'provider', retryable: true });
  const outSession = {};
  if (convId) outSession.conversation_id = convId;
  outSession.parent_message_id = parentId || (convId ? DEFAULT_PARENT_MESSAGE_ID : parentMessageId);
  return { content: lastText, session: outSession };
}

/* ── Gemini ── */

const GEMINI_INIT = 'https://gemini.google.com/app';
const GEMINI_GENERATE =
  'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

function getNestedValue(data, path, def = null) {
  let cur = data;
  for (const key of path) {
    if (typeof key === 'number' && Array.isArray(cur) && key >= -cur.length && key < cur.length) cur = cur[key];
    else if (typeof key === 'string' && cur && typeof cur === 'object' && key in cur) cur = cur[key];
    else return def;
  }
  return cur === null || cur === undefined ? def : cur;
}

export function parseGeminiFrames(content) {
  let text = String(content || '');
  if (text.startsWith(")]}'")) text = text.slice(4);
  text = text.replace(/^\s+/, '');

  const frames = [];
  let pos = 0;
  const total = text.length;
  while (pos < total) {
    while (pos < total && /\s/.test(text[pos])) pos++;
    if (pos >= total) break;
    const m = /^(\d+)\n/.exec(text.slice(pos));
    if (!m) break;
    const length = parseInt(m[1], 10);
    const start = pos + m[0].length;
    const end = Math.min(start + length, total);
    const chunk = text.slice(start, end).trim();
    pos = end;
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) frames.push(...parsed);
      else frames.push(parsed);
    } catch {
      /* skip */
    }
  }

  if (!frames.length) {
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const parsed = JSON.parse(l);
        if (Array.isArray(parsed)) frames.push(...parsed);
        else frames.push(parsed);
      } catch {
        /* skip */
      }
    }
  }
  return frames;
}

export function extractGeminiText(frames) {
  const texts = [];
  for (const frame of frames) {
    const inner = getNestedValue(frame, [2]);
    if (!inner || typeof inner !== 'string') continue;
    let partJson;
    try {
      partJson = JSON.parse(inner);
    } catch {
      continue;
    }
    const candidates = getNestedValue(partJson, [4], []);
    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        const t = getNestedValue(candidate, [1, 0]);
        if (typeof t === 'string' && t.trim()) texts.push(t);
      }
    }
    const fallback = getNestedValue(partJson, [0, 0, 0, 0, 1, 0]);
    if (typeof fallback === 'string' && fallback.trim()) texts.push(fallback);
  }
  if (!texts.length) {
    for (const frame of frames) {
      const blob = JSON.stringify(frame);
      const m = /"\\\\u003cp\\\\u003e([^"\\]+)/.exec(blob);
      if (m) texts.push(m[1]);
    }
  }
  if (!texts.length) return '';
  let best = texts[0];
  for (const t of texts) if (t.length > best.length) best = t;
  return best.replace(/\\n/g, '\n').trim();
}

function extractGeminiSession(frames, session) {
  const updated = { ...session };
  for (const frame of frames) {
    const inner = frame && Array.isArray(frame) && frame.length > 2 ? frame[2] : null;
    if (typeof inner !== 'string') continue;
    let partJson;
    try {
      partJson = JSON.parse(inner);
    } catch {
      continue;
    }
    const meta = partJson && Array.isArray(partJson) && partJson.length > 1 ? partJson[1] : null;
    if (Array.isArray(meta)) {
      if (meta.length > 0 && meta[0]) updated.conversation_id = meta[0];
      if (meta.length > 1 && meta[1]) updated.response_id = meta[1];
    }
    const candidates = partJson && Array.isArray(partJson) && partJson.length > 4 ? partJson[4] : null;
    if (Array.isArray(candidates) && candidates.length) {
      const choice = candidates[0];
      if (Array.isArray(choice) && choice.length && choice[0]) updated.choice_id = choice[0];
    }
  }
  return updated;
}

function buildGeminiPayload(message, session, webSearch = false) {
  const payload = [
    [message, 0, null, [], null, null, 0],
    ['en'],
    [session.conversation_id || '', session.response_id || '', session.choice_id || '', null, null, []],
    null,
    null,
    null,
    [1],
    0,
    [],
    [],
    1,
    0,
  ];
  if (webSearch) {
    while (payload.length <= 16) payload.push(null);
    payload[16] = [[0, [null, null, null, [1]]]];
  }
  return payload;
}

async function geminiInit() {
  const res = await fetch(GEMINI_INIT, { credentials: 'include', signal: AbortSignal.timeout(60000) });
  if (res.status !== 200) {
    throw new ProviderError(`Gemini init failed (${res.status}).`, {
      code: res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider',
      retryable: res.status >= 500,
      status: res.status,
    });
  }
  const html = await res.text();
  const tokenMatch = /"SNlM0e":"([^"]+)"/.exec(html);
  if (!tokenMatch) throw new ProviderError('Could not extract Gemini access token (SNlM0e).', { code: 'unauthorized', retryable: false });
  const buildMatch = /"cfb2h":"([^"]+)"/.exec(html);
  return { accessToken: tokenMatch[1], buildLabel: buildMatch ? buildMatch[1] : null };
}

async function geminiChat({ message, session, onDelta, signal }) {
  const { accessToken, buildLabel } = await geminiInit();
  const currentSession = {
    conversation_id: (session && session.conversation_id) || '',
    response_id: (session && session.response_id) || '',
    choice_id: (session && session.choice_id) || '',
  };

  const reqid = 10000 + Math.floor(Math.random() * 90000) + 100000;
  const params = new URLSearchParams();
  params.set('bl', buildLabel || 'boq_assistant-bard-web-server_20260525.0');
  params.set('_reqid', String(reqid));
  params.set('rt', 'c');

  const data = new URLSearchParams();
  data.set('at', accessToken);
  data.set('f.req', JSON.stringify([null, JSON.stringify(buildGeminiPayload(message, currentSession))]));

  const res = await fetch(`${GEMINI_GENERATE}?${params.toString()}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-same-domain': '1',
      'x-goog-ext-525005358-jspb': `["${uuid().toUpperCase()}",1]`,
    },
    body: data.toString(),
    signal: signal || undefined,
  });
  if (res.status !== 200) {
    const detail = (await res.text()).slice(0, 300);
    throw new ProviderError(`Gemini chat failed (${res.status}): ${detail}`, {
      code: res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider',
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }

  const text = await res.text();
  const frames = parseGeminiFrames(text);
  const answer = extractGeminiText(frames);
  if (!answer) throw new ProviderError('No response received from Gemini.', { code: 'provider', retryable: true });
  if (onDelta) onDelta(answer);
  return { content: answer, session: extractGeminiSession(frames, currentSession) };
}

/* ── Public API (matches the harness client interface) ── */

export async function providers() {
  const results = [];
  const probe = async (id, label, fn) => {
    try {
      const ok = await fn();
      results.push({ id, label, available: ok });
    } catch {
      results.push({ id, label, available: false });
    }
  };
  await Promise.all([
    probe('perplexity', 'Perplexity', async () => {
      const res = await fetch('https://www.perplexity.ai/api/auth/session', { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!res.ok) return false;
      const json = await res.json();
      return !!(json && json.user);
    }),
    probe('chatgpt', 'ChatGPT', async () => {
      const res = await fetch(`${CHATGPT_BASE}/me`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
      return res.ok;
    }),
    probe('gemini', 'Gemini', async () => {
      const res = await fetch(GEMINI_INIT, { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (res.status !== 200) return false;
      const html = await res.text();
      return /"SNlM0e":"[^"]+"/.test(html);
    }),
  ]);
  return results;
}

export async function chat({ provider, message, modelId = 'auto', session = null, onDelta, signal }) {
  const msg = String(message || '').trim();
  if (!msg) throw new ProviderError('Message is required.', { code: 'bad_request', retryable: false });
  if (provider === 'perplexity') return perplexityChat({ message: msg, session, onDelta, signal });
  if (provider === 'chatgpt') return chatgptChat({ message: msg, session, onDelta, signal });
  if (provider === 'gemini') return geminiChat({ message: msg, session, onDelta, signal });
  throw new ProviderError(`Unknown provider: ${provider}`, { code: 'bad_request', retryable: false });
}

export { sleep };