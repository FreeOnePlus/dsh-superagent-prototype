# Codex coordinator and workers

This fork can use Codex for both the main coordinator and the workers. DSH
still hosts the plugin, management panel, task engine, database, effects and
source connections. Installing the adapter does not turn Superagent into a
standalone Codex application.

The independently licensed package lives in `adapters/codex-executor-bridge`.
It has its own dependency lockfile and tests and does not import host source.
The host exposes two optional versioned ESM module contracts. Keeping these
contracts small makes upstream updates easier to review; it does not guarantee
compatibility with every future upstream or Codex release.

```text
GitHub / optional Feishu sources
  -> host authorization and admission
  -> serial Codex coordinator inbox
  -> validated host tools
  -> host Engine / Store / Effects
  -> parallel Codex workers in ticket workspaces
  -> host reports -> coordinator -> gated source replies
```

## Prepare an isolated installation

Use Node.js 22.19+ in the 22.x series, or Node.js 24+, and the pinned pnpm
version from the root package. Install and sign into Codex CLI separately.
The adapter was exercised with Codex CLI 0.153.4. Its environment-selection
and dynamic tool interfaces are experimental, so pin the CLI and revalidate
before upgrading it.

```sh
git clone --branch codex/codex-coordination-v1 https://github.com/FreeOnePlus/dsh-superagent-prototype.git
cd dsh-superagent-prototype
pnpm install --frozen-lockfile
npm --prefix adapters/codex-executor-bridge ci --ignore-scripts
pnpm check
npm --prefix adapters/codex-executor-bridge test
```

Complete the normal [host and source setup](006-deployment.md) in a dedicated
DSH profile and state directory. Use a GitHub agent account distinct from the
people requesting work: the GitHub Source ignores the agent's own issues and
comments, so a self-mention cannot verify request intake.

With both adapters configured, coordinator and worker inference use the existing
Codex login. A DSH model account is not required for those turns; the host's
ordinary new-chat screen may still offer its separate model login.

In that profile's existing `dsh-superagent`
configuration, add both absolute paths:

```yaml
- id: dsh-superagent
  config:
    stateDir: /absolute/path/to/dedicated-superagent-state
    executorModule: /absolute/path/to/checkout/adapters/codex-executor-bridge/src/connector.mjs
    coordinatorModule: /absolute/path/to/checkout/adapters/codex-executor-bridge/src/coordinator-connector.mjs
```

Configure only `executorModule` to keep the DSH coordinator while running Codex
workers. Omit both options to retain the original behavior. Invalid configured
modules fail startup rather than silently choosing a different backend.

The optional `codex-executor.json` and `codex-coordinator.json` files belong in
the configured state directory. Each can specify an account-available model:

```json
{
  "command": ["codex", "app-server"],
  "model": "your-available-codex-model"
}
```

Replace the model placeholder, or omit `model` to use the account's configured
default. Environments requiring RTK can use `["rtk", "proxy", "codex", "app-server"]`.
Do not put credentials in these files. The adapter uses Codex's existing login.
Restart this host profile after changing modules or configuration. Full options
and behavior are documented in the [adapter package](../adapters/codex-executor-bridge/).

## Operational behavior

- The coordinator handles messages serially in one persisted Codex thread;
  workers can run concurrently under the host's worker limit.
- Follow-ups continue the ticket's existing thread and workspace. Worker
  results wake the coordinator, which uses host tools to send a source reply.
- Message identities and tool receipts are persisted. Repeated deliveries do
  not create a new turn. Changed content under an existing identity is rejected.
- Failed read-only queries return errors. An unknown mutating tool outcome
  stops automatic advancement so the operation is not blindly repeated.
- Cancellation requests interruption; only a terminal receipt confirms it.
  Recovery queries known turns. Missing acknowledgements remain explicit
  unknown outcomes; there is no exactly-once guarantee for external effects.
- Ambient MCP/app tools are scoped off for adapter threads. The coordinator
  uses host tools; workers retain workspace execution. Plugins and safety
  hooks remain installed, and the user's global Codex configuration is unchanged.

Preserve the host database, `codex-executor-state/`,
`codex-coordinator-state/`, ticket workspaces and Codex's thread history together.
Changing the coordinator's tool registry or execution identity requires an
explicit migration or a separate state directory. Do not delete an uncertain
receipt just to unblock work.

## Validation boundary

Controlled tests cover delivery identity, parallel worker limits, tool routing,
query failures, cancellation races, process cleanup, restart and recovery.
Local real-model integration also exercises the actual host Runtime, Engine,
Store and Effects with a Codex coordinator and Codex workers. Its source and
outbox transports are controlled local substitutes.

These checks are not a live GitHub/Feishu deployment, native client acceptance
or a production-readiness claim. The panel displays host task and report state
and omits DSH session links for externally managed coordinators and workers.
It does not display Codex transcripts. Image
assessment, mid-turn coordinator steering and complete chat UI parity remain
outside this adapter. A worker's `ready` report is not independent approval,
merge or release evidence.

For an upstream update, preserve a working revision, port the small host seams,
run both test suites and repeat a real isolated task with follow-up, restart
and cancellation before adoption.
