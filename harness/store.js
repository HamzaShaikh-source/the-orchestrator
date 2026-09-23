import { mkdirSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class Store {
  #dbPath;
  #queue = Promise.resolve();

  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.#dbPath = path.join(dir, 'db.json');
  }

  async #load() {
    try {
      const raw = await fsp.readFile(this.#dbPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') return {};
      throw err;
    }
  }

  async #persist(db) {
    const tmp = `${this.#dbPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
      await fsp.rename(tmp, this.#dbPath);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  #serialize(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  async get(key, fallback) {
    const db = await this.#load();
    return Object.prototype.hasOwnProperty.call(db, key) ? db[key] : fallback;
  }

  async set(key, value) {
    return this.#serialize(async () => {
      const db = await this.#load();
      db[key] = value;
      await this.#persist(db);
      return value;
    });
  }

  async delete(key) {
    return this.#serialize(async () => {
      const db = await this.#load();
      delete db[key];
      await this.#persist(db);
    });
  }

  async update(key, fn) {
    return this.#serialize(async () => {
      const db = await this.#load();
      const oldValue = Object.prototype.hasOwnProperty.call(db, key) ? db[key] : undefined;
      const newValue = await fn(oldValue);
      db[key] = newValue;
      await this.#persist(db);
      return newValue;
    });
  }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
