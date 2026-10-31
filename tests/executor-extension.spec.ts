import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Later } from '../src/app/effects.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { createManagedExecutor, loadExecutorFactory, type ExecutorHelpers, type ManagedExecutor } from '../src/executor/extension.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

let dir: string, sequence: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'executor-extension-')); sequence = 0 })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const moduleFile = (source: string) => { const path = join(dir, `executor-${sequence++}.mjs`); writeFileSync(path, source); return path }

describe('external executor module', () => {
  it('uses no module by default and requires an absolute path', async () => {
    await expect(loadExecutorFactory()).resolves.toBeUndefined()
    await expect(loadExecutorFactory('executor.mjs')).rejects.toThrow('absolute path')
  })

  it('requires API version 1 and a named createExecutor export', async () => {
    await expect(loadExecutorFactory(moduleFile('export const apiVersion = 2\n'))).rejects.toThrow('API version must be 1')
    await expect(loadExecutorFactory(moduleFile('export const apiVersion = 1\n'))).rejects.toThrow('must export createExecutor')
    await expect(loadExecutorFactory(moduleFile('export const apiVersion = 1; export function createExecutor() {}\n'))).resolves.toBeTypeOf('function')
  })

  it('requires a synchronous complete managed lifecycle', () => {
    expect(() => createManagedExecutor((() => Promise.resolve({})) as never, {} as never, {} as never)).toThrow('return synchronously')
    expect(() => createManagedExecutor((() => ({})) as never, {} as never, {} as never)).toThrow('missing methods: start, deliver')
    const method = () => {}
    const executor = Object.fromEntries(['start', 'deliver', 'stop', 'prepare', 'install', 'resume', 'dispose', 'shutdown', 'activeCount']
      .map(name => [name, method])) as unknown as ManagedExecutor
    expect(createManagedExecutor(() => executor, {} as never, {} as never)).toBe(executor)
  })

  it('provides native defer and report-relay helpers to an external factory', async () => {
    let helpers!: ExecutorHelpers
    const host = await startRuntime(undefined, (connector, value) => { helpers = value; return new DshExecutor(connector) })
    try {
      expect(() => helpers.defer('Worker slot is busy')).toThrow(Later)
      const { ticket } = await host.acceptedTicket(feishu('91', '@bot 修复扩展执行器'))
      expect(helpers.waitsForPerson(ticket)).toBe(false)
      expect(helpers.waitsForPerson(host.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Needs a person' }))).toBe(true)
      helpers.relayReport(ticket, 'ready', 'External worker finished')
      await vi.waitFor(() => expect(host.relays(host.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'ready', summary: 'External worker finished' }))
    } finally { await host.stop() }
  })
})
