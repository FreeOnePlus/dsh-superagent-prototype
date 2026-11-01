/** Versioned loading and lifecycle contract for an optional external main coordinator. */
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Health } from '../sources/host.ts'

export const COORDINATOR_API_VERSION = 1 as const

/** One main-coordinator tool, described by the same Zod schema that validates its execution. */
export interface CoordinatorTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  /** A rejected invocation is known not to have changed durable or external state. */
  readonly readOnly?: boolean
}

/** Host capabilities retained by dsh-superagent while an external module owns main coordination. */
export interface CoordinatorHost {
  readonly id: string
  readonly stateDir: string
  readonly lifetime: AbortSignal
  /** Returns and binds the current upstream-owned main prompt revision. */
  prompt(): { text: string; revision: number }
  /** Stable tool registry for this Runtime. */
  tools(): readonly CoordinatorTool[]
  /** Schema-check arguments without invoking the tool. */
  validateTool(name: string, args: unknown): unknown
  /** Schema-check and invoke a named tool through its upstream domain implementation. */
  executeTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown>
  /** Publish local coordinator health on the existing management health board. */
  health(status: Health): void
}

/** Complete lifecycle and delivery surface owned by an external main coordinator. */
export interface ManagedCoordinator {
  start(): Promise<void>
  deliver(message: { id: string; text: string; wake: boolean }): Promise<void>
  holds(id: string): boolean | Promise<boolean>
  status(): Readonly<Record<string, unknown>>
  shutdown(): Promise<void>
}

/** Called synchronously during Runtime composition. */
export type CoordinatorFactory = (host: CoordinatorHost) => ManagedCoordinator
export interface CoordinatorModule { apiVersion: typeof COORDINATOR_API_VERSION; createCoordinator: CoordinatorFactory }

const METHODS = ['start', 'deliver', 'holds', 'status', 'shutdown'] as const

/** Load an absolute ESM module path and validate the versioned factory exports. */
export async function loadCoordinatorFactory(modulePath?: string): Promise<CoordinatorFactory | undefined> {
  if (modulePath === undefined) return undefined
  if (!isAbsolute(modulePath)) throw new Error('coordinatorModule must be an absolute path')
  const loaded = await import(pathToFileURL(modulePath).href) as Partial<CoordinatorModule>
  if (loaded.apiVersion !== COORDINATOR_API_VERSION) {
    throw new Error(`Coordinator module API version must be ${COORDINATOR_API_VERSION}; received ${String(loaded.apiVersion)}`)
  }
  if (typeof loaded.createCoordinator !== 'function') throw new Error('Coordinator module must export createCoordinator(host)')
  return loaded.createCoordinator
}

/** Invoke a configured factory without fallback and reject incomplete or asynchronous lifecycle objects. */
export function createManagedCoordinator(factory: CoordinatorFactory, host: CoordinatorHost): ManagedCoordinator {
  const coordinator = factory(host) as unknown
  if (coordinator && typeof (coordinator as { then?: unknown }).then === 'function') throw new Error('createCoordinator must return synchronously')
  const missing = METHODS.filter(method => typeof (coordinator as Partial<Record<typeof method, unknown>> | null)?.[method] !== 'function')
  if (missing.length) throw new Error(`Coordinator module result is missing methods: ${missing.join(', ')}`)
  return coordinator as ManagedCoordinator
}
