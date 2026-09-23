export class Web2ApiError extends Error {
  constructor(message, { code, retryable, status } = {}) {
    super(message);
    this.name = 'Web2ApiError';
    this.code = code ?? 'provider';
    this.retryable = retryable ?? false;
    this.status = status ?? 0;
  }
}

export const RETRY_POLICY = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 30000 };

const MAX_TURN_CHARS = 7500;

function cancelledError() {
  return new Web2ApiError('Request cancelled', { code: 'cancelled', retryable: false });
}

function networkError(err) {
  return new Web2ApiError(err?.message || 'Network request failed', { code: 'network', retryable: true });
}

export function splitTurns(message, budget = MAX_TURN_CHARS) {
  if (message.length <= budget) return [message];
  const turns = [];
  let rest = message;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = budget;
    turns.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  turns.push(rest);
  return turns;
}

async function mapHttpError(res) {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    // body unavailable
  }
  let msg = detail;
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed.detail === 'string') msg = parsed.detail;
  } catch {
    // keep raw text
  }
  if (!msg) msg = `HTTP ${res.status}`;
  const status = res.status;
  if (status === 429) return new Web2ApiError(msg, { code: 'rate_limit', retryable: true, status });
  if (status === 401 || status === 403) return new Web2ApiError(msg, { code: 'unauthorized', retryable: false, status });
  if (status === 503) {
    if (/not configured/i.test(detail)) return new Web2ApiError(msg, { code: 'unconfigured', retryable: false, status });
    return new Web2ApiError(msg, { code: 'provider', retryable: true, status });
  }
  if (status >= 500) return new Web2ApiError(msg, { code: 'provider', retryable: true, status });
  return new Web2ApiError(msg, { code: 'bad_request', retryable: false, status });
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Web2ApiClient {
  constructor({ baseUrl = 'http://127.0.0.1:8080', apiKey = '', timeoutMs = 600000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  #headers(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async #fetchOrMap(url, init, externalSignal, state) {
    const controller = new AbortController();
    state.controller = controller;
    state.timedOut = false;
    state.timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    state.onExternalAbort = onExternalAbort;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(state.timer);
        throw cancelledError();
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw this.#mapAbort(err, externalSignal, state);
    }
  }

  #mapAbort(err, externalSignal, state) {
    if (state?.timedOut) {
      return new Web2ApiError(`Request timed out after ${this.timeoutMs}ms`, { code: 'timeout', retryable: true });
    }
    if (externalSignal?.aborted) return cancelledError();
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return err;
    return networkError(err);
  }

  #cleanup(externalSignal, state) {
    if (state?.timer) clearTimeout(state.timer);
    if (externalSignal && state?.onExternalAbort) {
      externalSignal.removeEventListener('abort', state.onExternalAbort);
    }
  }

  async #readSse(res, onDelta, externalSignal, state) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let donePayload = null;
    let eventError = null;

    const handleBlock = (block) => {
      if (!block.trim()) return;
      let event = 'message';
      const dataLines = [];
      for (const rawLine of block.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) return;
      let payload;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        return;
      }
      if (event === 'delta') {
        onDelta?.(payload.content);
      } else if (event === 'done') {
        donePayload = payload;
      } else if (event === 'error') {
        eventError = new Web2ApiError(payload.message || 'Provider error', { code: 'provider', retryable: true });
      }
    };

    try {
      while (!(donePayload || eventError)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          handleBlock(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (donePayload || eventError) break;
        }
      }
      buffer += decoder.decode();
      if (!donePayload && !eventError && buffer.trim()) handleBlock(buffer);
    } catch (err) {
      throw this.#mapAbort(err, externalSignal, state);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }

    if (eventError) throw eventError;
    if (donePayload) return donePayload;
    throw new Web2ApiError('Stream ended without done event', { code: 'provider', retryable: true });
  }

  async #streamChatOnce({ provider, message, modelId, webSearch, session, onDelta, signal }) {
    const state = {};
    try {
      const res = await this.#fetchOrMap(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: this.#headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
          body: JSON.stringify({
            provider,
            message,
            model_id: modelId,
            web_search: webSearch,
            session: session ?? null,
          }),
        },
        signal,
        state,
      );
      if (!res.ok) {
        let err;
        try {
          err = await mapHttpError(res);
        } catch (mapErr) {
          throw this.#mapAbort(mapErr, signal, state);
        }
        throw err;
      }
      return await this.#readSse(res, onDelta, signal, state);
    } finally {
      this.#cleanup(signal, state);
    }
  }

  async #withRetry(fn, signal) {
    const { maxAttempts, baseDelayMs, maxDelayMs } = RETRY_POLICY;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (signal?.aborted) throw cancelledError();
      try {
        return await fn();
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        const webErr = err instanceof Web2ApiError ? err : networkError(err);
        if (!webErr.retryable || attempt >= maxAttempts) throw webErr;
        const delay = Math.min(
          maxDelayMs,
          baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs),
        );
        console.log(`[Client] retry ${attempt}/${maxAttempts} after ${webErr.code} (wait ${delay}ms)`);
        await abortableSleep(delay, signal);
      }
    }
  }

  async health() {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { headers: this.#headers() });
      if (!res.ok) throw await mapHttpError(res);
      return await res.json();
    } catch (err) {
      if (err instanceof Web2ApiError) throw err;
      if (err && err.name === 'AbortError') throw err;
      throw networkError(err);
    }
  }

  async providers() {
    try {
      const res = await fetch(`${this.baseUrl}/api/providers`, {
        headers: this.#headers({ Accept: 'application/json' }),
      });
      if (!res.ok) throw await mapHttpError(res);
      const json = await res.json();
      if (Array.isArray(json)) return json;
      if (json && Array.isArray(json.providers)) return json.providers;
      return [];
    } catch (err) {
      if (err instanceof Web2ApiError) throw err;
      if (err && err.name === 'AbortError') throw err;
      throw networkError(err);
    }
  }

  async chat({ provider, message, modelId = 'auto', webSearch = true, session = null, onDelta, signal }) {
    const turns = splitTurns(message, MAX_TURN_CHARS);
    let currentSession = session ?? null;
    let combined = '';
    for (const turn of turns) {
      const done = await this.#withRetry(
        () => this.#streamChatOnce({ provider, message: turn, modelId, webSearch, session: currentSession, onDelta, signal }),
        signal,
      );
      combined += typeof done.content === 'string' ? done.content : '';
      currentSession = done.session ?? null;
    }
    return { content: combined, session: currentSession, provider };
  }
}
