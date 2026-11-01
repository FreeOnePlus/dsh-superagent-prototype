# Codex Coordination and Execution Bridge

Use Codex for coordination and native workers behind an orchestration host,
without embedding the host's implementation in the adapters.

The connector targets the versioned extension seams supplied with this fork.
The unmodified upstream prototype does **not** offer these seams.
Worker-only configuration retains the DSH coordinator. Configuring both modules
uses Codex for the main coordinator and workers. The host still provides the
task engine, durable effects, source connections, settings and management panel.

```text
Source messages and worker reports
    -> coordinatorModule (API v1)
    -> durable serial inbox -> Codex coordinator
    -> validated host tools -> Orchestrator Engine
    -> executorModule (API v1)
    -> independent Codex workers -> reports back to the coordinator
```

## Requirements

- Node.js 22.19+ within the 22.x series, or Node.js 24+ for the host.
- A signed-in Codex CLI with the documented app-server protocol. The initial
  local validation used Codex CLI 0.153.4.
- The coordinator opts into the experimental environment-selection API,
  `dynamicTools` and `item/tool/call`.
  Pin and validate the Codex version; these are not a stable compatibility promise.
- The separately maintained upstream extension patch, based on commit
  `6337fc823ce20251c8de8085948165c81aaa701e`.
- A model available to the signed-in account. An installed default model can be
  unavailable to that account; the bridge preserves that failure instead of
  silently selecting another model.

## Install

Install this independent package from its checkout:

```sh
npm ci --ignore-scripts
```

When using the fork's `adapters/codex-executor-bridge` directory, the host seams
are already included. When using an unmodified upstream checkout, apply the
supplied extension patch, first using `git apply --check`, then run its locked
checks and build. The extension preserves
the built-in executor when `executorModule` is not configured. An invalid
configured module stops startup; it never falls back silently.

Add an absolute module path to the existing host plugin configuration:

```yaml
executorModule: /absolute/path/codex-executor-bridge/src/connector.mjs
coordinatorModule: /absolute/path/codex-executor-bridge/src/coordinator-connector.mjs
```

Optionally create `codex-executor.json` in the host's existing **state directory**:

```json
{
  "command": ["codex", "app-server"],
  "sandbox": "workspace-write",
  "timeoutMs": 30000,
  "turnTimeoutMs": 1800000
}
```

Add `model` only when an explicit model is needed. Omit it to retain Codex's
configuration. Hosts that require RTK can use
`["rtk", "proxy", "codex", "app-server"]`. Do not put credentials in this file.
Codex uses its existing login. Restart the host after changing the executor
module or its configuration; Node caches imported modules.

The coordinator reads a separate optional `codex-coordinator.json` in the same
host state directory:

```json
{
  "command": ["codex", "app-server"],
  "timeoutMs": 30000,
  "turnTimeoutMs": 600000
}
```

It also accepts an explicit `model`. Neither file changes the user's global
Codex settings. The coordinator operates without a writable execution environment;
it calls the supplied host tools. Ambient MCP and app tools are disabled for its
thread. Bundled plugin MCP connections are discovered and scoped off while the
plugins and safety hooks remain installed. If isolation cannot be confirmed,
no model turn starts. Discovery may replace the adapter's own process once before
work begins; it does not terminate other Codex sessions.

Workers apply the same ambient MCP/app restrictions while retaining shell tools,
their configured workspace sandbox and Codex's default execution environment.
An empty `environments` list would remove their execution tools, so workers do
not send that override. Custom remote execution environments are not validated.
Startup failures close the owned process and restore the previous thread binding
before another request can start.

The usual host repository setup, source authorization, worker environment and
workspace preparation still apply. The adapter does not configure those for you.
Start with an isolated checkout and a dedicated host state directory.

## Behavior

| Operation | Behavior |
| --- | --- |
| Dispatch | Records request identity before creating a Codex turn |
| Follow-up | Uses the same per-ticket Codex thread and workspace; queues while a turn is active |
| Duplicate | Same identity/content returns its recorded receipt; changed content is rejected |
| Cancel | Calls `turn/interrupt`; its acknowledgement alone is not proof of interruption |
| Resume | Restores the saved thread; reconciles known turns before starting new work |
| Unknown result | Blocks automatic replay; retains the thread and turn references for investigation |
| Report | Validates structured output; distinguishes completion, failure, interruption and uncertainty |
| Late result | Cannot update an ended or replaced host assignment |
| Concurrency | Launches and follow-ups share the configured worker limit |

