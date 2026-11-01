import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexCoordinator } from '../src/coordinator.mjs';
import { RpcError } from '../src/rpc.mjs';

const PASS = Symbol('use default fake response');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message = 'Condition was not reached') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function temporaryFixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-coordinator-test-'));
  const cwd = join(root, 'work');
  const hostState = join(root, 'host-state');
  mkdirSync(cwd);
  mkdirSync(hostState);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const lifetime = new AbortController();
  const validationCalls = [];
  const executionCalls = [];
  const health = [];
  const host = {
    id: 'coordinator-fixture',
    stateDir: hostState,
    lifetime: lifetime.signal,
    prompt: () => ({ text: 'Coordinate bounded synthetic work.', revision: 'prompt-r1' }),
    tools: () => [{
      name: 'record_event',
      description: 'Record one synthetic event.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    }],
    validateTool: (name, args) => {
      validationCalls.push({ name, args });
      if (name !== 'record_event' || typeof args?.value !== 'string') throw new Error('invalid arguments');
      return { value: args.value };
    },
    executeTool: async (name, args, signal) => {
      executionCalls.push({ name, args, signal });
      return { recorded: args.value };
    },
    health: status => health.push(status),
    ...overrides,
  };
  return { root, cwd, hostState, lifetime, host, validationCalls, executionCalls, health };
}

class FakeRpc extends EventEmitter {
  constructor({ threadId = 'thread-fixture', autoComplete = false, recoveryTurns = [], request } = {}) {
    super();
    this.threadId = threadId;
    this.autoComplete = autoComplete;
    this.recoveryTurns = recoveryTurns;
    this.requestOverride = request;
    this.requests = [];
    this.turns = [];
    this.initializeCalls = 0;
    this.closeCalls = 0;
    this.options = null;
  }

  async initialize() {
    this.initializeCalls += 1;
    return {};
  }

  request(method, params) {
    this.requests.push({ method, params });
    try {
      const override = this.requestOverride?.(method, params, this);
      if (override !== undefined && override !== PASS) return Promise.resolve(override);
      if (method === 'config/read') return Promise.resolve({ config: { mcp_servers: {}, apps: {} } });
      if (method === 'thread/start') return Promise.resolve({ thread: { id: this.threadId } });
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params.threadId } });
      if (method === 'mcpServerStatus/list') return Promise.resolve({ data: [] });
      if (method === 'thread/turns/list') return Promise.resolve({ data: this.recoveryTurns });
      if (method === 'turn/interrupt') return Promise.resolve({});
      if (method === 'turn/start') {
        const turn = { id: `turn-${this.turns.length + 1}`, status: 'inProgress', params, started: false, completed: false };
        this.turns.push(turn);
        setImmediate(() => {
          turn.started = true;
          this.emit('notification', {
            method: 'turn/started',
            params: { threadId: params.threadId, turn: { id: turn.id, status: 'inProgress' } },
          });
          if (this.autoComplete) queueMicrotask(() => this.complete(turn.id));
        });
        return Promise.resolve({ turn: { id: turn.id, status: 'inProgress' } });
      }
      return Promise.reject(new Error(`Unexpected RPC request: ${method}`));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  complete(turnId, status = 'completed') {
    const turn = this.turns.find(entry => entry.id === turnId);
    if (!turn || turn.completed) return;
    turn.completed = true;
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId: turn.params.threadId, turn: { id: turn.id, status } },
    });
  }

  async startedTurn(index = 0) {
    return eventually(() => this.turns[index]?.started && this.turns[index], `Turn ${index + 1} did not start`);
  }

  async close() {
    this.closeCalls += 1;
  }
}

function coordinator(t, fixture, client) {
  const instance = new CodexCoordinator({
    host: fixture.host,
    cwd: fixture.cwd,
    rpcFactory: options => {
      client.options = options;
      return client;
    },
    turnTimeoutMs: 2_000,
  });
  t.after(() => instance.shutdown().catch(() => {}));
  return instance;
}

