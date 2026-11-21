/**
 * Router-level Session selection for the virtual Router workspace.
 *
 * The rows come from durable Session headers, never from the `agentPreset` projection: the shipped 常驻 conversation
 * projects `standard` while its header says `dsh-superagent-router`, so a projection-based filter would drop the one
 * conversation the group exists for. These cases pin the membership rule (router conversations only — a worker stays in
 * the Workspace it works in), the lineage rule, and the exclusion of every other conversation or agent.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import { ROUTER_PRESET, WORKER_PRESET, selectRouterSessions } from '../src/app/router-sessions.ts'

const MASTER = 'session-1b84c2b5-d08d-457b-8737-f8879efbfb05'
/** The worker conversation this machine keeps running, used below as the real shape of a Session the group must ignore. */
const DEMO_WORKER = 'worker-3e7503559090ac72f7c4d26f95654fee'

/** A stored header with the fields the selection reads; the rest are the format's own defaults. */
function header(id: string, fields: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 1_000, isSeeded: false, ...fields } as SessionHeader
}

/** One Session-list row; the selection joins these for title, recency and running state. */
function summary(id: string, fields: Partial<SessionSummary> & { title?: string } = {}): SessionSummary {
  return { agentAvailable: true, sessionId: id, updatedAt: 2_000, running: false, blank: false, ...fields } as SessionSummary
}

