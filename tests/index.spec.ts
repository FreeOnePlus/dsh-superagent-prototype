import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import type { ExecutorFactory } from '../src/executor/extension.ts'
import { apply } from '../src/index.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void; executorFactory?: ExecutorFactory }[])
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void, readonly executorFactory?: ExecutorFactory) { runtimes.push(this) }
  configured() { return true }
  async stop() {}
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(runtimes.at(-1)!.executorFactory).toBeUndefined()
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('loads a configured executor module before constructing Runtime and does not fall back when validation fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-entry-'))
  try {
    const valid = join(dir, 'valid.mjs')
    writeFileSync(valid, 'export const apiVersion = 1; export function createExecutor() {}\n')
    const { ctx } = context()
    await apply(ctx as never, Config({ stateDir: '/srv/state', executorModule: valid }))
    expect(runtimes.at(-1)!.executorFactory).toBeTypeOf('function')

    const invalid = join(dir, 'invalid.mjs')
    writeFileSync(invalid, 'export const apiVersion = 2; export function createExecutor() {}\n')
    const before = runtimes.length
    await expect(apply(context().ctx as never, Config({ stateDir: '/srv/state', executorModule: invalid }))).rejects.toThrow('API version must be 1')
    expect(runtimes).toHaveLength(before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})
