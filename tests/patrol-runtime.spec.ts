/**
 * The patrol's production wiring, driven through the real `Patrol` class and — where it matters — the real
 * `Runtime` composition root: a real `Store` on a temporary SQLite file, the real effect queue and the real
 * `Sessions` notice handler that injects into the Router conversation.
 *
 * Nothing here reaches the network, port 3080, the operator's state directory or any credential: every case
 * builds its own directory under `tmpdir()` and removes it. The clock is faked, so a threshold is crossed by
 * advancing `Date` rather than by waiting.
 *
 * The two behaviours these tests exist to protect:
 *
 * - **Silence.** The same set, a set that only shrank, a worker waiting on a person, a stopped Router, and a
 *   restart all produce no message.
 * - **A queued report is not a delivered one.** The baseline moves only after the notice row has left the
 *   queue; a notice that fails is retried on the next tick rather than recorded as already sent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Patrol, PATROL_DEFAULTS, type PatrolHost } from '../src/app/patrol.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import type { Ticket } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const at = (minutes: number) => minutes * 60_000
const START = Date.parse('2026-09-09T00:00:00.000Z')

/** Advance the faked `Date`, so the patrol's thresholds see the new time without any real waiting. */
function clock(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'], now: START + ms })
}

/**
 * A patrol over an isolated store with the effect queue stubbed.
 *
 * `delivered` is the set of notice keys the stub considers *not* queued: an enqueued key is "still in the
 * queue" until the test says otherwise, which is exactly what a notice the Router conversation failed to
 * receive looks like to `Effects.pending`.
 */
function harness(directory: string) {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const queued = new Set<string>()
  const health = new HealthBoard().claim('patrol', { state: 'ready', detail: 'Nothing to report' })
  const sent: { kind: string; key: string; payload: unknown }[] = []
  let broken: Error | undefined
  const effects = {
    enqueue: (kind: string, key: string, payload: unknown) => {
      if (broken) throw broken
      sent.push({ kind, key, payload })
      queued.add(key)
    },
    pending: (_kind: string, key: string) => queued.has(key),
  }
  const host: PatrolHost = { store, effects: effects as never, health, stopped: () => false, closing: () => false }
  const patrol = new Patrol(host, PATROL_DEFAULTS)
  return { store, patrol, host, sent, queued, health,
    /** The queue injected the notice, so the row is gone. */
    deliver: () => queued.clear(),
    failEnqueues: (error?: Error) => { broken = error },
  }
}

/** A ticket with one running assignment, as the Engine writes one. */
function running(event = '2026-09-09T00:00:00.000Z', over: Partial<Ticket> = {}): Ticket {
  return { id: 'ticket-1', title: 'Fix the margin', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
    createdAt: event, updatedAt: event, origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    assignments: [{ id: 'a1', state: 'running', createdAt: event, startedAt: event }], ...over }
}

let cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const run of cleanup.reverse()) await run()
  cleanup = []
  vi.useRealTimers()
})

