import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexExecutor } from '../src/executor.mjs';

const validReport = { state: 'ready', summary: 'The assigned work is complete.' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function temporaryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-executor-test-'));
  const cwd = join(root, 'work');
  const stateDir = join(root, 'state');
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cwd, stateDir };
}

class FakeRpc extends EventEmitter {
  constructor(handler = () => { throw new Error('Unexpected RPC request'); }, initialize = async () => ({})) {
    super();
    this.handler = handler;
    this.initializeHandler = initialize;
    this.requests = [];
    this.initializeCalls = 0;
    this.closeCalls = 0;
  }

  async initialize() {
    this.initializeCalls += 1;
    return this.initializeHandler();
  }

  request(method, params) {
    this.requests.push({ method, params });
    try {
      return Promise.resolve(this.handler(method, params, this));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async close() {
    this.closeCalls += 1;
  }
}

function finishTurn(client, turnId, status, { report, error } = {}) {
  if (report !== undefined) {
    client.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId,
        item: { type: 'agentMessage', phase: 'final_answer', text: typeof report === 'string' ? report : JSON.stringify(report) },
      },
    });
  }
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: turnId, status, ...(error ? { error } : {}) } },
  });
}

function standardClient() {
  let turnNumber = 0;
  let client;
  client = new FakeRpc((method, params) => {
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      const turn = { id: `turn-${++turnNumber}`, status: 'inProgress' };
      queueMicrotask(() => client.emit('notification', {
        method: 'turn/started', params: { threadId: 'thread-1', turn },
      }));
      return { turn };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected RPC request: ${method}`);
  });
  return client;
}

function request(cwd, overrides = {}) {
  return { taskId: 'task-1', requestId: 'request-1', cwd, prompt: 'Perform the bounded assignment.', ...overrides };
}

test('deduplicates an active request and returns the durable receipt after restart', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const client = standardClient();
  const accepted = deferred();
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });

  const first = executor.run({ ...request(cwd), onAccepted: accepted.resolve });
  const duplicate = executor.run(request(cwd));
  assert.strictEqual(duplicate, first);
  await assert.rejects(
    executor.run(request(cwd, { prompt: 'Different content while the original request ID is active.' })),
    /active request/,
  );
  const started = await accepted.promise;
  finishTurn(client, started.turnId, 'completed', { report: validReport });
  const receipt = await first;
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.report, validReport);
  assert.equal(client.requests.filter(entry => entry.method === 'turn/start').length, 1);
  await executor.shutdown();

  let factoryCalls = 0;
  const restarted = new CodexExecutor({
    stateDir,
    rpcFactory: () => {
      factoryCalls += 1;
      throw new Error('A durable duplicate must not start an RPC client');
    },
  });
  const replayedReceipt = await restarted.run(request(cwd));
  assert.equal(factoryCalls, 0);
  assert.deepEqual(replayedReceipt, receipt);
  await restarted.shutdown();
});

test('rejects reuse of a durable request ID with different content', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const client = standardClient();
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
  const receipt = await executor.run({
    ...request(cwd),
    onAccepted: ({ turnId }) => finishTurn(client, turnId, 'completed', { report: validReport }),
  });
  assert.equal(receipt.status, 'completed');

  await assert.rejects(
    executor.run(request(cwd, { prompt: 'A different assignment using the same request ID.' })),
    /Request ID was reused with different content/,
  );
  assert.equal(client.requests.filter(entry => entry.method === 'turn/start').length, 1);
  await executor.shutdown();
});

test('does not overlap turns for one task', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const client = standardClient();
  const accepted = deferred();
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
  const first = executor.run({ ...request(cwd), onAccepted: accepted.resolve });
  const started = await accepted.promise;

  await assert.rejects(
    executor.run(request(cwd, { requestId: 'request-2', prompt: 'Follow-up submitted too early.' })),
    /Task already has an active request/,
  );
  assert.equal(client.requests.filter(entry => entry.method === 'turn/start').length, 1);
  finishTurn(client, started.turnId, 'completed', { report: validReport });
  await first;
  await executor.shutdown();
});

test('runs a later follow-up on the original thread', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const client = standardClient();
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });

  const first = await executor.run({
    ...request(cwd),
    onAccepted: ({ turnId }) => finishTurn(client, turnId, 'completed', { report: validReport }),
  });
  const second = await executor.run({
    ...request(cwd, { requestId: 'request-2', prompt: 'Apply the requested follow-up.' }),
    onAccepted: ({ turnId }) => finishTurn(client, turnId, 'completed', {
      report: { state: 'ready', summary: 'The follow-up is complete.' },
    }),
  });

  assert.equal(first.threadId, 'thread-1');
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.turnId, 'turn-2');
  const resume = client.requests.find(entry => entry.method === 'thread/resume');
  assert.equal(resume.params.threadId, first.threadId);
  assert.equal(client.requests.filter(entry => entry.method === 'thread/start').length, 1);
  assert.equal(client.requests.filter(entry => entry.method === 'turn/start').length, 2);
  await executor.shutdown();
});

test('cancels before starting a thread when initialization is still pending', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const initialize = deferred();
  const initializing = deferred();
  const client = new FakeRpc(
    method => { throw new Error(`Unexpected RPC request after early cancellation: ${method}`); },
    async () => {
      initializing.resolve();
      return initialize.promise;
    },
  );
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
  const running = executor.run(request(cwd));
  await initializing.promise;
  const cancellation = await executor.stop('task-1');
  assert.deepEqual(cancellation, { requested: true, confirmed: false });
  initialize.resolve({});

  const receipt = await running;
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.turnId, null);
  assert.equal(client.requests.length, 0);
  await executor.shutdown();
});

test('cancels a turn whose start acknowledgement races with stop', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const startAcknowledgement = deferred();
  const startRequested = deferred();
  const accepted = deferred();
  const client = new FakeRpc((method, params, instance) => {
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      startRequested.resolve();
      return startAcknowledgement.promise;
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => finishTurn(instance, params.turnId, 'interrupted'));
      return {};
    }
    throw new Error(`Unexpected RPC request: ${method}`);
  });
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
  const running = executor.run({ ...request(cwd), onAccepted: accepted.resolve });
  await startRequested.promise;
  const cancellation = await executor.stop('task-1');
  assert.deepEqual(cancellation, { requested: true, confirmed: false });
  assert.equal(client.requests.some(entry => entry.method === 'turn/interrupt'), false);

  startAcknowledgement.resolve({ turn: { id: 'turn-raced' } });
  client.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-raced', status: 'inProgress' } },
  });
  const receipt = await running;
  assert.equal(receipt.status, 'interrupted');
  assert.equal((await accepted.promise).turnId, 'turn-raced');
  assert.deepEqual(
    client.requests.filter(entry => entry.method === 'turn/interrupt').map(entry => entry.params.turnId),
    ['turn-raced'],
  );
  await executor.shutdown();
});

test('retains stop intent after acknowledgement until turn/started and interrupts once', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const accepted = deferred();
  const client = new FakeRpc((method, params, instance) => {
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-delayed-start', status: 'inProgress' } };
    if (method === 'turn/interrupt') {
      queueMicrotask(() => finishTurn(instance, params.turnId, 'interrupted'));
      return {};
    }
    throw new Error(`Unexpected RPC request: ${method}`);
  });
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
  const running = executor.run({ ...request(cwd), onAccepted: accepted.resolve });
  const acknowledgement = await accepted.promise;
  assert.equal(acknowledgement.turnId, 'turn-delayed-start');

  const cancellations = await Promise.all([executor.stop('task-1'), executor.stop('task-1')]);
  assert.ok(cancellations.every(result => result.requested && !result.confirmed));
  assert.equal(client.requests.filter(entry => entry.method === 'turn/interrupt').length, 0);

  client.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-delayed-start', status: 'inProgress' },
    },
  });
  const receipt = await running;
  assert.equal(receipt.status, 'interrupted');
  assert.notEqual(receipt.status, 'unknown');
  assert.equal(client.requests.filter(entry => entry.method === 'turn/interrupt').length, 1);
  await executor.shutdown();
});

test('preserves completed, failed, and interrupted terminal distinctions', async t => {
  const cases = [
    { status: 'completed', options: { report: validReport }, expected: { report: validReport } },
    { status: 'failed', options: { error: { message: 'The turn failed.' } }, expected: { error: 'The turn failed.' } },
    { status: 'interrupted', options: {}, expected: {} },
  ];

  for (const [index, entry] of cases.entries()) {
    const { cwd, stateDir } = temporaryFixture(t);
    const client = standardClient();
    const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
    const receipt = await executor.run({
      ...request(cwd, { taskId: `task-${index}`, requestId: `request-${index}` }),
      onAccepted: ({ turnId }) => finishTurn(client, turnId, entry.status, entry.options),
    });
    assert.equal(receipt.status, entry.status);
    assert.deepEqual(receipt.report, entry.expected.report);
    assert.equal(receipt.error, entry.expected.error);
    await executor.shutdown();
  }
});

test('does not mark malformed structured reports completed', async t => {
  const malformedReports = [
    'not JSON',
    { state: 'ready' },
    { state: 'unknown', summary: 'Not a permitted state.' },
    { state: 'ready', summary: 'Contains an undeclared field.', extra: true },
  ];

  for (const [index, report] of malformedReports.entries()) {
    const { cwd, stateDir } = temporaryFixture(t);
    const client = standardClient();
    const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
    const receipt = await executor.run({
      ...request(cwd, { taskId: `invalid-${index}`, requestId: `invalid-${index}` }),
      onAccepted: ({ turnId }) => finishTurn(client, turnId, 'completed', { report }),
    });
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.error, /valid structured work report/);
    await executor.shutdown();
  }
});

test('never replays a turn when its start acknowledgement was lost', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const start = deferred();
  const startRequested = deferred();
  const firstClient = new FakeRpc(method => {
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      startRequested.resolve();
      return start.promise;
    }
    throw new Error(`Unexpected RPC request: ${method}`);
  });
  const firstExecutor = new CodexExecutor({ stateDir, rpcFactory: () => firstClient });
  const running = firstExecutor.run(request(cwd));
  await startRequested.promise;
  const crash = new Error('The Codex process disconnected before acknowledging the turn.');
  firstClient.emit('disconnected', crash);
  start.reject(crash);
  const receipt = await running;
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.turnId, null);
  await firstExecutor.shutdown();

  const recoveryClient = new FakeRpc(method => {
    throw new Error(`Recovery must not issue RPC without a known turn ID: ${method}`);
  });
  const restarted = new CodexExecutor({ stateDir, rpcFactory: () => recoveryClient });
  const state = await restarted.recover('task-1');
  assert.equal(state.requests[0].status, 'unknown');
  assert.equal(state.requests[0].turnId, null);
  assert.equal(recoveryClient.requests.length, 0);
  await assert.rejects(
    restarted.run(request(cwd, { requestId: 'request-2', prompt: 'Do not start while recovery is unresolved.' })),
    /unresolved execution/,
  );
  await restarted.shutdown();
});

test('recovers a known terminal turn without executing another turn', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const firstClient = standardClient();
  const firstExecutor = new CodexExecutor({ stateDir, rpcFactory: () => firstClient });
  const receipt = await firstExecutor.run({
    ...request(cwd),
    onAccepted: () => firstClient.emit('disconnected', new Error('Connection lost after acknowledgement.')),
  });
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.turnId, 'turn-1');
  await firstExecutor.shutdown();

  const recoveryClient = new FakeRpc(method => {
    if (method === 'thread/turns/list') {
      return {
        data: [{
          id: 'turn-1',
          status: 'completed',
          items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(validReport) }],
        }],
      };
    }
    throw new Error(`Unexpected recovery RPC request: ${method}`);
  });
  const restarted = new CodexExecutor({ stateDir, rpcFactory: () => recoveryClient });
  const state = await restarted.recover('task-1');
  assert.equal(state.requests[0].status, 'completed');
  assert.deepEqual(state.requests[0].report, validReport);
  assert.ok(state.requests[0].recoveredAt);
  assert.deepEqual(recoveryClient.requests.map(entry => entry.method), ['thread/turns/list']);
  await restarted.shutdown();
});

test('a disconnected active process cannot produce a successful receipt', async t => {
  const { cwd, stateDir } = temporaryFixture(t);
  const client = standardClient();
  const executor = new CodexExecutor({ stateDir, rpcFactory: () => client });
  const receipt = await executor.run({
    ...request(cwd),
    onAccepted: ({ turnId }) => {
      client.emit('disconnected', new Error('Transport closed during the turn.'));
      finishTurn(client, turnId, 'completed', { report: validReport });
    },
  });

  assert.equal(receipt.status, 'unknown');
  assert.notEqual(receipt.status, 'completed');
  assert.match(receipt.error, /Transport closed/);
  await executor.shutdown();
});