function toolCall(turn, overrides = {}) {
  return {
    threadId: turn.params.threadId,
    turnId: turn.id,
    callId: 'call-1',
    namespace: null,
    tool: 'record_event',
    arguments: { value: 'synthetic-value' },
    ...overrides,
  };
}

test('delivery identity is durable, idempotent, and rejects changed content', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc({ autoComplete: true });
  const first = coordinator(t, fixture, client);
  await first.start();

  await first.deliver({ id: 'message-1', text: 'First coordinator input.' });
  await first.deliver({ id: 'message-1', text: 'First coordinator input.' });
  await assert.rejects(
    first.deliver({ id: 'message-1', text: 'Changed content under the same identity.' }),
    /reused with different content/i,
  );
  await first.idle();

  const state = first.store.read(fixture.host.id);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].requestId, 'message-1');
  assert.equal(state.requests[0].status, 'completed');
  assert.equal(first.holds('message-1'), true);
  assert.equal(client.turns.length, 1);
  await first.shutdown();

  const restartedClient = new FakeRpc({ autoComplete: true });
  const restarted = coordinator(t, fixture, restartedClient);
  await restarted.start();
  await restarted.deliver({ id: 'message-1', text: 'First coordinator input.' });
  await assert.rejects(
    restarted.deliver({ id: 'message-1', text: 'Changed after restart.' }),
    /reused with different content/i,
  );
  await restarted.idle();
  assert.equal(restartedClient.initializeCalls, 0);
  assert.equal(restartedClient.turns.length, 0);
});

test('concurrent wake deliveries execute as serial turns', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();

  await Promise.all([
    instance.deliver({ id: 'message-1', text: 'Run the first input.' }),
    instance.deliver({ id: 'message-2', text: 'Run the second input.' }),
  ]);
  const first = await client.startedTurn(0);
  assert.equal(client.turns.length, 1);

  client.complete(first.id);
  const second = await client.startedTurn(1);
  assert.equal(client.turns.length, 2);
  assert.match(JSON.stringify(first.params.input), /Run the first input/);
  assert.match(JSON.stringify(second.params.input), /Run the second input/);
  client.complete(second.id);
  await instance.idle();

  assert.deepEqual(instance.store.read(fixture.host.id).requests.map(request => request.status), [
    'completed',
    'completed',
  ]);
});

test('silent notices wait without waking and are consumed by the next wake delivery', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();

  await instance.deliver({ id: 'notice-1', text: 'Worker A finished.', wake: false });
  await instance.idle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.turns.length, 0);
  assert.equal(instance.store.read(fixture.host.id).requests[0].status, 'queued');

  await instance.deliver({ id: 'wake-1', text: 'A source message needs routing.' });
  const turn = await client.startedTurn(0);
  const input = JSON.stringify(turn.params.input);
  assert.match(input, /Worker A finished/);
  assert.match(input, /A source message needs routing/);
  client.complete(turn.id);
  await instance.idle();

  const [notice, wake] = instance.store.read(fixture.host.id).requests;
  assert.equal(notice.status, 'completed');
  assert.equal(notice.consumedBy, wake.requestId);
  assert.equal(wake.status, 'completed');
  assert.equal(client.turns.length, 1);
});

test('a completed coordinator thread is resumed after restart', async t => {
  const fixture = temporaryFixture(t);
  const firstClient = new FakeRpc({ autoComplete: true });
  const first = coordinator(t, fixture, firstClient);
  await first.start();
  await first.deliver({ id: 'message-1', text: 'Create the durable coordinator thread.' });
  await first.idle();
  const threadId = first.store.read(fixture.host.id).threadId;
  await first.shutdown();

  const secondClient = new FakeRpc({ threadId: 'must-not-replace-the-durable-thread', autoComplete: true });
  const second = coordinator(t, fixture, secondClient);
  await second.start();
  assert.equal(secondClient.initializeCalls, 0);
  await second.deliver({ id: 'message-2', text: 'Continue on the durable coordinator thread.' });
  await second.idle();

  const resumed = secondClient.requests.find(request => request.method === 'thread/resume');
  assert.equal(resumed.params.threadId, threadId);
  assert.equal(secondClient.requests.some(request => request.method === 'thread/start'), false);
  assert.equal(second.store.read(fixture.host.id).threadId, threadId);
});

