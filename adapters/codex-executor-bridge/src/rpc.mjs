import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class RpcError extends Error {
  constructor(message, code = 'TRANSPORT', ambiguous = false) {
    super(message); this.code = code; this.ambiguous = ambiguous;
  }
}

/** One owned stdio connection. No private files or interactive output parsing. */
export class CodexRpc extends EventEmitter {
  constructor({ command = ['codex', 'app-server'], cwd, env = {}, timeoutMs = 30000 } = {}) {
    super();
    if (!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string')) {
      throw new Error('command must be a non-empty argument array');
    }
    this.sequence = 0; this.pending = new Map(); this.timeoutMs = timeoutMs;
    this.process = spawn(command[0], command.slice(1), {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.process.stdin.on('error', error => this.fail(new RpcError(error.message, 'WRITE', true)));
    this.process.on('error', error => this.fail(new RpcError(error.message)));
    this.process.on('exit', (code, signal) => this.fail(new RpcError(`Codex connection closed (${code ?? signal})`, 'CLOSED', true)));
    // stderr may contain local paths or tool diagnostics; do not relay it as protocol data.
    this.process.stderr.on('data', () => {});
    let buffer = '';
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.length > 16 * 1024 * 1024) { this.fail(new RpcError('Oversized protocol message')); return; }
        if (line.trim()) {
          try { this.receive(JSON.parse(line)); }
          catch { this.fail(new RpcError('Invalid Codex protocol message', 'PROTOCOL', true)); }
        }
      }
      if (buffer.length > 16 * 1024 * 1024) this.fail(new RpcError('Oversized protocol buffer', 'PROTOCOL', true));
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'originone_executor_bridge', title: 'Codex Executor Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }
  send(message) {
    if (this.failure) throw this.failure;
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Codex request timed out: ${method}`, 'TIMEOUT', true));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (message.method && message.id !== undefined) {
      // This non-interactive bridge never silently grants a server-initiated approval.
      const decision = {
        'item/commandExecution/requestApproval': { decision: 'decline' },
        'item/fileChange/requestApproval': { decision: 'decline' },
      }[message.method];
      this.send(decision ? { id: message.id, result: decision }
        : { id: message.id, error: { code: -32601, message: 'This executor has no interactive approval channel' } });
      this.emit('interactionRequired', { method: message.method, params: message.params });
    } else if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new RpcError(message.error.message, message.error.code));
      else entry.resolve(message.result);
    } else if (message.method) this.emit('notification', message);
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.emit('disconnected', error);
  }
  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.end();
    await new Promise(resolve => {
      let killTimer;
      const timer = setTimeout(() => {
        this.process.kill('SIGTERM');
        killTimer = setTimeout(() => this.process.kill('SIGKILL'), 1500);
      }, 1500);
      this.process.once('exit', () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); });
    });
  }
}