describe('selectRouterSessions', () => {
  it('selects on the durable header even when the list carries no projection at all', () => {
    // The real conversation: header says router, projection says `standard`, and the list row carries no preset.
    const rows = selectRouterSessions([header(MASTER, { agentPreset: ROUTER_PRESET, cwd: 'S:\\deepseek_harness' })],
      [summary(MASTER, { title: 'Router（常驻）' })], MASTER)
    expect(rows).toEqual([{ sessionId: MASTER, title: 'Router（常驻）', cwd: 'S:\\deepseek_harness',
      updatedAt: 2_000, running: false, agentAvailable: true }])
  })

  it('lists a member the host list omits, from its header alone', () => {
    const rows = selectRouterSessions([header(MASTER, { agentPreset: ROUTER_PRESET })], [], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER])
    expect(rows[0]!.updatedAt).toBe(1_000)
  })

  it('never admits a Session the router spawned, even under the router preset', () => {
    // The measured shape on this machine: the 常驻 conversation's own children are subagents that run `standard`.
    const subagent = '85b9a7d9-6d58-4dd1-b039-e6eea6f99470'
    const child = 'session-child'
    const rows = selectRouterSessions([
      header(MASTER, { agentPreset: ROUTER_PRESET }),
      header(subagent, { origin: 'subagent', parentSession: MASTER as SessionHeader['id'] }),
      header(child, { parentSession: MASTER as SessionHeader['id'] }),
      // A spawned Session that somehow also recorded the router preset is still a derivative, not a router conversation.
      header('session-routed-child', { agentPreset: ROUTER_PRESET, origin: 'subagent', parentSession: MASTER as SessionHeader['id'] }),
    ], [summary(MASTER, { title: 'Router（常驻）' }), summary(subagent), summary(child), summary('session-routed-child')], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER])
  })

  it('never admits a worker, whether the preset, the id prefix or the title says so', () => {
    // The person's rule: a worker is an ordinary conversation in the Workspace its ticket works in, and it is listed
    // there. The Router group is the router's own list, so none of these identities may pull a worker into it.
    const workerPreset = 'session-worker-preset'
    const workerNamed = 'worker-1a2b3c4d'
    const rows = selectRouterSessions([header(MASTER, { agentPreset: ROUTER_PRESET }),
      header(workerPreset, { agentPreset: WORKER_PRESET, cwd: 'S:\\work\\repo' }), header(workerNamed)],
      [summary(workerPreset, { title: 'worker-t-9f2c1a · 修一' }), summary(workerNamed)], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER])
  })

  it('leaves a worker out even when the title it projects is the worker title', () => {
    const titled = 'session-titled-worker'
    const rows = selectRouterSessions([header(titled, { cwd: 'S:\\work\\repo' })],
      [summary(titled, { title: 'worker-t-9f2c1a · 修一' })])
    expect(rows).toEqual([])
  })

  it('leaves this machine\'s running worker out, so it keeps the row in its own Workspace', () => {
    const rows = selectRouterSessions([header(MASTER, { agentPreset: ROUTER_PRESET }),
      header(DEMO_WORKER, { agentPreset: WORKER_PRESET, cwd: 'S:\\deepseek_harness' })],
      [summary(MASTER, { title: 'Router（常驻）' }),
        summary(DEMO_WORKER, { title: 'worker-3e750355 · 预览联调', running: true })], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER])
  })

  it('reports a router conversation\'s running state from the host list, so the group can show running or idle', () => {
    const busy = 'session-router-busy'
    const rows = selectRouterSessions([header(busy, { agentPreset: ROUTER_PRESET })],
      [summary(busy, { title: 'Router（副）', running: true })])
    expect(rows[0]).toMatchObject({ sessionId: busy, running: true, title: 'Router（副）' })
  })

  it('leaves every ordinary conversation and every other agent\'s Session out', () => {
    const plain = 'session-plain'
    const otherAgent = 'session-other-agent'
    const lookalike = 'session-workerish'
    const rows = selectRouterSessions([header(MASTER, { agentPreset: ROUTER_PRESET }),
      header(plain), header(otherAgent, { agentPreset: 'some-other-plugin-agent' }),
      // A title that merely mentions a worker is not one either: the prefix must lead.
      header(lookalike, { agentPreset: 'standard' })],
      [summary(MASTER), summary(plain, { title: 'Fix the parser' }), summary(otherAgent, { title: 'Other agent' }),
        summary(lookalike, { title: 'about worker-tools' })], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER])
  })

  it('never admits a subagent spawned by a worker, and not the worker that spawned it either', () => {
    const worker = 'worker-t-abc'
    const child = 'session-worker-child'
    const rows = selectRouterSessions([header(worker, { agentPreset: WORKER_PRESET }),
      header(child, { agentPreset: WORKER_PRESET, origin: 'subagent', parentSession: worker as SessionHeader['id'] })],
      [summary(worker, { title: 'worker-t-abc · 修三' }), summary(child)], worker)
    expect(rows).toEqual([])
  })

  it('lists the router conversations newest first, with the permanent one leading', () => {
    const olderRouter = 'session-router-older'
    const newerRouter = 'session-router-newer'
    const rows = selectRouterSessions([header(olderRouter, { agentPreset: ROUTER_PRESET }),
      header(MASTER, { agentPreset: ROUTER_PRESET }), header(newerRouter, { agentPreset: ROUTER_PRESET })],
      [summary(MASTER, { updatedAt: 1 }), summary(olderRouter, { updatedAt: 9_000 }), summary(newerRouter, { updatedAt: 8_000 })], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER, olderRouter, newerRouter])
  })

  it('lists the permanent conversation first even when a relative is newer', () => {
    const other = 'session-other'
    const rows = selectRouterSessions([header(other, { agentPreset: ROUTER_PRESET }),
      header(MASTER, { agentPreset: ROUTER_PRESET })], [summary(other, { updatedAt: 9_000 }), summary(MASTER, { updatedAt: 5 })], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER, other])
  })

  it('orders the remaining sessions newest first and keeps a deterministic tie-break', () => {
    const a = 'session-aaa', b = 'session-bbb'
    const rows = selectRouterSessions([header(a, { agentPreset: ROUTER_PRESET }), header(b, { agentPreset: ROUTER_PRESET })],
      [summary(a, { updatedAt: 7 }), summary(b, { updatedAt: 7 })], 'session-absent')
    expect(rows.map(row => row.sessionId)).toEqual([a, b])
  })

  it('selects nothing when no Session ran the router preset', () => {
    expect(selectRouterSessions([header('session-plain')], [summary('session-plain')])).toEqual([])
  })

  it('reads a title from either projection spelling before falling back to the untitled label', () => {
    const slated = 'session-projected'
    const rows = selectRouterSessions([header(slated, { agentPreset: ROUTER_PRESET })],
      [{ ...summary(slated), projections: { values: { title: 'Projected title' } } } as unknown as SessionSummary])
    expect(rows[0]!.title).toBe('Projected title')
    const untitled = selectRouterSessions([header('session-plain-router', { agentPreset: ROUTER_PRESET })], [])
    expect(untitled[0]!.title).toBeUndefined()
  })
})
