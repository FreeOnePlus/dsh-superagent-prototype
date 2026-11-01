import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CodexRpc, RpcError } from '../src/rpc.mjs';

const fixture = fileURLToPath(new URL('./fixtures/rpc-tools.mjs', import.meta.url));

function createClient(t, mode, options = {}) {
  const client = new CodexRpc({
    command: [process.execPath, fixture, mode],
    timeoutMs: 2_000,
    ...options,
  });
  t.after(() => client.close());
  return client;
}

function waitForNotification(client, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('notification', onNotification);
      reject(new Error('Timed out waiting for fixture notification'));
    }, 2_000);
    function onNotification(message) {
      if (!predicate(message)) return;
      clearTimeout(timer);
      client.off('notification', onNotification);
      resolve(message);
    }
    client.on('notification', onNotification);
  });
}

function waitForDisconnect(client) {
  return new Promise(resolve => client.once('disconnected', resolve));
}

test('dynamic tool calls remain disabled unless the experimental API is explicitly enabled', async t => {
  let callCount = 0;
  const client = createClient(t, 'disabled', {
    onToolCall: async () => {
      callCount += 1;
      return { contentItems: [], success: true };
    },
  });
  const interactions = [];
  client.on('interactionRequired', event => interactions.push(event));
  const responsePromise = waitForNotification(client, message => message.method === 'fixture/toolResponse');

  const initialized = await client.initialize();
  const observed = await responsePromise;

  assert.deepEqual(initialized.received.capabilities, { experimentalApi: false });
  assert.equal(callCount, 0);
  assert.equal(observed.params.response.id, 701);
  assert.deepEqual(observed.params.response.error, {
    code: -32601,
    message: 'This executor has no interactive approval channel',
  });
  assert.deepEqual(interactions.map(event => event.method), ['item/tool/call']);
});

test('enabled dynamic tool calls preserve identifiers and run concurrently with notifications', async t => {
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const received = [];
  const client = createClient(t, 'success', {
    experimentalApi: true,
    onToolCall: async params => {
      received.push(params);
      if (params.callId === 'call-slow') await slowGate;
      return {
        contentItems: [{ type: 'inputText', text: `completed:${params.callId}` }],
        success: true,
      };
    },
  });
  const pingPromise = waitForNotification(client, message => message.method === 'fixture/ping');
  const fastPromise = waitForNotification(
    client,
    message => message.method === 'fixture/toolResponse' && message.params.requestId === 702,
  );
  const slowPromise = waitForNotification(
    client,
    message => message.method === 'fixture/toolResponse' && message.params.requestId === 701,
  );

  const initialized = await client.initialize();
  const [ping, fast] = await Promise.all([pingPromise, fastPromise]);
  assert.deepEqual(initialized.received.capabilities, { experimentalApi: true });
  assert.deepEqual(ping.params, { afterRequests: true });
  assert.deepEqual(fast.params.response.result, {
    contentItems: [{ type: 'inputText', text: 'completed:call-fast' }],
    success: true,
  });
  assert.deepEqual(received, [
    {
      threadId: 'thread-fixture', turnId: 'turn-fixture', callId: 'call-slow',
      namespace: 'fixture_tools', tool: 'wait_for_gate', arguments: { sequence: 1 },
    },
    {
      threadId: 'thread-fixture', turnId: 'turn-fixture', callId: 'call-fast',
      namespace: 'fixture_tools', tool: 'return_now', arguments: { sequence: 2 },
    },
  ]);

  releaseSlow();
  const slow = await slowPromise;
  assert.deepEqual(slow.params.response.result, {
    contentItems: [{ type: 'inputText', text: 'completed:call-slow' }],
    success: true,
  });
});

test('dynamic tool handler failures return bounded content without exception details', async t => {
  const secret = 'credential-value-that-must-not-cross-the-transport';
  const client = createClient(t, 'failure', {
    experimentalApi: true,
    onToolCall: async () => { throw new Error(secret); },
  });
  const responsePromise = waitForNotification(client, message => message.method === 'fixture/toolResponse');

  await client.initialize();
  const observed = await responsePromise;
  const serialized = JSON.stringify(observed.params.response);

  assert.deepEqual(observed.params.response.result, {
    contentItems: [{ type: 'inputText', text: 'Dynamic tool call failed.' }],
    success: false,
  });
  assert.equal(serialized.includes(secret), false);
  assert.ok(serialized.length < 256);
});

test('disconnect during a dynamic tool callback produces no late reply', async t => {
  let release;
  let markStarted;
  let markReturned;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const returned = new Promise(resolve => { markReturned = resolve; });
  const client = createClient(t, 'disconnect', {
    experimentalApi: true,
    onToolCall: async params => {
      markStarted(params);
      await gate;
      markReturned();
      return { contentItems: [{ type: 'inputText', text: 'too late' }], success: true };
    },
  });
  const disconnected = waitForDisconnect(client);

  await client.initialize();
  const params = await started;
  assert.equal(params.callId, 'call-disconnect');
  const error = await disconnected;
  assert.ok(error instanceof RpcError);
  assert.equal(error.code, 'CLOSED');

  let lateSendCount = 0;
  client.send = () => { lateSendCount += 1; };
  release();
  await returned;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateSendCount, 0);
});
