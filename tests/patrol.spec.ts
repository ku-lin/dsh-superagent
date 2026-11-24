/**
 * The patrol's whole value is that it stays quiet, so the cases that matter most are the ones where it
 * must NOT speak: an unchanged set, a set that only shrank, a worker that is waiting on a person rather
 * than stalled, and a problem already reported.
 *
 * The two upstream defects reproduced here as tests are `gone-only` (losses are not news) and the
 * single-question id (concatenating ids made answering one question look like fresh news about the rest).
 */
import { describe, expect, it } from 'vitest'
import { findings, nextDue, reportedMap, signatureOf, tick, type PatrolInput, type PatrolOptions, type WorkerSnapshot } from '../src/core/patrol.ts'

const options: PatrolOptions = { stallMs: 20 * 60_000, longRunMs: 60 * 60_000, waitMs: 15 * 60_000 }

const at = (minutes: number) => minutes * 60_000
const now = at(1000)

const empty: PatrolInput = { workers: [] }

const worker = (over: Partial<WorkerSnapshot> = {}): WorkerSnapshot => ({
  session: 'worker-ticket-1',
  task: 'ticket-1',
  title: 'Fix the margin',
  state: 'progress',
  lastReportMs: now - at(1),
  runningSinceMs: 0,
  expectsReports: true,
  ...over,
})

describe('findings', () => {
  it('says nothing about a worker that reported recently', () => {
    expect(findings({ workers: [worker()] }, options, now)).toEqual([])
  })

  it('reports a stall with the number of minutes and its last word, not a verdict', () => {
    const [finding] = findings({ workers: [worker({ lastReportMs: now - at(30), state: 'progress' })] }, options, now)
    expect(finding?.key).toBe('stalled:ticket-1')
    expect(finding?.text).toContain('30 min')
    expect(finding?.text).toContain('has not reported')
    expect(finding?.text).toContain('its last word was progress')
    expect(finding?.text).not.toMatch(/stuck|broken|failed to/i)
  })

  it('does not call a worker stalled while it is waiting on a person or a source', () => {
    // A `blocked` worker is quiet on purpose. Reporting that as a stall would say the same thing twice — once
    // as a stall and once as the question it is actually waiting on.
    const blocked = findings({ workers: [worker({ lastReportMs: now - at(90), state: 'blocked', expectsReports: false })] }, options, now)
    expect(blocked).toEqual([])
  })

  it('reports a long run only while the assignment is actually running', () => {
    const started = now - at(90)
    const running = findings({ workers: [worker({ runningSinceMs: started, state: 'progress' })] }, options, now)
    const idle = findings({ workers: [worker({ runningSinceMs: 0, state: 'blocked', expectsReports: false })] }, options, now)
    expect(running.map(item => item.key)).toEqual([`long-run:ticket-1:${started}`])
    expect(idle).toEqual([])
  })

  it('keeps one key for a worker that stalls twice, and a new key for a relaunched assignment', () => {
    // The ticket is the key, not the assignment: recovering and stalling again is the same problem in the
    // same place. A relaunched assignment is a different run, which the Router has not been told about.
    const first = findings({ workers: [worker({ lastReportMs: now - at(30) })] }, options, now)
    const again = findings({ workers: [worker({ lastReportMs: now - at(35) })] }, options, now)
    expect(first.map(item => item.key)).toEqual(again.map(item => item.key))
    const old = findings({ workers: [worker({ runningSinceMs: now - at(120) })] }, options, now)
    const relaunched = findings({ workers: [worker({ runningSinceMs: now - at(90) })] }, options, now)
    expect(old.map(item => item.key)).toEqual([`long-run:ticket-1:${now - at(120)}`])
    expect(relaunched.map(item => item.key)).toEqual([`long-run:ticket-1:${now - at(90)}`])
  })

  it('gives each open question its own key, and no key before the grace period', () => {
    // Concatenating ids meant answering one question changed the key and re-announced the others.
    const fresh = findings({ ...empty, waiting: [{ ticket: 't1', id: 'a1', question: 'which db', since: now - at(5) }] }, options, now)
    expect(fresh).toEqual([])
    const overdue = findings({ ...empty, waiting: [
      { ticket: 't1', id: 'a1', question: 'which db', since: now - at(20) },
      { ticket: 't1', id: 'a2', question: 'which port', since: now - at(20) },
    ] }, options, now)
    expect(overdue.map(item => item.key).sort()).toEqual(['ask:t1:a1', 'ask:t1:a2'])
    expect(overdue[0]?.text).toContain('only a person can give')
  })

  it('keys a failed delivery by its ticket, so a retry that fails again is not fresh news', () => {
    const first = findings({ ...empty, failedDeliveries: [{ ticket: 't1', error: 'session busy', at: now - at(2) }] }, options, now)
    const later = findings({ ...empty, failedDeliveries: [{ ticket: 't1', error: 'session busy again', at: now - at(1) }] }, options, now)
    expect(first.map(item => item.key)).toEqual(['delivery-failed:t1'])
    expect(later.map(item => item.key)).toEqual(first.map(item => item.key))
    expect(first[0]?.text).toContain('could not be handed to its worker')
  })

  it('names a stuck reply by receipt and truncates a long error', () => {
    const long = 'x'.repeat(400)
    const [finding] = findings({ ...empty, stuckReplies: [{ key: 'msg-1', to: 'feishu:oc_1', error: long, attempts: 3 }] }, options, now)
    expect(finding?.key).toBe('reply-stuck:msg-1')
    expect(finding?.text).toContain('failed 3 times')
    expect(finding?.text).toContain('…')
    expect((finding?.text ?? '').length).toBeLessThan(300)
  })
})