test('an unacknowledged turn start remains unknown and is never replayed', async t => {
  const fixture = temporaryFixture(t);
  const firstClient = new FakeRpc({
    request: method => {
      if (method === 'turn/start') throw new RpcError('Connection closed before acknowledgement', 'CLOSED', true);
      return PASS;
    },
  });
  const first = coordinator(t, fixture, firstClient);
  await first.start();
  await first.deliver({ id: 'message-1', text: 'Do not replay this ambiguous submission.' });
  await first.idle();
  assert.equal(first.store.read(fixture.host.id).requests[0].status, 'unknown');
  await first.shutdown();

  let restartFactoryCalls = 0;
  const second = new CodexCoordinator({
    host: fixture.host,
    cwd: fixture.cwd,
    rpcFactory: () => {
      restartFactoryCalls += 1;
      return new FakeRpc({ autoComplete: true });
    },
    turnTimeoutMs: 2_000,
  });
  t.after(() => second.shutdown().catch(() => {}));
  await second.start();

  assert.equal(restartFactoryCalls, 0);
  assert.equal(second.store.read(fixture.host.id).requests[0].status, 'unknown');
  assert.equal(second.status().blocked, true);
});

test('tool calls are fenced to the active thread, turn, and registered name', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Invoke one registered coordinator tool.' });
  const turn = await client.startedTurn(0);
  assert.equal(client.options.experimentalApi, true);

  const rejected = await Promise.all([
    client.options.onToolCall(toolCall(turn, { callId: 'wrong-thread', threadId: 'other-thread' })),
    client.options.onToolCall(toolCall(turn, { callId: 'wrong-turn', turnId: 'other-turn' })),
    client.options.onToolCall(toolCall(turn, { callId: 'wrong-tool', tool: 'unregistered_tool' })),
  ]);
  assert.deepEqual(rejected.map(result => result.success), [false, false, false]);
  assert.equal(fixture.executionCalls.length, 0);

  const accepted = await client.options.onToolCall(toolCall(turn));
  assert.equal(accepted.success, true);
  assert.deepEqual(fixture.executionCalls.map(call => ({ name: call.name, args: call.args })), [
    { name: 'record_event', args: { value: 'synthetic-value' } },
  ]);
  client.complete(turn.id);
  await instance.idle();
});

test('an empty tool namespace is rejected while an omitted namespace is accepted', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Fence coordinator tool namespaces.' });
  const turn = await client.startedTurn(0);

  const emptyNamespace = await client.options.onToolCall(toolCall(turn, {
    callId: 'empty-namespace',
    namespace: '',
  }));
  assert.equal(emptyNamespace.success, false);
  assert.equal(fixture.validationCalls.length, 0);
  assert.equal(fixture.executionCalls.length, 0);

  const omittedNamespace = await client.options.onToolCall(toolCall(turn, {
    callId: 'omitted-namespace',
    namespace: undefined,
  }));
  assert.equal(omittedNamespace.success, true);
  assert.equal(fixture.executionCalls.length, 1);
  client.complete(turn.id);
  await instance.idle();
});

test('a repeated completed tool call returns its journaled result without another effect', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Exercise dynamic tool idempotency.' });
  const turn = await client.startedTurn(0);
  const params = toolCall(turn, { callId: 'durable-call' });

  const first = await client.options.onToolCall(params);
  const duplicate = await client.options.onToolCall(structuredClone(params));
  assert.deepEqual(duplicate, first);
  assert.equal(fixture.executionCalls.length, 1);
  const calls = instance.store.read(fixture.host.id).requests[0].calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callId, 'durable-call');
  assert.equal(calls[0].status, 'completed');

  client.complete(turn.id);
  await instance.idle();
});

