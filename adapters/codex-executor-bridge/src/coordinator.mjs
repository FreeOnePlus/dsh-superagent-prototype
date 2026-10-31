import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CodexRpc } from './rpc.mjs';
import { StateStore, hash } from './store.mjs';
import { isolatedToolConfig, pluginMcpRestrictions, unexpectedMcpServers } from './tool-boundary.mjs';

const terminal = new Set(['completed', 'failed', 'interrupted']);
const now = () => new Date().toISOString();
const reply = (value, success = true) => {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') throw new Error('Tool result must be JSON serializable');
  return { contentItems: [{ type: 'inputText', text }], success };
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty text`);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}

/** One durable coordinator inbox. Domain authorization remains in the supplied host. */
export class CodexCoordinator extends EventEmitter {
  constructor({ host, cwd = host?.stateDir, stateDir = host && join(host.stateDir, 'codex-coordinator-state'),
    command, model, timeoutMs = 30000, turnTimeoutMs = 600000, rpcFactory } = {}) {
    super();
    requiredText(host?.id, 'host.id');
    for (const method of ['prompt', 'tools', 'validateTool', 'executeTool', 'health']) {
      if (typeof host[method] !== 'function') throw new Error(`host.${method} must be a function`);
    }
    if (!isAbsolute(cwd) || !isAbsolute(stateDir)) throw new Error('Coordinator paths must be absolute');
    this.host = host; this.cwd = realpathSync(cwd);
    this.options = { command, model, timeoutMs, turnTimeoutMs };
    this.rpcFactory = rpcFactory ?? (options => new CodexRpc(options));
    this.tools = structuredClone(host.tools());
    if (!Array.isArray(this.tools) || !this.tools.length || new Set(this.tools.map(t => t.name)).size !== this.tools.length) {
      throw new Error('Coordinator tools must have unique names');
    }
    for (const tool of this.tools) {
      requiredText(tool.name, 'tool.name'); requiredText(tool.description, 'tool.description');
      if (!tool.inputSchema || typeof tool.inputSchema !== 'object') throw new Error('Tool inputSchema is required');
      if (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') throw new Error('Tool readOnly must be boolean');
    }
    this.binding = hash(stable({ cwd: this.cwd, model, tools: this.tools }));
    this.store = new StateStore(stateDir);
    try {
      this.state = this.store.read(host.id) ?? { schema: 1, kind: 'coordinator', taskId: host.id,
        binding: this.binding, threadId: null, requests: [] };
      if (this.state.kind !== 'coordinator' || this.state.binding !== this.binding) {
        throw new Error('Coordinator configuration changed; explicitly migrate or use a separate state directory');
      }
      this.store.write(this.state);
    } catch (error) { this.store.close(); throw error; }
    this.closed = false; this.started = false; this.toolTail = Promise.resolve();
    this.abort = () => { void this.shutdown().catch(error => this.emit('fault', error)); };
    host.lifetime?.addEventListener('abort', this.abort, { once: true });
  }
  save() { this.store.write(this.state); }
  holds(id) { return this.state.requests.some(r => r.requestId === id); }
  unresolved() {
    return this.state.requests.find(r => ['submitting', 'running', 'unknown'].includes(r.status)
      || r.calls?.some(c => c.status !== 'completed'));
  }
  status() {
    const uncertain = this.unresolved();
    return { backend: 'codex', threadId: this.state.threadId, started: this.started, closed: this.closed,
      activeRequestId: this.active?.request.requestId ?? null,
      queued: this.state.requests.filter(r => r.status === 'queued').length,
      blocked: !!uncertain && !this.active, unresolvedRequestId: uncertain?.requestId ?? null,
      last: this.state.requests.filter(r => r.wake && r.status !== 'queued').at(-1)?.status ?? null };
  }
  health(state, detail) {
    this.host.health({ state, detail, at: now() });
    this.emit('status', this.status());
  }
  async start() {
    if (this.closed) throw new Error('Coordinator is closed');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.host.lifetime?.throwIfAborted();
      await this.recover();
      if (this.closed) return;
      this.started = true;
      this.health(this.unresolved() ? 'error' : 'ready', this.unresolved() ? 'An uncertain coordinator outcome needs inspection' : 'Coordinator inbox is ready');
      this.kick();
    })();
    try { await this.starting; } catch (error) { this.starting = null; throw error; }
  }
  async deliver({ id, text, wake = true }) {
    if (this.closed || this.host.lifetime?.aborted) throw new Error('Coordinator is closing');
    requiredText(id, 'message.id'); requiredText(text, 'message.text');
    if (typeof wake !== 'boolean' || text.length > 1024 * 1024) throw new Error('Invalid message wake flag or text size');
    const fingerprint = hash({ text, wake });
    const previous = this.state.requests.find(r => r.requestId === id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Message ID was reused with different content');
      return;
    }
    this.state.requests.push({ requestId: id, text, wake, fingerprint, status: 'queued', createdAt: now(), turnId: null, calls: [] });
    this.save(); this.kick();
  }
  kick() {
    if (!this.started || this.closed || this.pumping || this.unresolved()) return;
    this.pumping = this.pump().catch(error => {
      this.health('error', 'Coordinator processing stopped; inspect its recorded outcome');
      this.emit('fault', error);
    }).finally(() => {
      this.pumping = null;
      if (!this.closed && !this.unresolved() && this.state.requests.some(r => r.status === 'queued' && r.wake)) this.kick();
    });
  }
  async idle() { while (this.pumping) await this.pumping; }
  async pump() {
    while (!this.closed && !this.unresolved()) {
      const index = this.state.requests.findIndex(r => r.status === 'queued' && r.wake);
      if (index < 0) return;
      const request = this.state.requests[index];
      const notices = this.state.requests.slice(0, index).filter(r => !r.wake && r.status === 'queued');
      await this.execute(request, notices);
    }
  }
  async client() {
    if (this.rpc && !this.rpc.failure) return this.rpc;
    if (this.rpc) await this.rpc.close();
    const client = this.rpcFactory({ ...this.options, cwd: this.cwd, experimentalApi: true,
      onToolCall: params => this.callTool(params) });
    this.rpc = client;
    try { await client.initialize(); }
    catch (error) { await client.close(); this.rpc = null; throw error; }
    return client;
  }
  async thread(client, prompt, retried = false) {
    // Read effective config only in memory. Never store or log credentials/config values.
    const { config } = await client.request('config/read', { cwd: this.cwd, includeLayers: false });
    const overrides = isolatedToolConfig(config, this.state.pluginRestrictions ?? {}, { shellTool: false });
    const params = { cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never',
      ...(this.options.model ? { model: this.options.model } : {}),
      config: overrides,
      developerInstructions: prompt.text + '\n\nUse only the supplied coordinator tools for domain operations. '
        + 'Messages are serialized; worker results arrive as later messages. End your turn instead of waiting. '
        + 'Never treat a textual answer as a recorded routing decision or a sent source reply. '
        + 'Do not create subagents, execute code, or access unrelated tools. The host validates all domain actions.' };
    const previousThread = this.state.threadId;
    const response = this.state.threadId
      ? await client.request('thread/resume', { ...params, threadId: this.state.threadId, excludeTurns: true })
      : await client.request('thread/start', { ...params, environments: [],
        dynamicTools: this.tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) });
    if (!response?.thread?.id || (this.state.threadId && response.thread.id !== this.state.threadId)) throw new Error('Incompatible coordinator thread response');
    this.state.threadId = response.thread.id; this.save();
    // Bundled plugin MCP servers may not appear in config/read. Scope just their
    // tools off after discovery; retain the plugins and their safety hooks.
    const unexpected = await unexpectedMcpServers(client, this.state.threadId, 'Cannot verify the coordinator tool boundary');
    if (!unexpected.length) return client;
    const restrictions = pluginMcpRestrictions(overrides.plugins, unexpected);
    if (retried || !restrictions) throw new Error('Unexpected MCP tools remain enabled for the coordinator');
    // Reloading a loaded thread does not rebuild its plugin tool connections.
    // No turn has started, so replace only this owned process and keep the
    // previously durable conversation (if any) for the fresh connection.
    this.state.pluginRestrictions = restrictions;
    this.state.threadId = previousThread; this.save();
    await client.close(); this.rpc = null;
    if (this.closed) throw new Error('Coordinator is closing');
    return this.thread(await this.client(), prompt, true);
  }
  async execute(request, notices) {
    const active = { request, accepted: deferred(), ended: deferred(), controller: new AbortController(), started: false, terminal: false, cancel: false };
    this.active = active;
    let client, timer, unsubscribe = () => {}, submitted = false;
    try {
      const prompt = this.host.prompt(); requiredText(prompt.text, 'prompt.text');
      request.promptRevision = prompt.revision;
      request.noticeIds = notices.map(n => n.requestId);
      client = await this.client();
      client = await this.thread(client, prompt);
      if (this.closed) return;
      const early = [];
      const receive = ({ method, params }) => {
        if (params?.threadId !== this.state.threadId) return;
        if (!request.turnId) { early.push({ method, params }); return; }
        if ((params.turnId ?? params.turn?.id) !== request.turnId) return;
        if (method === 'turn/started') {
          active.started = true;
          if (active.cancel) void this.interrupt(active).catch(active.ended.reject);
        }
        if (method === 'item/completed' && params.item?.type === 'agentMessage') request.lastMessage = params.item.text;
        if (method === 'thread/tokenUsage/updated') { request.usage = params.tokenUsage; this.save(); }
        if (method === 'turn/completed') { active.terminal = true; active.ended.resolve(params.turn); }
        this.emit('progress', { requestId: request.requestId, threadId: this.state.threadId, turnId: request.turnId, method });
      };
      const disconnected = error => active.ended.reject(error);
      const interaction = () => { active.ended.reject(new Error('Coordinator requires an unsupported interactive action')); };
      client.on('notification', receive); client.on('disconnected', disconnected); client.on('interactionRequired', interaction);
      unsubscribe = () => { client.off('notification', receive); client.off('disconnected', disconnected); client.off('interactionRequired', interaction); };
      request.status = 'submitting'; this.save(); submitted = true;
      const input = [...notices.map(n => ({ type: 'text', text: n.text })), { type: 'text', text: request.text }];
      const result = await client.request('turn/start', { threadId: this.state.threadId, input, environments: [], clientUserMessageId: hash(request.requestId) });
      if (!result?.turn?.id) throw new Error('Missing coordinator turn acknowledgement');
      request.turnId = result.turn.id; request.status = 'running'; this.save();
      active.accepted.resolve();
      for (const event of early) receive(event);
      this.emit('accepted', { requestId: request.requestId, threadId: this.state.threadId, turnId: request.turnId });
      if (active.cancel) await this.interrupt(active);
      timer = setTimeout(() => active.ended.reject(new Error('Coordinator turn deadline exceeded')), this.options.turnTimeoutMs);
      const turn = await active.ended.promise;
      await this.toolTail;
      if (!terminal.has(turn.status)) throw new Error('Unknown coordinator terminal status');
      if (request.calls.some(c => c.status !== 'completed')) throw new Error('A coordinator tool outcome is uncertain');
      request.status = turn.status; request.finishedAt = now();
      for (const n of notices) { n.status = 'completed'; n.consumedBy = request.requestId; }
      this.save();
      this.emit('receipt', structuredClone(request));
      this.health(turn.status === 'completed' ? 'ready' : 'error', `Coordinator turn ${turn.status}`);
    } catch (error) {
      active.accepted.reject(error); active.controller.abort();
      request.status = submitted ? 'unknown' : 'failed'; request.error = error.message; request.finishedAt = now();
      if (!submitted && !this.state.requests.some(r => r.turnId || ['submitting', 'running', 'unknown'].includes(r.status))) this.state.threadId = null;
      this.save();
      if (client) { await client.close(); if (this.rpc === client) this.rpc = null; }
      this.health('error', submitted ? 'Coordinator outcome is uncertain; automatic replay is blocked' : 'Coordinator could not start its turn');
      this.emit('receipt', structuredClone(request));
    } finally {
      clearTimeout(timer); unsubscribe();
      if (this.active === active) this.active = null;
    }
  }
  callTool(params) {
    const active = this.active;
    const run = this.toolTail.then(async () => {
      if (!active) return reply({ error: 'No active coordinator turn' }, false);
      await active.accepted.promise;
      if (this.closed || this.active !== active || active.terminal || active.controller.signal.aborted
        || params.threadId !== this.state.threadId || params.turnId !== active.request.turnId || params.namespace != null) {
        return reply({ error: 'Tool call does not belong to the active coordinator turn' }, false);
      }
      const descriptor = this.tools.find(t => t.name === params.tool);
      if (!descriptor || typeof params.callId !== 'string' || !params.callId) {
        return reply({ error: 'Unknown coordinator tool or call identity' }, false);
      }
      const fingerprint = hash(stable({ tool: params.tool, arguments: params.arguments }));
      const previous = active.request.calls.find(c => c.callId === params.callId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return reply({ error: 'Tool call identity was reused with different arguments' }, false);
        if (previous.status !== 'completed') return reply({ error: 'Tool outcome is uncertain; do not retry' }, false);
        return previous.result;
      }
      let args;
      try { args = this.host.validateTool(params.tool, params.arguments); }
      catch { return reply({ error: 'Invalid coordinator tool arguments; inspect the tool schema' }, false); }
      const record = { callId: params.callId, tool: params.tool, fingerprint, status: 'started', startedAt: now() };
      active.request.calls.push(record); this.save();
      try {
        const result = reply(await this.host.executeTool(params.tool, args, active.controller.signal));
        if (result.contentItems[0].text.length > 1024 * 1024) throw new Error('Tool result exceeds the supported size');
        record.status = 'completed'; record.result = result; record.finishedAt = now(); this.save();
        this.emit('tool', { requestId: active.request.requestId, callId: params.callId, tool: params.tool, success: true });
        return result;
      } catch {
        if (descriptor.readOnly === true) {
          const result = reply({ error: 'Read-only host query failed; check the resource and arguments before continuing' }, false);
          record.status = 'completed'; record.result = result; record.finishedAt = now(); this.save();
          this.emit('tool', { requestId: active.request.requestId, callId: params.callId, tool: params.tool, success: false });
          return result;
        }
        record.status = 'uncertain'; record.finishedAt = now(); this.save();
        active.controller.abort();
        active.ended.reject(new Error('Host tool failed after invocation; inspect domain state before continuing'));
        return reply({ error: 'Host tool outcome is uncertain; no automatic retry' }, false);
      }
    });
    this.toolTail = run.then(() => {}, () => {});
    return run;
  }
  async interrupt(active) {
    if (!active.terminal && active.started && active.request.turnId) {
      active.interrupt ??= this.rpc.request('turn/interrupt', { threadId: this.state.threadId, turnId: active.request.turnId });
      await active.interrupt;
    }
  }
  async recover() {
    if (this.closed) throw new Error('Coordinator is closed');
    if (this.active) return this.status();
    if (this.recovering) return this.recovering;
    this.recovering = this.reconcile().finally(() => { this.recovering = null; });
    return this.recovering;
  }
  async reconcile() {
    const pending = this.state.requests.filter(r => ['submitting', 'running', 'unknown'].includes(r.status));
    for (const request of pending) {
      if (!this.state.threadId || !request.turnId || request.calls.some(c => c.status !== 'completed')) {
        request.status = 'unknown'; request.error = 'Missing acknowledgement or uncertain tool outcome; no automatic replay'; continue;
      }
      const client = await this.client();
      let cursor, turn;
      do {
        const page = await client.request('thread/turns/list', { threadId: this.state.threadId, itemsView: 'full', sortDirection: 'desc', limit: 100, ...(cursor ? { cursor } : {}) });
        if (this.closed) return this.status();
        if (!Array.isArray(page?.data)) throw new Error('Required coordinator recovery protocol is unavailable');
        turn = page.data.find(t => t.id === request.turnId); cursor = page.nextCursor;
      } while (!turn && cursor);
      if (turn && terminal.has(turn.status)) {
        request.status = turn.status; request.recoveredAt = now();
        request.lastMessage = turn.items?.filter(i => i.type === 'agentMessage').at(-1)?.text ?? request.lastMessage;
        for (const id of request.noticeIds ?? []) {
          const notice = this.state.requests.find(r => r.requestId === id); notice.status = 'completed'; notice.consumedBy = request.requestId;
        }
      } else { request.status = 'unknown'; request.error = 'No terminal receipt; no automatic replay'; }
    }
    this.save();
    if (this.started) this.kick();
    return this.status();
  }
  async shutdown() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.host.lifetime?.removeEventListener('abort', this.abort);
    this.stopping = (async () => {
      const active = this.active;
      if (active) {
        active.cancel = true; active.controller.abort();
        await this.interrupt(active).catch(() => {});
        active.ended.reject(new Error('Coordinator stopped before a terminal receipt'));
      }
      if (this.rpc) await this.rpc.close();
      await this.idle();
      await Promise.allSettled([this.starting, this.recovering].filter(Boolean));
      await this.toolTail;
      this.rpc = null; this.store.close();
    })();
    return this.stopping;
  }
}