describe('nextDue', () => {
  it('names the instant a quiet observation becomes a finding, and nothing once it is one', () => {
    const quiet = worker({ lastReportMs: now - at(10), runningSinceMs: now - at(30) })
    // Stall at +10 min from now, long run at +30 min from now: the stall comes first.
    expect(nextDue({ workers: [quiet] }, options, now)).toBe(now + at(10) + 1)
    // Both already past: nothing left to cross, because only a store change can un-cross them.
    expect(nextDue({ workers: [worker({ lastReportMs: now - at(30), runningSinceMs: now - at(90) })] }, options, now)).toBeUndefined()
  })

  it('counts a question\'s grace period and ignores conditions that are already true', () => {
    expect(nextDue({ ...empty, waiting: [{ ticket: 't1', id: 'a', question: 'q', since: now - at(5) }] }, options, now)).toBe(now + at(10) + 1)
    expect(nextDue({ ...empty, failedDeliveries: [{ ticket: 't1', error: 'e', at: now }] }, options, now)).toBeUndefined()
  })

  it('is always strictly in the future, so a timer armed on it cannot spin', () => {
    // Exactly on the boundary: `findings` uses a strict `>`, so this is still quiet — but a delay of 0 would
    // fire immediately and re-arm for the same instant for ever.
    const boundary = worker({ lastReportMs: now - options.stallMs })
    expect(nextDue({ workers: [boundary] }, options, now)).toBe(now + 1)
  })
})

describe('signatureOf', () => {
  it('ignores order', () => {
    expect(signatureOf([{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }])).toBe(signatureOf([{ key: 'b', text: 'B' }, { key: 'a', text: 'A' }]))
  })

  it('changes when the set changes', () => {
    expect(signatureOf([{ key: 'a', text: '' }])).not.toBe(signatureOf([{ key: 'a', text: '' }, { key: 'b', text: '' }]))
  })

  it('does not change when only the text of an existing key moves', () => {
    // The minutes counter moves between ticks; that is not a new problem, and a signature over the text
    // would make every tick speak.
    expect(signatureOf([{ key: 'a', text: '30 min' }])).toBe(signatureOf([{ key: 'a', text: '40 min' }]))
  })
})