test('a failed read-only tool call is durably completed, deduplicated, and does not stop later wakes', async t => {
  let effectCount = 0;
  let effectSignal;
  const fixture = temporaryFixture(t, {
    tools: () => [{
      name: 'record_event',
      description: 'Read one synthetic event.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      readOnly: true,
    }],
    executeTool: async (name, args, signal) => {
      effectCount += 1;
      effectSignal = signal;
      throw new Error(`No readable event for ${name}:${args.value}`);
    },
  });
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Run a read-only coordinator lookup.' });
  const firstTurn = await client.startedTurn(0);
  const params = toolCall(firstTurn, { callId: 'read-only-failure' });

  const first = await client.options.onToolCall(params);
  const duplicate = await client.options.onToolCall(structuredClone(params));
  assert.equal(first.success, false);
  assert.deepEqual(duplicate, first);
  assert.equal(effectCount, 1);
  assert.equal(effectSignal.aborted, false);
  let request = instance.store.read(fixture.host.id).requests[0];
  assert.equal(request.calls.length, 1);
  assert.equal(request.calls[0].status, 'completed');
  assert.deepEqual(request.calls[0].result, first);

  client.complete(firstTurn.id);
  await instance.idle();
  request = instance.store.read(fixture.host.id).requests[0];
  assert.equal(request.status, 'completed');

  await instance.deliver({ id: 'message-2', text: 'Continue with the next wake after the failed lookup.' });
  const secondTurn = await client.startedTurn(1);
  client.complete(secondTurn.id);
  await instance.idle();
  assert.deepEqual(instance.store.read(fixture.host.id).requests.map(entry => entry.status), [
    'completed',
    'completed',
  ]);
});

