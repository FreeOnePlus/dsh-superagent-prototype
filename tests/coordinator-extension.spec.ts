import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagedCoordinator, loadCoordinatorFactory, type CoordinatorHost, type ManagedCoordinator }
  from '../src/coordinator/extension.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

let dir: string, sequence: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'coordinator-extension-')); sequence = 0 })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const moduleFile = (source: string) => { const path = join(dir, `coordinator-${sequence++}.mjs`); writeFileSync(path, source); return path }

const managed = (overrides: Partial<ManagedCoordinator> = {}): ManagedCoordinator => ({
  start: async () => {}, deliver: async () => {}, holds: () => false, status: () => ({}), shutdown: async () => {}, ...overrides,
})

describe('external coordinator module', () => {
  it('uses no module by default and requires an absolute path', async () => {
    await expect(loadCoordinatorFactory()).resolves.toBeUndefined()
    await expect(loadCoordinatorFactory('coordinator.mjs')).rejects.toThrow('absolute path')
  })

  it('requires API version 1 and a named createCoordinator export', async () => {
    await expect(loadCoordinatorFactory(moduleFile('export const apiVersion = 2\n'))).rejects.toThrow('API version must be 1')
    await expect(loadCoordinatorFactory(moduleFile('export const apiVersion = 1\n'))).rejects.toThrow('must export createCoordinator')
    await expect(loadCoordinatorFactory(moduleFile('export const apiVersion = 1; export function createCoordinator() {}\n')))
      .resolves.toBeTypeOf('function')
  })

  it('requires a synchronous complete managed lifecycle', () => {
    expect(() => createManagedCoordinator((() => Promise.resolve({})) as never, {} as never)).toThrow('return synchronously')
    expect(() => createManagedCoordinator((() => ({})) as never, {} as never)).toThrow('missing methods: start, deliver')
    const coordinator = managed()
    expect(createManagedCoordinator(() => coordinator, {} as never)).toBe(coordinator)
  })

  it('routes the main prompt, validated tools, waking delivery, silent notices and shutdown without creating a DSH master', async () => {
    let port!: CoordinatorHost
    const delivered: { id: string; text: string; wake: boolean }[] = []
    const held = new Set<string>()
    const start = vi.fn(async () => {})
    const shutdown = vi.fn(async () => {})
    const host = await startRuntime(undefined, undefined, connector => {
      port = connector
      return managed({ start, shutdown, holds: id => held.has(id), deliver: async message => { delivered.push(message); held.add(message.id) } })
    })
    try {
      expect(start).toHaveBeenCalledOnce()
      expect(host.agents.has(host.runtime.masterId)).toBe(false)
      expect(host.controller.create.mock.calls.some(([input]) => input.sessionId === host.runtime.masterId)).toBe(false)
      expect(await host.api('GET', 'state')).toMatchObject({ status: 200,
        body: { masterId: host.runtime.masterId, mainSessionId: null } })
      expect(host.runtime.health.coordinator).toMatchObject({ state: 'ready' })

      const prompt = port.prompt()
      expect(prompt.text).toContain(`[dsh-superagent prompt revision ${prompt.revision}]`)
      expect(host.runtime.sessions.mayRead(host.runtime.masterId, prompt.revision)).toBe(true)
      expect(host.runtime.sessions.status()).toMatchObject({ sessions: [{ sessionId: host.runtime.masterId, revision: prompt.revision }], coordinator: {} })
      const exposed = port.tools(), tools = new Map(exposed.map(tool => [tool.name, tool]))
      expect(exposed.filter(tool => tool.readOnly).map(tool => tool.name))
        .toEqual(['orchestrator_read', 'orchestrator_eval', 'orchestrator_eval_read'])
      expect(tools.get('orchestrator_route')?.readOnly).toBeUndefined()
      expect(tools.get('orchestrator_eval_read')?.description).toContain('Image attachments are unavailable')
      expect(() => port.validateTool('orchestrator_route', {})).toThrow()
      expect(() => port.validateTool('missing', {})).toThrow('Unknown coordinator tool')
      const assessmentRead = vi.spyOn(host.runtime.assessor, 'read')
      expect(() => port.validateTool('orchestrator_eval_read',
        { trigger_id: 'x', resource: 'image', image_id: 'x/y', offset: 0 })).toThrow('unavailable with an external coordinator')
      await expect(port.executeTool('orchestrator_eval_read', { trigger_id: 'x', resource: 'image', image_id: 'x/y', offset: 0 },
        new AbortController().signal)).rejects.toThrow('unavailable with an external coordinator')
      expect(assessmentRead).not.toHaveBeenCalled()

      host.runtime.receive(feishu('91', '@bot 修复协调入口'))
      await host.runtime.idle()
      const candidate = delivered.map(item => { try { return JSON.parse(item.text) as Record<string, unknown> } catch { return {} } })
        .find(item => item.kind === 'candidate')!
      expect(candidate).toBeDefined()
      expect(delivered.find(item => item.text.includes('"kind":"candidate"'))?.wake).toBe(true)
      const result = await port.executeTool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: candidate.trigger_id,
        title: 'Fix coordinator entry', worktree_name: 'fix-coordinator', acknowledgement: '收到，修复协调入口。' }] }, new AbortController().signal)
      expect(result).toMatchObject({ results: [{ decision: 'accept' }] })

      host.runtime.sessions.notify('test', { kind: 'notice' }, 'Test notice')
      await vi.waitFor(() => expect(delivered.some(item => item.text === '{"kind":"notice"}' && !item.wake)).toBe(true))
    } finally {
      await host.stop()
      expect(shutdown).toHaveBeenCalledOnce()
    }
  })

  it('publishes the real native main Session as available', async () => {
    const host = await startRuntime()
    try {
      expect(host.agents.has(host.runtime.masterId)).toBe(true)
      expect(await host.api('GET', 'state')).toMatchObject({ status: 200,
        body: { masterId: host.runtime.masterId, mainSessionId: host.runtime.masterId } })
    } finally { await host.stop() }
  })
})
