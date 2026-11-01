import { createInterface } from 'node:readline';

const mode = process.argv[2];
const input = createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');

function toolParams(callId, tool, argumentsValue) {
  return {
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    callId,
    namespace: 'fixture_tools',
    tool,
    arguments: argumentsValue,
  };
}

function request(id, params) {
  send({ id, method: 'item/tool/call', params });
}

input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { received: message.params } });
    return;
  }
  if (message.method === 'initialized') {
    if (mode === 'success') {
      request(701, toolParams('call-slow', 'wait_for_gate', { sequence: 1 }));
      request(702, toolParams('call-fast', 'return_now', { sequence: 2 }));
      send({ method: 'fixture/ping', params: { afterRequests: true } });
    } else {
      request(701, toolParams(`call-${mode}`, 'fixture_tool', { mode }));
      if (mode === 'disconnect') setTimeout(() => process.exit(7), 25);
    }
    return;
  }
  if (message.id === 701 || message.id === 702) {
    send({ method: 'fixture/toolResponse', params: { requestId: message.id, response: message } });
  }
});
