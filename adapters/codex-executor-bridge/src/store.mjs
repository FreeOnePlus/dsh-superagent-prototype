import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export class StateStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.release = lockfile.lockSync(directory, {
      stale: 30000, update: 10000, onCompromised: error => { this.failure = error; },
    });
  }
  assertOwner() {
    if (!this.release || this.failure) throw new Error('Executor state ownership was lost; execution is disabled');
  }
  file(taskId) { return join(this.directory, hash(taskId) + '.json'); }
  read(taskId) {
    this.assertOwner();
    let text;
    try { text = readFileSync(this.file(taskId), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const state = JSON.parse(text);
    if (state.schema !== 1 || state.taskId !== taskId || !Array.isArray(state.requests)) {
      throw new Error('Unsupported or invalid executor state; no automatic migration or replay');
    }
    return state;
  }
  write(state) {
    this.assertOwner();
    const temporary = this.file(state.taskId) + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file(state.taskId));
    const dir = openSync(this.directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  close() { this.release?.(); this.release = null; }
}