describe('tick', () => {
  const stalled: PatrolInput = { workers: [worker({ lastReportMs: now - at(30) })] }

  it('speaks on a cold start because nobody has been told yet', () => {
    const result = tick(stalled, options, now, {})
    expect(result.kind).toBe('reported')
    expect(result.added).toHaveLength(1)
    expect(result.text).toContain('patrol found 1')
  })

  it('stays quiet when the set is unchanged', () => {
    const first = tick(stalled, options, now, {})
    const second = tick(stalled, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    expect(second.kind).toBe('quiet')
    expect(second.text).toBeUndefined()
    expect(second.current).toHaveLength(1)
  })

  it('stays quiet when only some findings disappear', () => {
    // `gone-only`: a cleared question is not news, and waking the model to say so costs a turn.
    const two: PatrolInput = { workers: [
      worker({ lastReportMs: now - at(30) }),
      worker({ task: 'ticket-2', session: 'worker-ticket-2', title: 'Other', lastReportMs: now - at(40) }),
    ] }
    const first = tick(two, options, now, {})
    const second = tick(stalled, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    expect(second.kind).toBe('quiet')
    expect(second.gone).toHaveLength(1)
    expect(second.text).toBeUndefined()
  })

  it('reports cleared when the last finding goes away, without any text', () => {
    const first = tick(stalled, options, now, {})
    const second = tick({ workers: [worker()] }, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    expect(second.kind).toBe('cleared')
    expect(second.added).toEqual([])
    expect(second.text).toBeUndefined()
  })

  it('carries a new signature on every outcome so a silent tick can still be recorded', () => {
    // The defect this guards: not storing the signature on a quiet tick makes the next one re-report the same
    // removals for ever, and keeps a problem that disappeared inside the map so its return is silent.
    const first = tick(stalled, options, now, {})
    const quiet = tick(stalled, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    const gone = tick({ workers: [worker()] }, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    expect(quiet.signature).toBe(first.signature)
    expect(gone.signature).not.toBe(first.signature)
  })

  it('speaks again when a genuinely new problem appears, and lists the old one as still present', () => {
    const first = tick(stalled, options, now, {})
    const more: PatrolInput = { workers: [
      worker({ lastReportMs: now - at(30) }),
      worker({ task: 'ticket-2', session: 'worker-ticket-2', title: 'Other', lastReportMs: now - at(40) }),
    ] }
    const second = tick(more, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    expect(second.kind).toBe('reported')
    expect(second.added.map(item => item.key)).toEqual(['stalled:ticket-2'])
    expect(second.text).toContain('already reported, still present 1')
  })

  it('carries the whole current set, so the stored map cannot lose the findings that are still there', () => {
    // The production wiring stores `reportedMap(result.current)`. Recomputing it from `added` would keep only
    // the new finding, and the still-present one would be announced again on the next tick.
    const first = tick(stalled, options, now, {})
    const more: PatrolInput = { workers: [
      worker({ lastReportMs: now - at(30) }),
      worker({ task: 'ticket-2', session: 'worker-ticket-2', title: 'Other', lastReportMs: now - at(40) }),
    ] }
    const second = tick(more, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    expect(Object.keys(reportedMap(second.current)).sort()).toEqual(['stalled:ticket-1', 'stalled:ticket-2'])
    const third = tick(more, options, now, { signature: second.signature, reported: reportedMap(second.current) })
    expect(third.kind).toBe('quiet')
  })

  it('re-announces a problem that cleared and came back', () => {
    // The signature was stored on the quiet tick, so the map is empty and its return is a genuine addition:
    // a worker that was healthy and is now stale is news again.
    const first = tick(stalled, options, now, {})
    const cleared = tick({ workers: [worker()] }, options, now, { signature: first.signature, reported: reportedMap(first.current) })
    const back = tick(stalled, options, now + at(1), { signature: cleared.signature, reported: reportedMap(cleared.current) })
    expect(back.kind).toBe('reported')
    expect(back.added.map(item => item.key)).toEqual(['stalled:ticket-1'])
  })
})
