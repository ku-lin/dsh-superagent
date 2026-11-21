/**
 * Operator control over the Router conversation: the stop/start switch, the audit trail, and deletion of the conversations
 * this plugin owns.
 *
 * The switch is pinned here for the two properties that make it safe: it never touches the Executor's own `paused` gate
 * (running Tickets keep working), and a stopped Router holds deliveries in the durable effect queue instead of dropping
 * them. Deletion is pinned for its permission boundary — worker and router-level conversations only, never the permanent
 * Router conversation — and for what it does and does not remove on disk.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AUDIT_LIMIT, Control, ControlError, auditTrail, encodeSegment, removeSessionLog, routerStopped,
  routerSwitch, sessionRoot } from '../src/app/control.ts'
import { ROUTER_PRESET, WORKER_PRESET } from '../src/app/router-sessions.ts'
import { Store } from '../src/app/store.ts'

const MASTER = 'session-1b84c2b5-d08d-457b-8737-f8879efbfb05'
const directories: string[] = [], stores: Store[] = []
afterEach(() => {
  // Close every store first: an open SQLite handle keeps its file locked on Windows, so the directory stays behind.
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A state directory holding one open store, which is what the control surface reads the switch from. */
function state(): { directory: string; store: Store } {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-control-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  stores.push(store)
  return { directory, store }
}

/**
 * A host the control surface can drive: real headers for the conversations it knows, one workspace that accounts for them,
 * and a projection cache whose row a deletion drops.
 */
function host(store: Store, headers: readonly { id: string; agentPreset?: string }[], options: { root?: string | undefined } = {}) {
  const archived: string[] = [], detached: string[] = [], dropped: string[] = []
  const workspaces = headers.map(item => ({ id: `ws-${item.id}`, title: `Workspace ${item.id}`,
    sessionIds: [item.id as never] as never, detachSession: async (id: string) => { detached.push(id) } }))
  const rows = new Map(headers.map(item => [item.id, true]))
  const context = {
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    agents: { get: () => undefined },
    sessionPersistence: { list: async () => headers.map(item => ({ header: { version: SESSION_FORMAT_VERSION, id: item.id,
      createdAt: 1_000, isSeeded: false, ...item.agentPreset ? { agentPreset: item.agentPreset } : {} } })) },
    workspaceRegistry: { archiveSession: async (id: string) => { archived.push(id) }, list: () => workspaces },
    get: (name: string) => name === 'storageDomain' ? { get: () => ({ table: () => ({
      get: (key: string) => rows.get(key) ? { ver: 1 } : undefined,
      delete: async (key: string) => { dropped.push(key); return true } }) }) } : undefined,
  }
  const control = new Control({ context: context as unknown as Context, store, masterId: MASTER, requestPass: () => {},
    sessionRoot: () => options.root })
  return { control, archived, detached, dropped }
}

describe('the Router switch', () => {
  it('starts running, stops with a reason, and starts again without touching the Executor pause', () => {
    const { store } = state()
    const { control } = host(store, [])
    // Never stopped: an installation that never used the switch reads as running, not as a missing record.
    expect(routerSwitch(store)).toEqual({ paused: false, reason: '', at: '', by: 'panel' })
    expect(control.stopped).toBe(false)
    const stopped = control.stopRouter('  pausing for a deploy  ', 'panel')
    expect(stopped).toMatchObject({ paused: true, reason: 'pausing for a deploy', by: 'panel' })
    expect(stopped.at).not.toBe('')
    expect(routerStopped(store)).toBe(true)
    // The switch is its own record: the Executor gate and the policy version are untouched, so running Tickets continue.
    expect(store.settings().paused).toBe(false)
    const started = control.startRouter('tool')
    expect(started).toMatchObject({ paused: false, reason: '', by: 'tool' })
    expect(routerStopped(store)).toBe(false)
  })

  it('refuses a stop that changes nothing and a start while running, and audits both writes', () => {
    const { store } = state()
    const { control } = host(store, [])
    expect(() => control.startRouter('panel')).toThrow(ControlError)
    control.stopRouter('deploy', 'panel')
    expect(() => control.stopRouter('again', 'panel')).toThrow(ControlError)
    expect(() => control.startRouter('panel')).not.toThrow()
    const trail = auditTrail(store)
    expect(trail.map(entry => [entry.action, entry.ok])).toEqual([['router.stop', true], ['router.start', true]])
    expect(trail[0]).toMatchObject({ note: 'deploy', by: 'panel' })
  })

  it('keeps the newest entries only, so the trail cannot grow without bound', () => {
    const { store } = state()
    const { control } = host(store, [])
    for (let index = 0; index < AUDIT_LIMIT + 20; index++) {
      control.stopRouter('cycle', 'panel')
      control.startRouter('panel')
    }
    const trail = auditTrail(store)
    expect(trail).toHaveLength(AUDIT_LIMIT)
    expect(trail.at(-1)).toMatchObject({ action: 'router.start', ok: true })
  })
})

