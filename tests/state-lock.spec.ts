/**
 * The state directory's lock: a start must survive the lock directory a killed predecessor leaves behind, and a lock
 * another process really holds must be reported instead of unmounting the plugin.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { acquireStateLock, describeLock, lockPath, sleepSync } from '../src/app/state-lock.ts'
import { testMachine } from './fixtures/deployment.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-lock-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
/** A lock whose holder may be taken over by a later test step without the default handler throwing in its timer. */
const take = (options: Parameters<typeof acquireStateLock>[1] = {}) => acquireStateLock(directory, { onCompromised: () => {}, ...options })

/** A DSH web server that keeps the handler of the route it is given, and counts its unmounts. */
function webServer(port: number) {
  type Handler = (req: unknown, res: unknown) => Promise<void>
  const server = { host: '127.0.0.1', port, handler: undefined as Handler | undefined, unmounted: 0,
    register: (route: { handler: Handler }) => { server.handler = route.handler; return () => { server.unmounted += 1 } } }
  return server
}
/** One management call through the route the runtime registered. */
async function answer(server: ReturnType<typeof webServer>, method: string, path: string) {
  let status = 0, text = ''
  const headers = { host: `127.0.0.1:${server.port}`, 'x-orchestrator-request': '1' }
  await server.handler!({ method, url: `/orchestrator/api/${path}`, headers },
    { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

it('takes the lock directory a killed predecessor left stale, without waiting', async () => {
  const killed = take()
  expect(killed.held).toBeDefined()
  // The predecessor died: nothing refreshed its lock directory, so its mtime stopped before the stale window.
  const stale = new Date(Date.now() - 8_000)
  utimesSync(lockPath(directory), stale, stale)
  expect(describeLock(directory)).toMatchObject({ path: lockPath(directory), ageMs: expect.any(Number) })
  const next = take({ staleMs: 5_000, sleep: () => { throw new Error('a stale lock is taken at once: no attempt waits') } })
  expect(next.refusal).toBeUndefined()
  expect(next.held).toMatchObject({ attempts: 1, waitedMs: 0 })
  await next.held!.release()
})

it('refuses the lock with the holder\'s trace while another process keeps it fresh', async () => {
  const held = take()
  const waits: number[] = []
  const refused = take({ attempts: 3, waitMs: 1_000, sleep: ms => { waits.push(ms) } })
  expect(refused.held).toBeUndefined()
  expect(waits).toEqual([1_000, 1_000])
  expect(refused.refusal).toMatchObject({ attempts: 3, waitedMs: 2_000, error: expect.objectContaining({ code: 'ELOCKED' }) })
  expect(refused.refusal!.holder).toMatchObject({ path: lockPath(directory), refreshedAt: expect.any(String), ageMs: expect.any(Number) })
  await held.held!.release()
})

it('takes the lock on a later attempt once its holder lets it go', async () => {
  const held = take()
  const waits: number[] = []
  const taken = take({ attempts: 3, waitMs: 10, sleep: () => { waits.push(1); held.held!.releaseSync() } })
  expect(taken.refusal).toBeUndefined()
  expect(taken.held).toMatchObject({ attempts: 2, waitedMs: 10 })
  expect(waits).toHaveLength(1)
  await taken.held!.release()
})

it('waits without a timer, because the lock must be held before anything else starts', () => {
  const started = Date.now()
  sleepSync(60)
  expect(Date.now() - started).toBeGreaterThanOrEqual(50)
})

it('mounts the plugin and answers the wait when another process holds the state directory', async () => {
  const held = take()
  const server = webServer(3085)
  const ctx = new Context()
  ctx.reflect.provide('webServer', server)
  const ctxLogger = vi.spyOn(ctx.logger, 'error')
  const runtime = new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn(), { attempts: 2, waitMs: 0 })
  await runtime.ready
  // The lock wait is the second of the three states: still starting, and saying why.
  expect(runtime.lockWait).toMatchObject({ attempts: 2, error: expect.objectContaining({ code: 'ELOCKED' }) })
  expect(runtime.health.runtime).toMatchObject({ state: 'starting', code: 'lockWait', detail: expect.stringContaining(lockPath(directory)) })
  expect(runtime.configured()).toBe(false)
  expect(runtime.setupProblem).toBeUndefined()
  // A Source plugin that injects `orchestrator` still mounts: its kind registers, its config is absent, its report lands nowhere.
  const source = runtime.context({ kind: 'github', health: ['github'] })
  expect(source.config('github')).toBeUndefined()
  expect(() => source.report('github', { state: 'ready', detail: '' })).not.toThrow()
  expect(source.configured()).toBe(false)
  expect(source.problem).toBeUndefined()
  // Anything that needs the database says what it waits for instead of reaching for one that is not open.
  expect(() => runtime.deployment).toThrow(lockPath(directory))
  expect(() => source.atomic(() => 1)).toThrow(lockPath(directory))
  expect(() => runtime.idle()).toThrow(lockPath(directory))
  // The panel reads the wait, not the 404s of routes that were never mounted.
  expect(await answer(server, 'GET', 'state')).toMatchObject({ status: 503, body: { code: 'lockWait',
    error: expect.stringContaining(lockPath(directory)),
    lock: { path: lockPath(directory), attempts: 2, waitedMs: 0, holder: expect.objectContaining({ path: lockPath(directory) }) },
    health: { runtime: expect.objectContaining({ code: 'lockWait' }) } } })
  expect(await answer(server, 'GET', 'tickets')).toMatchObject({ status: 503, body: { code: 'lockWait' } })
  await runtime.stop()
  expect(server.unmounted).toBe(1)
  await held.held!.release()
})

it('reports an unusable state directory as an error, keeping the plugin mounted', async () => {
  // A file where the state directory should be cannot be created, which is not a lock race: the third state, `error`.
  const file = join(directory, 'not-a-directory')
  writeFileSync(file, '')
  const server = webServer(3086)
  const ctx = new Context()
  ctx.reflect.provide('webServer', server)
  const runtime = new Runtime(ctx, testMachine({ stateDir: file }), vi.fn(), { attempts: 1, waitMs: 0 })
  await runtime.ready
  expect(runtime.health.runtime).toMatchObject({ state: 'error', code: 'lockError', detail: expect.stringContaining('not-a-directory') })
  expect(await answer(server, 'GET', 'state')).toMatchObject({ status: 503, body: { code: 'lockError', health: { runtime: { state: 'error' } } } })
  await runtime.stop()
})
