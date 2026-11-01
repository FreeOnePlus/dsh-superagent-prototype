import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createExecutor } from '../src/connector.mjs';
import { hash } from '../src/store.mjs';

const fixtureServer = fileURLToPath(new URL('./fixtures/app-server.mjs', import.meta.url));

class Later extends Error {}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(5);
  }
}

function createPaths(t, plan) {
  const root = mkdtempSync(join(tmpdir(), 'codex-connector-test-'));
  const stateDir = join(root, 'state');
  const workDir = join(root, 'work');
  const controlDir = join(root, 'control');
  const planFile = join(root, 'plan.json');
  const logFile = join(root, 'rpc.jsonl');
  mkdirSync(stateDir);
  mkdirSync(workDir);
  mkdirSync(controlDir);
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(join(stateDir, 'codex-executor.json'), JSON.stringify({
    command: [process.execPath, fixtureServer, planFile, controlDir, logFile],
    timeoutMs: 2_000,
    turnTimeoutMs: 2_000,
  }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, stateDir, workDir, controlDir, planFile, logFile };
}

function createTicket(paths, {
  id = 'ticket-1', assignmentId = 'assignment-1', assignmentState = 'queued', inputs = [], undelivered = [],
} = {}) {
  return {
    id,
    title: `Ticket ${id}`,
    mandate: 'Perform the synthetic connector assignment.',
    ended: false,
    origin: { triggerIds: [] },
    execution: { directory: paths.workDir, assignment: 'Exercise the connector contract.' },
    assignments: [{ id: assignmentId, state: assignmentState }],
    inputs: structuredClone(inputs),
    undelivered: [...undelivered],
  };
}

class SyntheticEffects {
  constructor() {
    this.handlers = new Map();
    this.queued = [];
  }

  handle(name, handler, options) {
    this.handlers.set(name, { handler, options });
  }

  enqueue(name, key, payload) {
    this.queued.push({ name, key, payload });
  }

  invoke(name, payload) {
    const registration = this.handlers.get(name);
    if (!registration) throw new Error(`No synthetic effect handler for ${name}`);
    return registration.handler(payload);
  }

  take(name) {
    const index = this.queued.findIndex(entry => entry.name === name);
    if (index === -1) throw new Error(`No queued ${name} effect`);
    return this.queued.splice(index, 1)[0];
  }
}

function createAdapter(t, paths, tickets, {
  maxWorkers = 2,
  prepareWorkspace = async () => {},
} = {}) {
  const effects = new SyntheticEffects();
  const ticketMap = new Map(tickets.map(ticket => [ticket.id, ticket]));
  ticketMap.open = () => [...ticketMap.values()].filter(ticket => !ticket.ended);
  const calls = {
    assignmentStarted: [], inputsDelivered: [], inputsRead: [], reports: [], turnEnded: [],
    deliveryFailed: [], relayed: [], health: [], prepareWorkspace: [],
  };
  let lastReportTime = 0;
  const latest = ticket => ticket.assignments.at(-1);
  const host = {
    machine: { stateDir: paths.stateDir },
    effects,
    closing: () => false,
    paused: () => false,
    environment: () => [],
    health: { set: value => calls.health.push(value) },
    store: {
      tickets: ticketMap,
      triggers: new Map(),
      settings: () => ({ executor: { maxWorkers } }),
      atomic: operation => operation(),
    },
    engine: {
      assignmentStarted(ticketId, assignmentId) {
        calls.assignmentStarted.push({ ticketId, assignmentId });
        const ticket = ticketMap.get(ticketId);
        const assignment = latest(ticket);
        if (assignment?.id === assignmentId) assignment.state = 'running';
      },
      inputsDelivered(ticketId, assignmentId, inputIds) {
        calls.inputsDelivered.push({ ticketId, assignmentId, inputIds: [...inputIds] });
      },
      inputsRead(ticketId, inputIds) {
        calls.inputsRead.push({ ticketId, inputIds: [...inputIds] });
        const ticket = ticketMap.get(ticketId);
        ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id));
      },
      report(ticketId, value) {
        const ticket = ticketMap.get(ticketId);
        const assignment = latest(ticket);
        lastReportTime = Math.max(Date.now(), lastReportTime + 1);
        assignment.report = { ...structuredClone(value), at: new Date(lastReportTime).toISOString() };
        calls.reports.push({ ticketId, assignmentId: assignment.id, value: structuredClone(assignment.report) });
        if (value.state === 'ready') {
          ticket.ended = true;
          assignment.state = 'ended';
        }
        return ticket;
      },
      turnEnded(ticketId, assignmentId) {
        calls.turnEnded.push({ ticketId, assignmentId });
      },
      deliveryFailed(ticketId, assignmentId, message) {
        calls.deliveryFailed.push({ ticketId, assignmentId, message });
      },
    },
  };
  const helpers = {
    prepareTicket: (ticket, assessment) => ({ ticket, assessment }),
    async prepareWorkspace(ticket) {
      calls.prepareWorkspace.push(ticket.id);
      return prepareWorkspace(ticket);
    },
    defer: message => { throw new Later(message); },
    relayReport: (ticket, state, summary) => calls.relayed.push({ ticketId: ticket.id, state, summary }),
    waitsForPerson(ticket) {
      const report = latest(ticket)?.report;
      if (!['blocked', 'failed'].includes(report?.state)) return false;
      const reportTime = Date.parse(report.at ?? 0);
      return !ticket.inputs.some(input => input.kind === 'trigger'
        && Date.parse(input.at ?? input.createdAt ?? 0) > reportTime);
    },
  };
  const connector = createExecutor(host, helpers);
  t.after(() => connector.shutdown());
  return { connector, host, effects, calls, tickets: ticketMap };
}

