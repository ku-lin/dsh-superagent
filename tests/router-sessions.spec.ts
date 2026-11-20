/**
 * Router-level Session selection for the virtual Router workspace.
 *
 * The rows come from durable Session headers, never from the `agentPreset` projection: the shipped 常驻 conversation
 * projects `standard` while its header says `dsh-superagent-router`, so a projection-based filter would drop the one
 * conversation the group exists for. These cases pin the header rule, the lineage rule, and the worker exclusion.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import { ROUTER_PRESET, WORKER_PRESET, selectRouterSessions } from '../src/app/router-sessions.ts'

const MASTER = 'session-1b84c2b5-d08d-457b-8737-f8879efbfb05'

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

  it('never admits an Executor Session, preset or id prefix, even when the router seeded it', () => {
    const workerPreset = 'session-worker-preset'
    const workerNamed = 'worker-1a2b3c4d'
    const rows = selectRouterSessions([header(MASTER, { agentPreset: ROUTER_PRESET }),
      header(workerPreset, { agentPreset: WORKER_PRESET, parentSession: MASTER as SessionHeader['id'] }),
      header(workerNamed, { parentSession: MASTER as SessionHeader['id'] })], [], MASTER)
    expect(rows.map(row => row.sessionId)).toEqual([MASTER])
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