describe('Patrol over a real store', () => {
  const open = () => {
    const directory = mkdtempSync(join(tmpdir(), 'patrol-wiring-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    return directory
  }

  it('speaks once about a stalled worker, then stays quiet on the same set', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    h.store.tickets.save(running(new Date(START).toISOString()))

    clock(at(30))
    await h.patrol.run()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.kind).toBe('notice')
    const payload = h.sent[0]?.payload as { value: { patrol: { text: string; items: number } }; summary: string }
    expect(payload.value.patrol.items).toBe(1)
    expect(payload.value.patrol.text).toContain('has not reported for 30 min')
    expect(payload.summary).toBe('patrol found 1 item(s)')
    // Queued but not delivered: the baseline must not have moved yet.
    expect(h.store.get(KV.runtime.patrol)?.pending).toBeDefined()

    h.deliver()
    clock(at(31))
    await h.patrol.run()
    // The delivery is confirmed and the baseline adopted; the same finding is not news.
    expect(h.store.get(KV.runtime.patrol)?.pending).toBeUndefined()
    expect(h.sent).toHaveLength(1)
    expect(h.health.get()).toMatchObject({ state: 'ready', detail: '1 finding(s), nothing new' })
  })

  it('neither reports nor loses anything when the queue is still holding the report', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    h.store.tickets.save(running(new Date(START).toISOString()))
    clock(at(30))
    await h.patrol.run()
    const first = h.store.get(KV.runtime.patrol)
    expect(first?.pending).toBeDefined()

    // Next tick while the row is still queued: no second enqueue (which would reset the queue's backoff) and
    // the baseline still has not moved.
    clock(at(31))
    await h.patrol.run()
    expect(h.sent).toHaveLength(1)
    expect(h.store.get(KV.runtime.patrol)).toEqual(first)
    expect(h.health.get()).toMatchObject({ detail: expect.stringContaining('still queued') })
  })

  it('leaves the baseline untouched when enqueueing the report throws, and re-reports next tick', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    h.store.tickets.save(running(new Date(START).toISOString()))
    clock(at(30))
    h.failEnqueues(new Error('database is locked'))
    await h.patrol.run()
    // Nothing was queued and nothing was recorded: the transaction rolled back, so a restart sees a report it
    // still owes rather than one it believes it made.
    expect(h.store.get(KV.runtime.patrol)).toBeUndefined()
    expect(h.health.get()).toMatchObject({ state: 'error', detail: expect.stringContaining('database is locked') })

    h.failEnqueues()
    clock(at(32))
    await h.patrol.run()
    expect(h.sent).toHaveLength(1)
    expect((h.sent[0]?.payload as { value: { patrol: { items: number } } }).value.patrol.items).toBe(1)
  })

  it('says nothing on a restart that re-derives the same set', async () => {
    const directory = open()
    const first = harness(directory)
    first.store.tickets.save(running(new Date(START).toISOString()))
    clock(at(30))
    await first.patrol.run()
    first.deliver()
    clock(at(31))
    await first.patrol.run()
    const stored = first.store.get(KV.runtime.patrol)
    first.store.close()

    // A new process: a fresh Store handle on the same file, which is what a restart of the plugin does, and a
    // fresh Patrol with no memory of its own.
    const second = harness(directory)
    cleanup.push(() => second.store.close())
    expect(second.store.get(KV.runtime.patrol)).toEqual(stored)
    clock(at(32))
    await second.patrol.run()
    expect(second.sent).toEqual([])
    expect(second.health.get()).toMatchObject({ detail: '1 finding(s), nothing new' })
  })

  it('reports a new problem without re-announcing the one already reported, and stays quiet when only it clears', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    h.store.tickets.save(running(new Date(START).toISOString()))
    clock(at(30))
    await h.patrol.run()
    h.deliver()

    // A second ticket appears, already stale.
    h.store.tickets.save(running(new Date(START).toISOString(), { id: 'ticket-2', title: 'Rewrite the docs' }))
    clock(at(31))
    await h.patrol.run()
    expect(h.sent).toHaveLength(2)
    const second = (h.sent[1]?.payload as { value: { patrol: { text: string; items: number } } }).value.patrol
    expect(second.items).toBe(2)
    expect(second.text).toContain('new 1:')
    expect(second.text).toContain('already reported, still present 1')
    h.deliver()

    // Both tickets end: the set only shrank, which is not news.
    for (const id of ['ticket-1', 'ticket-2']) h.store.tickets.save({ ...h.store.tickets.get(id)!, ended: { at: new Date(START + at(32)).toISOString(), by: 'executor', outcome: 'completed' } })
    clock(at(32))
    await h.patrol.run()
    expect(h.sent).toHaveLength(2)
    expect(h.store.get(KV.runtime.patrol)?.pending).toBeUndefined()
    expect(h.health.get()).toMatchObject({ detail: 'Nothing to report' })
  })

  it('does not call a worker stalled while it waits on a person, but does mention the question', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    // A blocked report and the attention question the same report raised: one row, two facts.
    h.store.tickets.save(running(new Date(START).toISOString(), {
      attention: { id: 'att-1', question: 'which database should this use?' },
      assignments: [{ id: 'a1', state: 'running', createdAt: new Date(START).toISOString(), startedAt: new Date(START).toISOString(),
        report: { state: 'blocked', summary: 'need a decision', at: new Date(START).toISOString() } }],
    }))
    clock(at(30))
    await h.patrol.run()
    const text = (h.sent[0]?.payload as { value: { patrol: { text: string; items: number } } }).value.patrol
    // The stall would say the same thing the question already says, and a blocked worker is quiet on purpose.
    expect(text.text).not.toContain('has not reported')
    expect(text.items).toBe(1)
    expect(text.text).toContain('only a person can give')
    expect(text.text).toContain('which database should this use?')
  })

  it('reads stuck replies out of the real outbox and effect rows, and only after the failure threshold', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    const message = { id: 'msg-1', kind: 'notice' as const, text: 'hello', channel: { source: 'feishu', thread: 'feishu:oc_1', address: {} } }
    h.store.receipts.add(message)
    const effect = (attempts: number) => h.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, attempts, error, due, since)
      VALUES ('reply', 'msg-1', '{}', 1, ?, ?, 0, '2026-09-09T00:00:00.000Z')`).run(attempts, 'internal error (2200)')

    effect(1)
    clock(at(1))
    await h.patrol.run()
    // One retry is the queue working, not a problem.
    expect(h.sent).toEqual([])

    h.store.db.prepare("UPDATE effect SET attempts = 3 WHERE key = 'msg-1'").run()
    clock(at(2))
    await h.patrol.run()
    const text = (h.sent[0]?.payload as { value: { patrol: { text: string } } }).value.patrol
    expect(text.text).toContain('a message to feishu:oc_1 has failed 3 times')
    expect(text.text).toContain('internal error (2200)')
  })

  it('sends nothing while the Router is stopped, and does not move the baseline either', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    h.store.tickets.save(running(new Date(START).toISOString()))
    const stopped = { value: false }
    const patrol = new Patrol({ ...h.host, stopped: () => stopped.value }, PATROL_DEFAULTS)
    stopped.value = true
    clock(at(30))
    await patrol.run()
    expect(h.sent).toEqual([])
    expect(h.store.get(KV.runtime.patrol)).toBeUndefined()
    expect(h.health.get()).toMatchObject({ detail: expect.stringContaining('Router is stopped') })

    // A start releases it: the same set is now the cold-start set and is reported once.
    stopped.value = false
    clock(at(31))
    await patrol.run()
    expect(h.sent).toHaveLength(1)
  })

  it('clears its one timer on dispose and does not re-arm afterwards', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    h.store.tickets.save(running(new Date(START).toISOString()))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START })
    const patrol = new Patrol({ ...h.host, now: () => Date.now() }, PATROL_DEFAULTS)
    patrol.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await patrol.dispose()
    expect(vi.getTimerCount()).toBe(0)
    // A tick asked for after dispose does nothing at all: no timer, no write.
    const before = h.store.get(KV.runtime.patrol)
    patrol.request()
    await vi.advanceTimersByTimeAsync(at(120))
    expect(h.store.get(KV.runtime.patrol)).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fires on its own clock at the next threshold instead of polling', async () => {
    const directory = open()
    const h = harness(directory)
    cleanup.push(() => h.store.close())
    h.store.tickets.save(running(new Date(START).toISOString()))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START })
    const patrol = new Patrol({ ...h.host, now: () => Date.now() }, PATROL_DEFAULTS)
    patrol.start()
    await vi.advanceTimersByTimeAsync(0)
    // Reporting nothing yet: 10 minutes of quiet would be far too many scans if this were a poll.
    expect(h.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(at(19))
    expect(h.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(at(2))
    expect(h.sent).toHaveLength(1)
    await patrol.dispose()
  })
})

describe('Runtime wiring', () => {
  it('reports a stalled worker through the real effect queue and the real notice injection, and says nothing twice', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: START })
    let host: Host | undefined
    try {
      host = await startRuntime()
      const h = host
      cleanup.push(async () => { await h.stop() })
      const { trigger, ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
      const master = h.agents.get(h.runtime.masterId)!
      master.inject.mockClear()

      // Advanced as the host would: the ticket's own timestamps are what the patrol reads, so age them.
      const aged = { ...h.runtime.store.tickets.get(ticket.id)!, updatedAt: new Date(START).toISOString(),
        assignments: h.runtime.store.tickets.get(ticket.id)!.assignments.map(item => ({ ...item, startedAt: new Date(START).toISOString() })) }
      h.runtime.store.tickets.save(aged)
      clock(at(30))
      await h.runtime.patrol.run()
      await h.runtime.idle()
      expect(h.runtime.health.patrol).toMatchObject({ state: 'ready', detail: '1 finding(s), reported now' })
      // The notice was injected into the Router conversation, not steered into it: a patrol report must never
      // start a model turn of its own.
      const injected = master.inject.mock.calls.map(([message]) => JSON.stringify(message))
      expect(injected.some(text => text.includes('patrol'))).toBe(true)
      expect(master.steer).not.toHaveBeenCalledWith(expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('patrol') })]) }))
      expect(h.runtime.store.receipts.waiting().some(item => item.text.includes('patrol'))).toBe(false)
      expect(h.runtime.store.get(KV.runtime.patrol)?.signature).toMatch(/^[0-9a-f]{40}$/)

      // Same set, a minute later: no second injection and no second queue row.
      master.inject.mockClear()
      clock(at(31))
      await h.runtime.patrol.run()
      await h.runtime.idle()
      expect(master.inject).not.toHaveBeenCalled()
      expect(h.runtime.health.patrol).toMatchObject({ detail: '1 finding(s), nothing new' })
      expect(trigger.id).toBeTruthy()
    } finally {
      if (host) await host.stop().catch(() => {})
    }
  })

  it('holds its report while the Router is stopped, and reports once when it is started again', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: START })
    let host: Host | undefined
    try {
      host = await startRuntime()
      const h = host
      cleanup.push(async () => { await h.stop() })
      const { ticket } = await h.acceptedTicket(feishu('2', '@bot 修一下回归'))
      h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, updatedAt: new Date(START).toISOString(),
        assignments: h.runtime.store.tickets.get(ticket.id)!.assignments.map(item => ({ ...item, startedAt: new Date(START).toISOString() })) })
      h.runtime.control.stopRouter('maintenance', 'panel')
      const master = h.agents.get(h.runtime.masterId)!
      master.inject.mockClear()

      clock(at(30))
      await h.runtime.patrol.run()
      await h.runtime.idle()
      expect(master.inject).not.toHaveBeenCalled()
      expect(h.runtime.health.patrol).toMatchObject({ detail: expect.stringContaining('Router is stopped') })
      // Nothing was queued, so nothing is owed: the set will be derived again after the start.
      expect(h.runtime.store.get(KV.runtime.patrol)?.pending).toBeUndefined()

      h.runtime.control.startRouter('panel')
      clock(at(31))
      await h.runtime.patrol.run()
      await h.runtime.idle()
      expect(master.inject.mock.calls.map(([message]) => JSON.stringify(message)).some(text => text.includes('patrol'))).toBe(true)
    } finally {
      if (host) await host.stop().catch(() => {})
    }
  })

  it('does not wake the Router for what is already reported on its next tick, so a restart of the plugin is silent', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: START })
    let host: Host | undefined
    try {
      host = await startRuntime()
      const h = host
      cleanup.push(async () => { await h.stop() })
      const { ticket } = await h.acceptedTicket(feishu('3', '@bot 修一下回归'))
      h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, updatedAt: new Date(START).toISOString(),
        assignments: h.runtime.store.tickets.get(ticket.id)!.assignments.map(item => ({ ...item, startedAt: new Date(START).toISOString() })) })
      clock(at(30))
      await h.runtime.patrol.run()
      await h.runtime.idle()
      // The first tick queued the report; the next one confirms the injection and adopts the baseline.
      clock(at(31))
      await h.runtime.patrol.run()
      await h.runtime.idle()
      const baseline = h.runtime.store.get(KV.runtime.patrol)
      expect(baseline?.pending).toBeUndefined()
      expect(baseline?.signature).toMatch(/^[0-9a-f]{40}$/)

      // A fresh Patrol over the same database is what a restart builds: it must derive the same set and find
      // nothing new. (Driven directly so the case does not depend on tearing the whole host down.)
      const fresh = new Patrol({ store: h.runtime.store, effects: h.runtime.effects, health: new HealthBoard().claim('patrol'),
        stopped: () => false, closing: () => false }, PATROL_DEFAULTS)
      const inject = h.agents.get(h.runtime.masterId)!.inject
      inject.mockClear()
      clock(at(32))
      await fresh.run()
      await h.runtime.idle()
      expect(inject).not.toHaveBeenCalled()
      expect(fresh.snapshot(START + at(32)).workers).toHaveLength(1)
    } finally {
      if (host) await host.stop().catch(() => {})
    }
  })
})