function release(paths, name) {
  writeFileSync(join(paths.controlDir, name), 'release');
}

function marker(paths, name) {
  return existsSync(join(paths.controlDir, name));
}

function logEntries(paths) {
  if (!existsSync(paths.logFile)) return [];
  return readFileSync(paths.logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function turnRequests(paths, kind) {
  return logEntries(paths).filter(entry => entry.event === 'turn-requested' && (!kind || entry.kind === kind));
}

function seedUnacknowledgedRequest(paths, ticket, { status, threadId }) {
  const directory = join(paths.stateDir, 'codex-executor-state');
  mkdirSync(directory, { recursive: true });
  const state = {
    schema: 1,
    taskId: ticket.id,
    cwd: ticket.execution.directory,
    binding: 'synthetic-binding-not-used-during-recovery',
    threadId,
    requests: [{
      requestId: `assignment:${ticket.assignments[0].id}`,
      fingerprint: 'synthetic-fingerprint',
      metadata: { assignmentId: ticket.assignments[0].id, inputIds: [] },
      status,
      createdAt: '2026-10-31T00:00:00.000Z',
      turnId: null,
    }],
  };
  const file = join(directory, `${hash(ticket.id)}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return file;
}

test('late turn callbacks cannot report into a replaced or ended assignment', async t => {
  for (const invalidation of ['replaced', 'ended']) {
    const paths = createPaths(t, {
      launch: { completion: 'hold', report: { state: 'ready', summary: 'Late completion.' } },
    });
    const ticket = createTicket(paths);
    const adapter = createAdapter(t, paths, [ticket]);
    const running = adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: 'assignment-1' });
    await waitUntil(() => adapter.calls.assignmentStarted.length === 1, `${invalidation} launch acceptance`);

    if (invalidation === 'replaced') {
      ticket.assignments.push({ id: 'assignment-2', state: 'queued' });
    } else {
      ticket.ended = true;
      ticket.assignments[0].state = 'ended';
    }
    release(paths, 'complete-launch-1');
    await running;

    assert.equal(adapter.calls.reports.length, 0);
    assert.equal(adapter.calls.turnEnded.length, 0);
    assert.equal(ticket.assignments.at(-1).report, undefined);
    await adapter.connector.shutdown();
  }
});

test('a ready receipt cannot close a ticket while newer inputs remain queued', async t => {
  const paths = createPaths(t, {
    launch: { completion: 'hold', report: { state: 'ready', summary: 'Initial work completed.' } },
  });
  const ticket = createTicket(paths);
  const adapter = createAdapter(t, paths, [ticket]);
  const running = adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: 'assignment-1' });
  await waitUntil(() => adapter.calls.assignmentStarted.length === 1, 'launch acceptance');

  ticket.inputs.push({ id: 'late-input', kind: 'context', text: 'A late input.' });
  ticket.undelivered.push('late-input');
  release(paths, 'complete-launch-1');
  await running;

  assert.equal(adapter.calls.reports.length, 1);
  assert.equal(adapter.calls.reports[0].value.state, 'waiting');
  assert.match(adapter.calls.reports[0].value.summary, /Additional inputs are queued/);
  assert.equal(ticket.ended, false);
  assert.ok(adapter.effects.queued.some(entry => entry.name === 'delivery' && entry.payload.ticketId === ticket.id));
});

test('follow-up inputs are acknowledged only after the turn start receipt', async t => {
  const paths = createPaths(t, {
    delivery: {
      ack: 'hold', completion: 'hold',
      report: { state: 'waiting', summary: 'Follow-up processed.' },
    },
  });
  const input = { id: 'input-1', kind: 'context', text: 'Review this follow-up.' };
  const ticket = createTicket(paths, { assignmentState: 'running', inputs: [input], undelivered: [input.id] });
  ticket.assignments[0].report = { state: 'waiting', summary: 'Awaiting input.' };
  const adapter = createAdapter(t, paths, [ticket]);
  const running = adapter.effects.invoke('delivery', { ticketId: ticket.id });
  await waitUntil(() => marker(paths, 'requested-delivery-1'), 'delivery turn request');

  assert.equal(adapter.calls.inputsDelivered.length, 0);
  assert.equal(adapter.calls.inputsRead.length, 0);
  assert.deepEqual(ticket.undelivered, ['input-1']);

  release(paths, 'ack-delivery-1');
  await waitUntil(() => adapter.calls.inputsRead.length === 1, 'durable delivery acknowledgement');
  assert.deepEqual(adapter.calls.inputsDelivered[0].inputIds, ['input-1']);
  assert.deepEqual(adapter.calls.inputsRead[0].inputIds, ['input-1']);
  assert.deepEqual(ticket.undelivered, []);
  release(paths, 'complete-delivery-1');
  await running;
});

test('duplicate and resumed launches recover the stored receipt without a new turn', async t => {
  const paths = createPaths(t, {
    launch: { report: { state: 'waiting', summary: 'Waiting after the first turn.' } },
  });
  const ticket = createTicket(paths);
  const first = createAdapter(t, paths, [ticket]);
  const payload = { ticketId: ticket.id, assignmentId: 'assignment-1' };
  await first.effects.invoke('launch', payload);
  assert.equal(turnRequests(paths, 'launch').length, 1);

  await first.effects.invoke('launch', payload);
  assert.equal(turnRequests(paths, 'launch').length, 1);
  await first.connector.shutdown();

  const resumed = createAdapter(t, paths, [ticket]);
  resumed.connector.resume();
  const queued = resumed.effects.take('launch');
  await resumed.effects.invoke('launch', queued.payload);
  assert.equal(turnRequests(paths, 'launch').length, 1);
  assert.equal(ticket.assignments[0].report.state, 'waiting');
});

test('a genuinely new turn records fresh chronology even when state and summary are unchanged', async t => {
  const repeatedReport = { state: 'waiting', summary: 'The assignment is waiting.' };
  const paths = createPaths(t, { launch: { report: repeatedReport }, delivery: { report: repeatedReport } });
  const ticket = createTicket(paths);
  const adapter = createAdapter(t, paths, [ticket]);
  await adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: 'assignment-1' });
  const firstReportAt = adapter.calls.reports[0].value.at;

  const input = { id: 'follow-up-1', kind: 'context', text: 'A genuine follow-up turn.' };
  ticket.inputs.push(input);
  ticket.undelivered.push(input.id);
  await adapter.effects.invoke('delivery', { ticketId: ticket.id });

  assert.equal(adapter.calls.reports.length, 2);
  assert.equal(adapter.calls.reports[1].value.state, repeatedReport.state);
  assert.equal(adapter.calls.reports[1].value.summary, repeatedReport.summary);
  assert.ok(Date.parse(adapter.calls.reports[1].value.at) > Date.parse(firstReportAt));
  assert.equal(adapter.calls.relayed.length, 1);
  assert.equal(turnRequests(paths).length, 2);
});

test('resume does not overwrite a newer human-wait report with an older saved receipt', async t => {
  for (const state of ['blocked', 'failed']) {
    const paths = createPaths(t, {
      launch: { report: { state: 'waiting', summary: 'Older saved Codex receipt.' } },
    });
    const ticket = createTicket(paths, { id: `ticket-${state}`, assignmentId: `assignment-${state}` });
    const first = createAdapter(t, paths, [ticket]);
    await first.effects.invoke('launch', { ticketId: ticket.id, assignmentId: ticket.assignments[0].id });
    first.host.engine.report(ticket.id, { state, summary: `Newer ${state} host report.` });
    const newerReport = structuredClone(ticket.assignments[0].report);
    await first.connector.shutdown();

    const resumed = createAdapter(t, paths, [ticket]);
    resumed.connector.resume();
    const queued = resumed.effects.take('launch');
    await resumed.effects.invoke('launch', queued.payload);

    assert.deepEqual(ticket.assignments[0].report, newerReport);
    assert.equal(resumed.calls.reports.length, 0);
    assert.equal(turnRequests(paths).length, 1);
    await resumed.connector.shutdown();
  }
});

test('unacknowledged recovered requests persist unknown and report blocked without replay', async t => {
  const cases = [
    { status: 'prepared', threadId: null },
    { status: 'submitting', threadId: 'fixture-thread' },
  ];
  for (const entry of cases) {
    const paths = createPaths(t, { launch: { report: { state: 'ready', summary: 'Must not run.' } } });
    const ticket = createTicket(paths, {
      id: `ticket-${entry.status}`, assignmentId: `assignment-${entry.status}`,
    });
    const stateFile = seedUnacknowledgedRequest(paths, ticket, entry);
    const adapter = createAdapter(t, paths, [ticket]);
    await adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: ticket.assignments[0].id });

    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(saved.requests[0].status, 'unknown');
    assert.match(saved.requests[0].error, /no automatic replay/i);
    assert.equal(adapter.calls.reports.length, 1);
    assert.equal(adapter.calls.reports[0].value.state, 'blocked');
    assert.match(adapter.calls.reports[0].value.summary, /outcome is unknown/i);
    assert.match(adapter.calls.reports[0].value.summary, /no work was replayed/i);
    assert.equal(turnRequests(paths).length, 0);
    await adapter.connector.shutdown();
  }
});

test('a resumed assignment sends queued inputs in its continuation launch turn', async t => {
  const paths = createPaths(t, {
    launch: { report: { state: 'waiting', summary: 'Assignment turn completed.' } },
  });
  const ticket = createTicket(paths);
  ticket.origin.triggerIds = ['source-trigger'];
  const adapter = createAdapter(t, paths, [ticket]);
  const originalTrigger = {
    id: 'source-trigger', actor: 'requester', text: 'Original source request that must not be repeated.',
  };
  adapter.host.store.triggers.set(originalTrigger.id, originalTrigger);
  await adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: 'assignment-1' });

  ticket.assignments.push({ id: 'assignment-2', state: 'queued' });
  const queuedInput = { id: 'queued-input', kind: 'context', text: 'New input for the resumed assignment.' };
  ticket.inputs.push(queuedInput);
  ticket.undelivered.push(queuedInput.id);
  await adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: 'assignment-2' });

  const turns = turnRequests(paths, 'launch');
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].payload.requests, [{
    id: originalTrigger.id, author: originalTrigger.actor, text: originalTrigger.text,
  }]);
  assert.deepEqual(turns[1].payload.requests, []);
  assert.deepEqual(turns[1].payload.inputs, [queuedInput]);
  assert.match(turns[1].payload.continuation, /existing conversation and workspace/);
  assert.equal(JSON.stringify(turns[1].payload).includes(originalTrigger.text), false);
  assert.ok(adapter.calls.inputsDelivered.some(call => call.assignmentId === 'assignment-2'
    && call.inputIds.length === 1 && call.inputIds[0] === queuedInput.id));
  assert.deepEqual(ticket.undelivered, []);
  assert.equal(adapter.effects.queued.some(effect => effect.name === 'delivery'), false);
  assert.equal(logEntries(paths).filter(entry => entry.event === 'rpc' && entry.method === 'thread/resume').length, 1);
});

test('launch and delivery share the same maxWorkers capacity', async t => {
  const paths = createPaths(t, {
    launch: { report: { state: 'waiting', summary: 'Launch completed.' } },
    delivery: { report: { state: 'waiting', summary: 'Delivery completed.' } },
  });
  const preparation = deferred();
  const preparing = deferred();
  const launchTicket = createTicket(paths, { id: 'launch-ticket', assignmentId: 'launch-assignment' });
  launchTicket.execution.directory = join(paths.root, 'prepared-launch-work');
  const input = { id: 'delivery-input', kind: 'context', text: 'Queued follow-up.' };
  const deliveryTicket = createTicket(paths, {
    id: 'delivery-ticket', assignmentId: 'delivery-assignment', assignmentState: 'running',
    inputs: [input], undelivered: [input.id],
  });
  const adapter = createAdapter(t, paths, [launchTicket, deliveryTicket], {
    maxWorkers: 1,
    prepareWorkspace: async ticket => {
      if (ticket.id === launchTicket.id) {
        preparing.resolve();
        await preparation.promise;
        mkdirSync(ticket.execution.directory);
      }
    },
  });

  const launch = adapter.effects.invoke('launch', {
    ticketId: launchTicket.id, assignmentId: 'launch-assignment',
  });
  await preparing.promise;
  assert.equal(adapter.connector.activeCount(), 1);
  await assert.rejects(
    adapter.effects.invoke('delivery', { ticketId: deliveryTicket.id }),
    error => error instanceof Later && /worker slots/.test(error.message),
  );

  preparation.resolve();
  await launch;
  assert.equal(adapter.connector.activeCount(), 0);
  await adapter.effects.invoke('delivery', { ticketId: deliveryTicket.id });
  assert.deepEqual(adapter.calls.inputsRead.at(-1).inputIds, ['delivery-input']);
});

test('stop during workspace preparation prevents a turn from starting', async t => {
  const paths = createPaths(t, {
    launch: { report: { state: 'ready', summary: 'Must not run.' } },
  });
  const preparation = deferred();
  const preparing = deferred();
  const ticket = createTicket(paths);
  ticket.execution.directory = join(paths.root, 'stopped-before-preparation');
  const adapter = createAdapter(t, paths, [ticket], {
    prepareWorkspace: async () => {
      preparing.resolve();
      await preparation.promise;
    },
  });
  const running = adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: 'assignment-1' });
  await preparing.promise;

  ticket.ended = true;
  ticket.assignments[0].state = 'ended';
  adapter.connector.stop(ticket);
  preparation.resolve();
  await running;

  assert.equal(turnRequests(paths).length, 0);
  assert.equal(adapter.calls.reports.length, 0);
  assert.equal(adapter.connector.activeCount(), 0);
});

test('input delivery cannot acknowledge or report into a newer assignment', async t => {
  const paths = createPaths(t, {
    delivery: {
      ack: 'hold', completion: 'hold',
      report: { state: 'ready', summary: 'Stale delivery completion.' },
    },
  });
  const input = { id: 'input-1', kind: 'context', text: 'Input for the old assignment.' };
  const ticket = createTicket(paths, { assignmentState: 'running', inputs: [input], undelivered: [input.id] });
  const adapter = createAdapter(t, paths, [ticket]);
  const running = adapter.effects.invoke('delivery', { ticketId: ticket.id });
  await waitUntil(() => marker(paths, 'requested-delivery-1'), 'stale delivery turn request');

  ticket.assignments.push({ id: 'assignment-2', state: 'queued' });
  release(paths, 'ack-delivery-1');
  await running;

  assert.equal(adapter.calls.inputsDelivered.length, 0);
  assert.equal(adapter.calls.inputsRead.length, 0);
  assert.equal(adapter.calls.reports.length, 0);
  assert.equal(ticket.assignments[1].report, undefined);
  assert.deepEqual(ticket.undelivered, ['input-1']);
});

test('a workspace preparation failure is not rerun by automatic resume', async t => {
  const paths = createPaths(t, {
    launch: { report: { state: 'ready', summary: 'Must not run.' } },
  });
  const ticket = createTicket(paths);
  ticket.execution.directory = join(paths.root, 'failed-preparation');
  let attempts = 0;
  const adapter = createAdapter(t, paths, [ticket], {
    prepareWorkspace: async () => {
      attempts += 1;
      throw new Error('Synthetic workspace preparation failed.');
    },
  });

  await adapter.effects.invoke('launch', { ticketId: ticket.id, assignmentId: 'assignment-1' });
  assert.equal(attempts, 1);
  assert.equal(adapter.calls.reports[0].value.state, 'blocked');
  assert.match(adapter.calls.reports[0].value.summary, /preparation failed/);

  adapter.connector.resume();
  const queued = adapter.effects.take('launch');
  await adapter.effects.invoke('launch', queued.payload);
  assert.equal(attempts, 1);
  assert.equal(turnRequests(paths).length, 0);
});