Worker state uses private files, atomic replacement and an exclusive writer
lock. Preserve `codex-executor-state/` alongside the host state and Codex's own
thread history. After an unclean exit the stale lock expires after 30 seconds;
this does not authorize replay of an ambiguous request. Workspace effects are
not rolled back by cancellation.

The non-interactive bridge uses `approvalPolicy: never` with a read-only or
workspace-write sandbox. Server requests needing an interactive approval or
user input are declined/blocked, never automatically granted. This component is
not an authentication or approval bypass.

## Boundaries

- A worker's `ready` report retains the host's existing ticket semantics. It is
  **not** an independent review, merge, release, or AWR acceptance receipt.
- The web panel can retain task state and supervisor report visibility. A Codex
  worker is not a DSH Session: the existing DSH worker-chat link cannot display
  its conversation. A native transcript viewer is outside this first adapter.
- This version supplies start, queued follow-up, cancellation and recovery. It
  does not expose every DSH worker-specific tool to Codex or replace source
  connectors, deployment setup, or the management application's model settings.
  Select Codex models in the bridge configuration files.
- `ExecutorHost` is a current-version connector contract. Only `connector.mjs`
  depends on its DTOs. `executor.mjs`, `rpc.mjs` and `store.mjs` do not import the
  host. A future breaking change requires updating and testing the connector or
  revising the seam's API version. Future compatibility is not assumed.
- Missing start acknowledgement without a saved turn ID remains unknown. This
  version deliberately requires investigation rather than guessing which turn
  belongs to the request. There is no exactly-once guarantee for external tool
  side effects.

## Coordinator behavior

- One persisted Codex thread handles waking messages in order. Workers remain
  parallel; the coordinator does not wait in a model turn for worker completion.
- Message IDs bind their exact text and wake flag. Repeated delivery is a no-op;
  reusing an ID with changed content is rejected.
- Silent notices are persisted without a model call and included with the next
  waking message. Mid-turn steering and native DSH injection semantics are not
  implemented by this serial adapter.
- The host supplies the current prompt revision and named tool schemas. It
  validates arguments before execution; the bridge binds calls to the active
  thread and turn. Plain model prose never creates a task or sends a source reply.
- Tool calls are journaled before invocation, with results saved before returning
  them to Codex. Repeated call IDs return the recorded result. A failed query
  explicitly marked `readOnly` by the host returns a recorded error without
  blocking later work. Other exceptions after invocation leave an uncertain
  outcome and stop automatic advancement.
- Shutdown stops active work and retains queued messages. On restart, known turn
  IDs are reconciled with Codex history. No acknowledged terminal result means no
  automatic replay; status identifies the affected request for investigation.
- `CodexCoordinator` exposes `status()`, `idle()`, and `recover()` to local hosts.
  `recover()` queries existing turns; it never asserts that an uncertain external
  operation did not happen. Preserve `codex-coordinator-state/` together with
  the host database and Codex thread history.

The upstream extension retains its normal domain authorization and reply gates.
It exposes external coordinator status through the existing session status view.
Native DSH coordinator/worker chat transcripts, assessment image delivery,
advanced live steering and full UI parity are outside this adapter. Local
adapter verification is not live GitHub/Feishu or AWR Team business acceptance.

## Verification

```sh
npm test
```

The public tests use original synthetic inputs and an explicit fake app-server;
they cover idempotency, cancellation races, recovery, structured reporting,
concurrency and host callback fencing. Real-model runs and internal task records
are kept outside the public source tree. Passing these tests is not full DSH UI,
GitHub/Feishu, multi-user or AWR business acceptance.

Official transport reference: [Codex app-server](https://developers.openai.com/codex/app-server/).

## Upgrade procedure

1. Keep the currently verified upstream commit and adapter version available.
2. Apply the small extension patch to a new upstream checkout with
   `git apply --check`; stop if it does not apply cleanly.
3. Run upstream checks and this package's tests. Verify API v1 shape validation
   and launch a real task, follow-up and cancellation in an isolated environment.
4. Adopt the new version only after verifying receipts. Patch application alone
   proves neither compatibility nor business acceptance.

This independent implementation is licensed under Apache-2.0. The upstream
checkout and its separately maintained changes retain the upstream license and
notices; upstream source is not vendored into this package.