test('the internal read-only marker is omitted from app-server dynamic tool declarations', async t => {
  const fixture = temporaryFixture(t, {
    tools: () => [{
      name: 'record_event',
      description: 'Read one synthetic event.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      readOnly: true,
    }],
  });
  const client = new FakeRpc({ autoComplete: true });
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Inspect the public dynamic tool declaration.' });
  await instance.idle();

  const startedThread = client.requests.find(request => request.method === 'thread/start');
  assert.equal(startedThread.params.dynamicTools.length, 1);
  assert.equal(startedThread.params.config.features.view_image, false);
  assert.equal(Object.hasOwn(startedThread.params.dynamicTools[0], 'readOnly'), false);
  assert.deepEqual(startedThread.params.dynamicTools[0], {
    type: 'function',
    name: 'record_event',
    description: 'Read one synthetic event.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  });
});

test('invalid tool arguments fail validation before any external effect', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Reject malformed coordinator tool arguments.' });
  const turn = await client.startedTurn(0);

  const result = await client.options.onToolCall(toolCall(turn, {
    callId: 'invalid-call',
    arguments: { value: 42 },
  }));
  assert.equal(result.success, false);
  assert.equal(fixture.validationCalls.length, 1);
  assert.equal(fixture.executionCalls.length, 0);
  assert.deepEqual(instance.store.read(fixture.host.id).requests[0].calls, []);

  client.complete(turn.id);
  await instance.idle();
});

test('a started tool effect is journaled and an uncertain outcome is never replayed', async t => {
  const effect = deferred();
  const entered = deferred();
  let effectCount = 0;
  const fixture = temporaryFixture(t, {
    executeTool: async () => {
      effectCount += 1;
      entered.resolve();
      return effect.promise;
    },
  });
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Journal the effect before execution.' });
  const turn = await client.startedTurn(0);
  const params = toolCall(turn, { callId: 'uncertain-call' });

  const first = client.options.onToolCall(params);
  await entered.promise;
  let call = instance.store.read(fixture.host.id).requests[0].calls[0];
  assert.equal(call.status, 'started');
  const duplicate = client.options.onToolCall(structuredClone(params));
  effect.reject(new Error('The effect outcome is not known'));

  assert.equal((await first).success, false);
  assert.equal((await duplicate).success, false);
  await eventually(() => instance.store.read(fixture.host.id).requests[0].status === 'unknown');
  call = instance.store.read(fixture.host.id).requests[0].calls[0];
  assert.equal(call.status, 'uncertain');
  assert.equal(effectCount, 1);
});

test('an explicitly mutating tool failure remains uncertain', async t => {
  let effectCount = 0;
  const fixture = temporaryFixture(t, {
    tools: () => [{
      name: 'record_event',
      description: 'Mutate one synthetic event.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      readOnly: false,
    }],
    executeTool: async () => {
      effectCount += 1;
      throw new Error('The mutation outcome is not known');
    },
  });
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Preserve uncertainty for a failed mutation.' });
  const turn = await client.startedTurn(0);

  const result = await client.options.onToolCall(toolCall(turn, { callId: 'mutating-failure' }));
  assert.equal(result.success, false);
  await eventually(() => instance.store.read(fixture.host.id).requests[0].status === 'unknown');
  const request = instance.store.read(fixture.host.id).requests[0];
  assert.equal(request.calls[0].status, 'uncertain');
  assert.equal(effectCount, 1);
});

test('an undefined host tool result is uncertain and cannot form a completed receipt', async t => {
  let effectCount = 0;
  const fixture = temporaryFixture(t, {
    executeTool: async () => {
      effectCount += 1;
      return undefined;
    },
  });
  const client = new FakeRpc();
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Reject an unserializable tool receipt.' });
  const turn = await client.startedTurn(0);

  const result = await client.options.onToolCall(toolCall(turn, { callId: 'undefined-result' }));
  assert.equal(result.success, false);
  await eventually(() => instance.store.read(fixture.host.id).requests[0].status === 'unknown');
  const request = instance.store.read(fixture.host.id).requests[0];
  assert.equal(request.calls[0].status, 'uncertain');
  assert.equal(Object.hasOwn(request.calls[0], 'result'), false);
  assert.equal(effectCount, 1);
});

test('a starting MCP server blocks inference even when its tool map is empty', async t => {
  const fixture = temporaryFixture(t);
  const client = new FakeRpc({
    request: method => {
      if (method === 'mcpServerStatus/list') {
        return { data: [{ name: 'startup-server', runtimeStatus: 'starting', tools: {} }] };
      }
      return PASS;
    },
  });
  const instance = coordinator(t, fixture, client);
  await instance.start();
  await instance.deliver({ id: 'message-1', text: 'Do not infer with an enabled MCP boundary.' });
  await instance.idle();

  assert.equal(client.requests.some(request => request.method === 'turn/start'), false);
  assert.equal(instance.store.read(fixture.host.id).requests[0].status, 'failed');
  assert.equal(instance.status().last, 'failed');
});

test('bundled plugin discovery disables only its MCP server on a replacement process', async t => {
  const fixture = temporaryFixture(t);
  const baselineClient = new FakeRpc({ autoComplete: true });
  const baseline = coordinator(t, fixture, baselineClient);
  await baseline.start();
  await baseline.deliver({ id: 'message-1', text: 'Create a durable thread before plugin discovery.' });
  await baseline.idle();
  const durableThreadId = baseline.store.read(fixture.host.id).threadId;
  await baseline.shutdown();

  const discoveryClient = new FakeRpc({
    request: method => {
      if (method === 'mcpServerStatus/list') {
        return {
          data: [{
            name: 'bundled-server',
            pluginId: 'plugin.fixture',
            runtimeStatus: 'ready',
            tools: { bundled_action: { description: 'Synthetic bundled action.' } },
          }],
        };
      }
      return PASS;
    },
  });
  const replacementClient = new FakeRpc({ autoComplete: true });
  let factoryCalls = 0;
  const instance = new CodexCoordinator({
    host: fixture.host,
    cwd: fixture.cwd,
    rpcFactory: options => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        discoveryClient.options = options;
        return discoveryClient;
      }
      assert.equal(discoveryClient.closeCalls, 1);
      replacementClient.options = options;
      return replacementClient;
    },
    turnTimeoutMs: 2_000,
  });
  t.after(() => instance.shutdown().catch(() => {}));
  await instance.start();
  await instance.deliver({ id: 'message-2', text: 'Continue after restricting the bundled MCP server.' });
  await instance.idle();

  assert.equal(factoryCalls, 2);
  assert.equal(discoveryClient.requests.filter(request => request.method === 'thread/resume').length, 1);
  assert.equal(discoveryClient.requests.some(request => request.method === 'turn/start'), false);
  const replacementResume = replacementClient.requests.find(request => request.method === 'thread/resume');
  assert.equal(replacementResume.params.threadId, durableThreadId);
  assert.deepEqual(replacementResume.params.config.plugins, {
    'plugin.fixture': { mcp_servers: { 'bundled-server': { enabled: false } } },
  });
  assert.equal(Object.hasOwn(replacementResume.params.config.plugins['plugin.fixture'], 'enabled'), false);
  assert.equal(replacementClient.turns.length, 1);
  assert.equal(instance.store.read(fixture.host.id).requests.at(-1).status, 'completed');
});

