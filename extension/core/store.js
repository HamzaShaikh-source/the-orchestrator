/* store.js — key/value store abstraction.
   ChromeStore: chrome.storage.local (extension runtime).
   MemoryStore: in-memory fallback (tests, non-extension contexts). */

export class ChromeStore {
  constructor(area = 'local') {
    this.area = area;
  }
  async get(key, fallback = null) {
    try {
      const result = await chrome.storage[this.area].get(key);
      return result && key in result ? result[key] : fallback;
    } catch {
      return fallback;
    }
  }
  async set(key, value) {
    await chrome.storage[this.area].set({ [key]: value });
  }
  async remove(key) {
    await chrome.storage[this.area].remove(key);
  }
}

export class MemoryStore {
  constructor() {
    this.data = new Map();
  }
  async get(key, fallback = null) {
    return this.data.has(key) ? this.data.get(key) : fallback;
  }
  async set(key, value) {
    this.data.set(key, value);
  }
  async remove(key) {
    this.data.delete(key);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}