describe('deleting a conversation', () => {
  it('refuses without confirm, refuses the Router conversation, and refuses a person\'s own conversation', async () => {
    const { store } = state()
    const { control, archived } = host(store, [{ id: 'worker-t1', agentPreset: WORKER_PRESET },
      { id: 'session-plain' }, { id: MASTER, agentPreset: ROUTER_PRESET }])
    await expect(control.deleteSession('worker-t1', false, 'panel')).rejects.toMatchObject({ code: 'confirmRequired' })
    // The Router conversation would leave the panel with no Router at all.
    await expect(control.deleteSession(MASTER, true, 'panel')).rejects.toMatchObject({ code: 'routerSession', status: 409 })
    // A conversation this plugin did not create is somebody's own; nothing about it is touched.
    await expect(control.deleteSession('session-plain', true, 'panel')).rejects.toMatchObject({ code: 'notDeletable', status: 409 })
    expect(archived).toEqual([])
    // Only the refusals were audited, and each names why.
    expect(auditTrail(store).map(entry => entry.note)).toEqual(['routerSession', 'notDeletable'])
  })

  it('deletes a worker conversation, archiving it and detaching it from every workspace that accounted for it', async () => {
    const { store } = state()
    const { control, archived, detached, dropped } = host(store, [{ id: 'worker-t1', agentPreset: WORKER_PRESET }])
    expect(await control.sessionKind('worker-t1')).toBe('worker')
    expect(await control.sessionKind(MASTER)).toBe('router-main')
    const report = await control.deleteSession('worker-t1', true, 'panel')
    expect(report).toMatchObject({ sessionId: 'worker-t1', kind: 'worker', archived: true, projections: 'dropped' })
    expect(archived).toEqual(['worker-t1'])
    expect(detached).toEqual(['worker-t1'])
    expect(dropped).toEqual(['worker-t1'])
    expect(auditTrail(store).at(-1)).toMatchObject({ action: 'session.delete', ok: true, target: 'worker-t1' })
  })

  it('selects a router-level conversation on its durable header, not on the preset projection', async () => {
    const { store } = state()
    // A second router conversation: its header ran the router preset, which is the only authority the selection reads.
    const { control } = host(store, [{ id: 'session-other', agentPreset: ROUTER_PRESET }])
    expect(await control.sessionKind('session-other')).toBe('router')
    expect(await control.deleteSession('session-other', true, 'tool')).toMatchObject({ kind: 'router', archived: true })
  })
})

describe('the deleted conversation\'s stored log', () => {
  /** A persistence root laid out the way the JSONL backend writes one conversation. */
  function root(id: string, files: readonly string[] = ['session.v4.jsonl.zstd']): string {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-log-'))
    directories.push(directory)
    const session = join(directory, '--S-work--', encodeSegment(id))
    mkdirSync(session, { recursive: true })
    for (const name of files) writeFileSync(join(session, name), 'x')
    return directory
  }

  it('encodes a session id exactly as the backend does, so the directory can be found by name', () => {
    expect(encodeSegment('worker-t1')).toBe('worker-t1')
    expect(encodeSegment('session-a.b_c-d')).toBe('session-a.b_c-d')
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('a~b')).toBe('a~007Eb')
    expect(encodeSegment('中文')).toBe('~4E2D~6587')
  })

  it('removes a session directory that holds only session log generations', async () => {
    const id = 'worker-t1', directory = root(id, ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'])
    expect(await removeSessionLog(directory, id)).toMatchObject({ state: 'removed' })
    // Removed, and a second deletion reports the absence instead of failing.
    expect(await removeSessionLog(directory, id)).toEqual({ state: 'absent' })
  })

  it('keeps the directory when it holds anything besides a session log', async () => {
    const id = 'worker-t1', directory = root(id, ['session.v4.jsonl.zstd', 'attachments'])
    const outcome = await removeSessionLog(directory, id)
    expect(outcome.state).toBe('retained')
    expect(outcome.state === 'retained' && outcome.reason).toContain('attachments')
  })

  it('reports an unknown root, a missing conversation, and duplicate directories without removing anything', async () => {
    expect(await removeSessionLog(undefined, 'worker-t1')).toMatchObject({ state: 'retained' })
    expect(await removeSessionLog(join(tmpdir(), 'no-such-root-orchestrator'), 'worker-t1')).toMatchObject({ state: 'retained' })
    const directory = root('worker-t1')
    expect(await removeSessionLog(directory, 'worker-t2')).toEqual({ state: 'absent' })
    // Two project directories holding the same id is ambiguous, so the bytes stay.
    const second = join(directory, '--S-other--', encodeSegment('worker-t1'))
    mkdirSync(second, { recursive: true })
    writeFileSync(join(second, 'session.v4.jsonl.zstd'), 'x')
    expect(await removeSessionLog(directory, 'worker-t1')).toMatchObject({ state: 'retained' })
  })

  it('reads the root off the mounted backend without assuming one', () => {
    expect(sessionRoot({ get: () => ({ root: 'S:\\deepseek_harness\\.dsh\\sessions' }) } as never))
      .toBe('S:\\deepseek_harness\\.dsh\\sessions')
    // A backend that keeps no such field, an unreadable one, and an empty spelling all report no root.
    expect(sessionRoot({ get: () => ({}) } as never)).toBeUndefined()
    expect(sessionRoot({ get: () => ({ root: '' }) } as never)).toBeUndefined()
    expect(sessionRoot({ get: () => { throw new Error('unmounted') } } as never)).toBeUndefined()
  })

  it('reports a deletion whose log it kept as such, and never claims otherwise', async () => {
    const { store } = state()
    const { control } = host(store, [{ id: 'worker-t1', agentPreset: WORKER_PRESET }], { root: undefined })
    const report = await control.deleteSession('worker-t1', true, 'panel')
    expect(report.log.state).toBe('retained')
    expect(auditTrail(store).at(-1)?.note).toContain('log retained')
  })
})
