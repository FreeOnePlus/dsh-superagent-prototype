import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [planFile, controlDirectory, logFile] = process.argv.slice(2);
const input = createInterface({ input: process.stdin });
const active = new Map();
const finished = [];

function record(value) {
  appendFileSync(logFile, JSON.stringify(value) + '\n');
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function planFor(kind) {
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  return plan[kind] ?? { report: { state: 'waiting', summary: `${kind} fixture completed.` } };
}

function nextIndex(kind) {
  if (!existsSync(logFile)) return 1;
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry.event === 'turn-requested' && entry.kind === kind).length + 1;
}

async function waitForGate(name, turn) {
  while (!existsSync(join(controlDirectory, name))) {
    if (turn.done) return false;
    await delay(5);
  }
  return !turn.done;
}

async function startTurn(message) {
  const text = message.params?.input?.[0]?.text ?? '{}';
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  const kind = Array.isArray(payload.followUp) ? 'delivery' : 'launch';
  const index = nextIndex(kind);
  const turnId = `${kind}-turn-${index}`;
  const threadId = message.params.threadId;
  const plan = planFor(kind);
  const turn = { id: turnId, threadId, status: 'running', items: [], done: false };
  active.set(turnId, turn);
  record({ event: 'turn-requested', kind, index, turnId, payload });
  writeFileSync(join(controlDirectory, `requested-${kind}-${index}`), turnId);

  if (plan.ack === 'hold' && !await waitForGate(`ack-${kind}-${index}`, turn)) return;
  send({ id: message.id, result: { turn: { id: turnId } } });
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
  record({ event: 'turn-accepted', kind, index, turnId });
  writeFileSync(join(controlDirectory, `accepted-${kind}-${index}`), turnId);

  if (plan.completion === 'hold' && !await waitForGate(`complete-${kind}-${index}`, turn)) return;
  if (turn.done) return;
  const report = plan.report ?? { state: 'waiting', summary: `${kind} fixture completed.` };
  const item = { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(report) };
  send({ method: 'item/completed', params: { threadId, turnId, item } });
  turn.done = true;
  turn.status = plan.status ?? 'completed';
  turn.items = [item];
  if (plan.error) turn.error = { message: plan.error };
  finished.push(turn);
  send({ method: 'turn/completed', params: { threadId, turn } });
  record({ event: 'turn-finished', kind, index, turnId, status: turn.status });
}

input.on('line', line => {
  const message = JSON.parse(line);
  record({ event: 'rpc', method: message.method, id: message.id });
  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: {} } });
  } else if (message.method === 'initialized') {
    // Notification acknowledgement is intentionally empty.
  } else if (message.method === 'config/read') {
    send({ id: message.id, result: { config: { mcp_servers: {}, apps: {} } } });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'fixture-thread' } } });
  } else if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  } else if (message.method === 'mcpServerStatus/list') {
    send({ id: message.id, result: { data: [] } });
  } else if (message.method === 'turn/start') {
    void startTurn(message);
  } else if (message.method === 'turn/interrupt') {
    const turn = active.get(message.params.turnId);
    send({ id: message.id, result: {} });
    if (turn && !turn.done) {
      turn.done = true;
      turn.status = 'interrupted';
      finished.push(turn);
      send({ method: 'turn/completed', params: { threadId: turn.threadId, turn } });
      record({ event: 'turn-finished', turnId: turn.id, status: turn.status });
    }
  } else if (message.method === 'thread/turns/list') {
    send({ id: message.id, result: { data: [...finished].reverse() } });
  }
});
