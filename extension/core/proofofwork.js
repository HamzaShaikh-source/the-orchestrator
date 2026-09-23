/* proofofwork.js — ChatGPT sentinel proof-of-work (port of Web2API chatgpt/proofofwork.py).
   Uses pure-JS SHA3-512 (Web Crypto has no SHA3). */

import { sha3_512 } from './sha3.js';

const CORES = [8, 16, 24, 32];
const TIME_LAYOUT = '%a %b %d %Y %H:%M:%S';
const DEFAULT_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js';
const DEFAULT_DPL = 'prod-416f923815498ec49bee0e42b239a45b74e8e0c9';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getParseTime() {
  // Eastern Standard Time (UTC-5), matching the Python port
  const now = new Date(Date.now() - 5 * 3600 * 1000);
  const s = `${DAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, '0')} ${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
  return `${s} GMT-0500 (Eastern Standard Time)`;
}

export function getConfig(userAgent, { dpl = DEFAULT_DPL } = {}) {
  return [
    [1920 + 1080, 2560 + 1440, 1920 + 1200, 2560 + 1600][Math.floor(Math.random() * 4)],
    getParseTime(),
    4294705152,
    0,
    userAgent,
    DEFAULT_SCRIPT,
    dpl,
    'en-US',
    'en-US,es-US,en,es',
    0,
    'webdriver-false',
    'location',
    'window',
    performance.now(),
    crypto.randomUUID(),
    '',
    CORES[Math.floor(Math.random() * CORES.length)],
    Date.now() - performance.now(),
  ];
}

/* bytes -> standard base64 (no padding issues; python pybase64.b64encode) */
export function b64encode(bytes) {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? CHARS[b2 & 63] : '=';
  }
  return out;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function jsonCompact(value) {
  return JSON.stringify(value, null, 0);
}

export function generateAnswer(seed, diff, config) {
  const diffLen = diff.length;
  const seedEncoded = utf8Bytes(seed);
  const staticConfigPart1 = utf8Bytes(jsonCompact(config.slice(0, 3)).slice(0, -1) + ',');
  const staticConfigPart2 = utf8Bytes(',' + jsonCompact(config.slice(4, 9)).slice(1, -1) + ',');
  const staticConfigPart3 = utf8Bytes(',' + jsonCompact(config.slice(10)).slice(1));
  const targetDiff = new Uint8Array(diff.match(/../g).map((h) => parseInt(h, 16)));

  for (let i = 0; i < 500000; i++) {
    const dynamicI = utf8Bytes(String(i));
    const dynamicJ = utf8Bytes(String(i >> 1));
    const parts = [staticConfigPart1, dynamicI, staticConfigPart2, dynamicJ, staticConfigPart3];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const finalBytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      finalBytes.set(p, off);
      off += p.length;
    }
    const baseEncoded = utf8Bytes(b64encode(finalBytes));
    const hash = sha3_512(concatBytes(seedEncoded, baseEncoded));
    let ok = true;
    for (let k = 0; k < diffLen; k++) {
      if (hash[k] > targetDiff[k]) { ok = false; break; }
      if (hash[k] < targetDiff[k]) break;
    }
    if (ok) return { answer: b64encode(finalBytes), solved: true };
  }

  const fallback = 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + b64encode(utf8Bytes(`"${seed}"`));
  return { answer: fallback, solved: false };
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function getRequirementsToken(config) {
  const { answer } = generateAnswer(String(Math.random()), '0fffff', config);
  return 'gAAAAAC' + answer;
}

export function getAnswerToken(seed, diff, config) {
  const { answer, solved } = generateAnswer(seed, diff, config);
  return { token: 'gAAAAAB' + answer, solved };
}