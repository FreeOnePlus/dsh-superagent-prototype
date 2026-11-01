import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexRpc, RpcError } from '../src/rpc.mjs';
import { StateStore } from '../src/store.mjs';

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeRpcFixture(directory) {
  const script = join(directory, 'synthetic-app-server.mjs');
  writeFileSync(script, `
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');

input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize' && message.id !== undefined) {
    send({ id: message.id, result: { received: message.params } });
    return;
  }
  if (message.method === 'initialized') {
    send({ id: 101, method: 'item/commandExecution/requestApproval', params: { command: 'fixture-command' } });
    return;
  }
  if (message.id === 101) {
    send({ method: 'fixture/approvalObserved', params: { request: 'command', response: message } });
    send({ id: 102, method: 'item/fileChange/requestApproval', params: { path: 'fixture-path' } });
    return;
  }
  if (message.id === 102) {
    send({ method: 'fixture/approvalObserved', params: { request: 'file', response: message } });
    return;
  }
  if (message.method === 'echo') {
    send({ id: message.id, result: message.params });
    return;
  }
  if (message.method === 'disconnect') process.exit(7);
});
`, { mode: 0o600 });
  return script;
}

test('stdio RPC handshakes, correlates responses, and declines server approvals', async t => {
  const directory = temporaryDirectory(t, 'codex-rpc-test-');
  const script = writeRpcFixture(directory);
  const client = new CodexRpc({ command: [process.execPath, script], cwd: directory, timeoutMs: 2_000 });
  t.after(() => client.close());

  const interactions = [];
  const approvals = [];
  const observed = new Promise(resolve => {
    client.on('interactionRequired', event => interactions.push(event));
    client.on('notification', event => {
      if (event.method !== 'fixture/approvalObserved') return;
      approvals.push(event.params);
      if (approvals.length === 2) resolve();
    });
  });

  const initialized = await client.initialize();
  assert.equal(initialized.received.clientInfo.name, 'originone_executor_bridge');
  assert.deepEqual(initialized.received.capabilities, { experimentalApi: false });
  assert.deepEqual(await client.request('echo', { value: 42 }), { value: 42 });
  await observed;

  assert.deepEqual(interactions.map(event => event.method), [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
  ]);
  assert.deepEqual(approvals.map(entry => entry.response.result), [
    { decision: 'decline' },
    { decision: 'decline' },
  ]);
  assert.deepEqual(approvals.map(entry => entry.request), ['command', 'file']);
  await client.close();
});

test('stdio RPC rejects an in-flight request when the child disconnects', async t => {
  const directory = temporaryDirectory(t, 'codex-rpc-disconnect-test-');
  const script = writeRpcFixture(directory);
  const client = new CodexRpc({ command: [process.execPath, script], cwd: directory, timeoutMs: 2_000 });
  t.after(() => client.close());
  await client.initialize();

  await assert.rejects(
    client.request('disconnect'),
    error => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.code, 'CLOSED');
      assert.equal(error.ambiguous, true);
      return true;
    },
  );
  assert.ok(client.failure instanceof RpcError);
});

test('state files are private and the state directory has one exclusive writer', t => {
  const root = temporaryDirectory(t, 'codex-store-test-');
  const stateDirectory = join(root, 'state');
  const store = new StateStore(stateDirectory);
  t.after(() => store.close());

  assert.equal(statSync(stateDirectory).mode & 0o777, 0o700);
  store.write({ schema: 1, taskId: 'task-1', cwd: root, binding: 'fixture', threadId: null, requests: [] });
  assert.equal(statSync(store.file('task-1')).mode & 0o777, 0o600);
  assert.deepEqual(store.read('task-1').requests, []);

  assert.throws(
    () => new StateStore(stateDirectory),
    error => {
      assert.equal(error.code, 'ELOCKED');
      return true;
    },
  );

  store.close();
  const successor = new StateStore(stateDirectory);
  assert.equal(successor.read('task-1').taskId, 'task-1');
  successor.close();
});