test('shutdown preserves queued wakes and restart reconciles before continuing', async t => {
  const fixture = temporaryFixture(t);
  const firstClient = new FakeRpc();
  const first = coordinator(t, fixture, firstClient);
  await first.start();
  await first.deliver({ id: 'message-1', text: 'The active turn will be interrupted by shutdown.' });
  const activeTurn = await firstClient.startedTurn(0);
  await first.deliver({ id: 'message-2', text: 'This queued wake must survive shutdown.' });
  await first.shutdown();

  assert.equal(firstClient.turns.length, 1);
  assert.equal(firstClient.requests.filter(request => request.method === 'turn/interrupt').length, 1);

  const secondClient = new FakeRpc({
    autoComplete: true,
    recoveryTurns: [{ id: activeTurn.id, status: 'completed', items: [] }],
  });
  const second = coordinator(t, fixture, secondClient);
  const beforeRestart = second.store.read(fixture.host.id).requests;
  assert.deepEqual(beforeRestart.map(request => request.status), ['unknown', 'queued']);
  await second.start();
  await second.idle();

  assert.equal(secondClient.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.match(JSON.stringify(secondClient.turns[0].params.input), /queued wake must survive shutdown/);
  assert.deepEqual(second.store.read(fixture.host.id).requests.map(request => request.status), [
    'completed',
    'completed',
  ]);
});

test('shutdown waits for an in-flight recovery listing before closing durable state', async t => {
  const fixture = temporaryFixture(t);
  const firstClient = new FakeRpc();
  const first = coordinator(t, fixture, firstClient);
  await first.start();
  await first.deliver({ id: 'message-1', text: 'Leave one acknowledged turn for recovery.' });
  const turn = await firstClient.startedTurn(0);
  await first.shutdown();

  const listing = deferred();
  const listingStarted = deferred();
  const secondClient = new FakeRpc({
    request: method => {
      if (method === 'thread/turns/list') {
        listingStarted.resolve();
        return listing.promise;
      }
      return PASS;
    },
  });
  const second = coordinator(t, fixture, secondClient);
  const faults = [];
  second.on('fault', error => faults.push(error));
  const starting = second.start();
  await listingStarted.promise;

  let shutdownSettled = false;
  const stopping = second.shutdown().then(() => { shutdownSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownSettled, false);

  listing.resolve({ data: [{ id: turn.id, status: 'completed', items: [] }] });
  await Promise.all([starting, stopping]);
  assert.equal(shutdownSettled, true);
  assert.deepEqual(faults, []);
  assert.equal(secondClient.closeCalls, 1);
});
