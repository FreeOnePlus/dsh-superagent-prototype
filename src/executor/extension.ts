/** Versioned loading and lifecycle contract for an optional external Executor implementation. */
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AssessmentOutcome, Executor, Ticket, WorkerReport } from '../core/index.ts'
import type { ExecutorHost } from './dsh.ts'

export const EXECUTOR_API_VERSION = 1 as const

/** Runtime lifecycle required in addition to the core Executor port. */
export interface ManagedExecutor extends Executor {
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket
  install(): void
  resume(): void
  dispose(): void
  shutdown(): Promise<void>
  activeCount(): number
}

/** Stable helper operations retained by the host while an external module owns worker execution. */
export interface ExecutorHelpers {
  prepareTicket(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket
  /** Prepare and verify a workspace that the executor has determined does not yet exist. */
  prepareWorkspace(ticket: Ticket): Promise<void>
  /** Hold effect processing without counting a failure, using the built-in retry schedule. */
  defer(message: string): never
  /** Relay an already-recorded worker report to the main Session through its native structured path. */
  relayReport(ticket: Ticket, state: WorkerReport['state'], summary: string): void
  /** Whether the Ticket's latest report requires a person before execution may resume. */
  waitsForPerson(ticket: Ticket): boolean
}

/** Called synchronously during Runtime composition; `host.engine` must not be read until this call returns. */
export type ExecutorFactory = (host: ExecutorHost, helpers: ExecutorHelpers) => ManagedExecutor
export interface ExecutorModule { apiVersion: typeof EXECUTOR_API_VERSION; createExecutor: ExecutorFactory }

const METHODS = ['start', 'deliver', 'stop', 'prepare', 'install', 'resume', 'dispose', 'shutdown', 'activeCount'] as const

/** Load an absolute ESM module path and validate the versioned factory exports. */
export async function loadExecutorFactory(modulePath?: string): Promise<ExecutorFactory | undefined> {
  if (modulePath === undefined) return undefined
  if (!isAbsolute(modulePath)) throw new Error('executorModule must be an absolute path')
  const loaded = await import(pathToFileURL(modulePath).href) as Partial<ExecutorModule>
  if (loaded.apiVersion !== EXECUTOR_API_VERSION) {
    throw new Error(`Executor module API version must be ${EXECUTOR_API_VERSION}; received ${String(loaded.apiVersion)}`)
  }
  if (typeof loaded.createExecutor !== 'function') throw new Error('Executor module must export createExecutor(host, helpers)')
  return loaded.createExecutor
}

/** Invoke a configured factory without fallback and reject incomplete or asynchronous lifecycle objects. */
export function createManagedExecutor(factory: ExecutorFactory, host: ExecutorHost, helpers: ExecutorHelpers): ManagedExecutor {
  const executor = factory(host, helpers) as unknown
  if (executor && typeof (executor as { then?: unknown }).then === 'function') throw new Error('createExecutor must return synchronously')
  const missing = METHODS.filter(method => typeof (executor as Partial<Record<typeof method, unknown>> | null)?.[method] !== 'function')
  if (missing.length) throw new Error(`Executor module result is missing methods: ${missing.join(', ')}`)
  return executor as ManagedExecutor
}
