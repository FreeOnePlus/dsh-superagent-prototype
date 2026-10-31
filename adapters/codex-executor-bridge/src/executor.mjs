import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CodexRpc } from './rpc.mjs';
import { StateStore, hash } from './store.mjs';
import { isolatedToolConfig, pluginMcpRestrictions, unexpectedMcpServers } from './tool-boundary.mjs';

export const reportSchema = {
  type: 'object', additionalProperties: false, required: ['state', 'summary'],
  properties: {
    state: { type: 'string', enum: ['ready', 'waiting', 'blocked', 'failed'] },
    summary: { type: 'string' },
  },
};
const finalStates = new Set(['completed', 'failed', 'interrupted']);
const now = () => new Date().toISOString();
const copy = value => structuredClone(value);
function textField(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text`);
}
function outcome(turn, messages = []) {
  if (!['completed', 'failed', 'interrupted'].includes(turn.status)) return null;
  const result = { status: turn.status, turnId: turn.id, finishedAt: now() };
  if (turn.status === 'completed') {
    const items = (turn.items?.length ? turn.items : messages).filter(x => x.type === 'agentMessage');
    const item = items.filter(x => x.phase === 'final_answer').at(-1) ?? items.at(-1);
    try {
      const report = JSON.parse(item?.text ?? '');
      if (!report || typeof report !== 'object' || Array.isArray(report)
        || Object.keys(report).some(key => !['state', 'summary'].includes(key))
        || !reportSchema.properties.state.enum.includes(report.state) || typeof report.summary !== 'string' || !report.summary.trim()) {
        throw new Error('Invalid report');
      }
      result.report = { state: report.state, summary: report.summary };
    } catch {
      return { ...result, status: 'failed', error: 'Codex finished without a valid structured work report' };
    }
  } else if (turn.error) result.error = turn.error.message ?? 'Codex turn failed';
  return result;
}

/** Durable task-to-thread mapping; business acceptance remains the caller's responsibility. */
export class CodexExecutor extends EventEmitter {
  constructor({ stateDir, command, model, sandbox = 'workspace-write', timeoutMs = 30000,
    turnTimeoutMs = 30 * 60 * 1000, rpcFactory } = {}) {
    super();
    if (!stateDir || !isAbsolute(stateDir)) throw new Error('stateDir must be an absolute path');
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Only read-only and workspace-write sandboxes are supported');
    this.store = new StateStore(stateDir);
    this.options = { command, model, sandbox, timeoutMs, turnTimeoutMs };
    this.rpcFactory = rpcFactory ?? (options => new CodexRpc(options));
    this.active = new Map(); this.clients = new Map(); this.closed = false;
  }
  status(taskId) { return this.store.read(taskId); }
  run({ taskId, requestId, cwd, prompt, env = {}, metadata = {}, onAccepted = () => {} }) {
    try {
      if (this.closed) throw new Error('Executor is closed');
      for (const [key, value] of Object.entries({ taskId, requestId, prompt })) textField(value, key);
      if (!isAbsolute(cwd)) throw new Error('cwd must be an absolute directory');
      cwd = realpathSync(cwd);
      if (prompt.length > 1024 * 1024) throw new Error('Request exceeds the 1 MiB text limit; split the assignment explicitly');
      const binding = hash({ cwd, model: this.options.model, sandbox: this.options.sandbox,
        env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) });
      const fingerprint = hash({ prompt, binding, metadata });
      const live = this.active.get(taskId);
      if (live) {
        if (live.requestId === requestId && live.fingerprint === fingerprint) return live.promise;
        throw new Error('Task already has an active request; queue follow-ups after its receipt');
      }
      let state = this.store.read(taskId);
      if (state && state.binding !== binding) throw new Error('Task workspace or execution configuration changed; use a distinct task identity');
      const previous = state?.requests.find(x => x.requestId === requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Request ID was reused with different content');
        if (!finalStates.has(previous.status)) throw new Error('Request outcome is unknown; recover it before submitting or retrying');
        return Promise.resolve({ ...copy(previous), taskId, threadId: state.threadId });
      }
      if (state?.requests.some(x => !finalStates.has(x.status))) throw new Error('Task has an unresolved execution; query recovery before new work');
      state ??= { schema: 1, taskId, cwd, binding, threadId: null, requests: [] };
      const request = { requestId, fingerprint, metadata: copy(metadata), status: 'prepared', createdAt: now(), turnId: null };
      state.requests.push(request); this.store.write(state);
      const active = { requestId, fingerprint, cancel: false, request, state };
      this.active.set(taskId, active);
      active.promise = this.execute(active, prompt, env, onAccepted).finally(() => this.active.delete(taskId));
      return active.promise;
    } catch (error) { return Promise.reject(error); }
  }
  async client(state, env = {}) {
    let client = this.clients.get(state.taskId);
    if (client?.failure) { await client.close(); this.clients.delete(state.taskId); client = null; }
    if (client) return client;
    client = this.rpcFactory({ ...this.options, cwd: state.cwd, env });
    this.clients.set(state.taskId, client);
    try { await client.initialize(); }
    catch (error) { await client.close(); this.clients.delete(state.taskId); throw error; }
    return client;
  }
  async discardClient(state, client) {
    if (this.clients.get(state.taskId) !== client) return;
    this.clients.delete(state.taskId);
    await client.close();
  }
  async thread(active, client, env, retried = false) {
    const { state } = active;
    // Read effective config only in memory. Persist only generated plugin/server disable flags.
    const { config } = await client.request('config/read', { cwd: state.cwd, includeLayers: false });
    const configOverrides = isolatedToolConfig(config, state.pluginRestrictions ?? {}, { shellTool: true });
    const params = {
      cwd: state.cwd,
      approvalPolicy: 'never',
      sandbox: this.options.sandbox,
      ...(this.options.model ? { model: this.options.model } : {}),
      config: configOverrides,
      developerInstructions: 'This is a bounded execution assignment. Preserve existing changes and obey project instructions. '
        + 'Do not delegate to other agents. Use rtk for shell commands when available. '
        + 'Return a structured report: ready only when the requested work and relevant checks are complete; '
        + 'waiting for a follow-up; blocked when a missing decision or permission prevents progress; failed for an execution failure. '
        + 'Report observed facts and remaining work. Your report is not an independent approval, merge, release, or AWR acceptance.',
    };
    const previousThread = state.threadId;
    const response = state.threadId
      ? await client.request('thread/resume', { ...params, threadId: state.threadId, excludeTurns: true })
      : await client.request('thread/start', { ...params, environments: [] });
    if (!response?.thread?.id || (state.threadId && response.thread.id !== state.threadId)) {
      throw new Error('Incompatible Codex thread response');
    }
    state.threadId = response.thread.id; this.store.write(state);
    const unexpected = await unexpectedMcpServers(client, state.threadId, 'Cannot verify the worker tool boundary');
    if (!unexpected.length) return client;
    const restrictions = pluginMcpRestrictions(configOverrides.plugins, unexpected);
    state.threadId = previousThread;
    if (restrictions) state.pluginRestrictions = restrictions;
    this.store.write(state);
    await this.discardClient(state, client);
    if (retried || !restrictions) throw new Error('Unexpected MCP tools remain enabled for the worker');
    if (this.closed || active.cancel) return client;
    const replacement = await this.client(state, env);
    active.client = replacement;
    return this.thread(active, replacement, env, true);
  }
  async execute(active, prompt, env, onAccepted) {
    const { state, request } = active;
    const previousThread = state.threadId;
    let client, unsubscribe = () => {}, sent = false, timer;
    try {
      client = active.client = await this.client(state, env);
      if (active.cancel) return this.finish(state, request, { status: 'interrupted', finishedAt: now() });
      client = active.client = await this.thread(active, client, env);
      if (active.cancel) return this.finish(state, request, { status: 'interrupted', finishedAt: now() });
      const messages = []; const early = [];
      let resolveTurn, rejectTurn, interaction;
      const ended = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      // Install the rejection handler before turn/start, which itself can fail.
      ended.catch(() => {});
      const receive = ({ method, params: event }) => {
        if (event?.threadId !== state.threadId) return;
        if (!request.turnId) { early.push({ method, params: event }); return; }
        if ((event.turnId ?? event.turn?.id) !== request.turnId) return;
        if (method === 'turn/started') {
          active.started = true;
          if (active.cancel) void this.interrupt(active).catch(rejectTurn);
        }
        if (method === 'item/completed' && event.item?.type === 'agentMessage') messages.push(event.item);
        if (method === 'turn/completed') { active.terminal = true; resolveTurn(event.turn); }
        if (method === 'thread/tokenUsage/updated') { request.usage = event.tokenUsage; this.store.write(state); }
        this.emit('progress', { taskId: state.taskId, requestId: request.requestId, method, turnId: request.turnId });
      };
      const disconnected = error => rejectTurn(error);
      const needsInteraction = event => { interaction = event.method; void this.stop(state.taskId).catch(rejectTurn); };
      client.on('notification', receive); client.on('disconnected', disconnected); client.on('interactionRequired', needsInteraction);
      unsubscribe = () => {
        client.off('notification', receive); client.off('disconnected', disconnected); client.off('interactionRequired', needsInteraction);
      };
      request.status = 'submitting'; this.store.write(state); sent = true;
      const started = await client.request('turn/start', {
        threadId: state.threadId, input: [{ type: 'text', text: prompt }], outputSchema: reportSchema, environments: [],
      });
      if (!started?.turn?.id) throw new Error('Incompatible Codex turn response');
      request.turnId = started.turn.id; request.status = 'running'; this.store.write(state);
      for (const event of early.splice(0)) receive(event);
      // The receipt is durable before the host acknowledges assignment or input delivery.
      await onAccepted({ threadId: state.threadId, turnId: request.turnId });
      this.emit('accepted', { taskId: state.taskId, requestId: request.requestId, threadId: state.threadId, turnId: request.turnId });
      if (active.cancel) await this.interrupt(active);
      timer = setTimeout(() => {
        void this.stop(state.taskId).catch(() => {});
        rejectTurn(new Error('Turn deadline exceeded; inspect the saved turn before resuming'));
      }, this.options.turnTimeoutMs);
      const turn = await ended;
      const result = outcome(turn, messages);
      if (!result) throw new Error('Unknown Codex terminal status');
      if (interaction) Object.assign(result, { status: 'failed', report: { state: 'blocked', summary: `An interactive client is required for ${interaction}` } });
      return this.finish(state, request, result);
    } catch (error) {
      try {
        if (!sent) state.threadId = previousThread;
        return this.finish(state, request, {
          status: sent ? 'unknown' : 'failed', error: error.message, finishedAt: now(),
        });
      } finally {
        // Do not retain an owned process after any failed startup or uncertain turn.
        if (active.client) await this.discardClient(state, active.client);
      }
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  finish(state, request, result) {
    Object.assign(request, result); this.store.write(state);
    const receipt = { ...copy(request), taskId: state.taskId, threadId: state.threadId };
    this.emit('receipt', receipt); return receipt;
  }
  async interrupt(active) {
    if (active.terminal) return;
    if (active.started && active.request.turnId && !finalStates.has(active.request.status)) {
      active.interruptPromise ??= active.client.request('turn/interrupt', { threadId: active.state.threadId, turnId: active.request.turnId });
      await active.interruptPromise;
    }
  }
  async stop(taskId) {
    const active = this.active.get(taskId);
    if (!active) return { requested: false, status: this.status(taskId)?.requests.at(-1)?.status ?? 'absent' };
    active.cancel = true;
    await this.interrupt(active);
    // A successful interrupt RPC acknowledges only the request. The receipt confirms interruption.
    return { requested: true, confirmed: false };
  }
  async recover(taskId, env = {}) {
    if (this.active.has(taskId)) return this.status(taskId);
    const state = this.store.read(taskId);
    if (!state) return null;
    const pending = state.requests.filter(x => !finalStates.has(x.status));
    if (!pending.length) return state;
    if (!state.threadId) {
      for (const request of pending) Object.assign(request, { status: 'unknown', error: 'No thread acknowledgement is available; no automatic replay' });
      this.store.write(state); return copy(state);
    }
    const client = await this.client(state, env);
    for (const request of pending) {
      if (!request.turnId) {
        Object.assign(request, { status: 'unknown', error: 'No turn acknowledgement is available; no automatic replay' });
        continue;
      }
      let cursor, found;
      do {
        const page = await client.request('thread/turns/list', {
          threadId: state.threadId, itemsView: 'full', limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page?.data)) throw new Error('Codex does not support the required recovery protocol');
        found = page.data.find(x => x.id === request.turnId); cursor = page.nextCursor;
      } while (!found && cursor);
      const result = found && outcome(found);
      if (result) Object.assign(request, result, { recoveredAt: now() });
      else Object.assign(request, { status: 'unknown', error: 'No terminal receipt is available; no automatic replay' });
    }
    this.store.write(state); return copy(state);
  }
  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.active.keys()].map(key => this.stop(key)));
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    await Promise.allSettled([...this.active.values()].map(active => active.promise));
    this.clients.clear(); this.store.close();
  }
}
