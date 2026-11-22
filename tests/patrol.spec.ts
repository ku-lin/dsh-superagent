/**
 * The patrol's whole value is that it stays quiet, so the cases that matter most are the ones where it
 * must NOT speak: an unchanged set, a set that only shrank, and a problem already reported.
 *
 * The two upstream defects reproduced here as tests are `gone-only` (losses are not news) and the
 * single-question id (concatenating ids made answering one question look like fresh news about the
 * rest).
 */
import { describe, expect, it } from 'vitest'
import { findings, reportedMap, signatureOf, tick, type PatrolInput, type PatrolOptions } from '../src/core/patrol.ts'

const options: PatrolOptions = {
  stallMs: 15 * 60_000,
  longRunMs: 45 * 60_000,
  waitMs: 10 * 60_000,
  heavyStuckMs: 15 * 60_000,
}

const at = (minutes: number) => minutes * 60_000
const now = at(1000)

const empty: PatrolInput = { workers: [] }

const worker = (over: Partial<PatrolInput['workers'][number]> = {}) => ({
  session: 'worker-1',
  task: 'T-1',
  state: 'in_progress',
  lastReportMs: now - at(1),
  turnStartedMs: 0,
  running: false,
  ...over,
})

describe('findings', () => {
  it('says nothing about a worker that reported recently', () => {
    expect(findings({ workers: [worker()] }, options, now)).toEqual([])
  })

  it('reports a stall with the number of minutes, not a verdict', () => {
    const [finding] = findings({ workers: [worker({ lastReportMs: now - at(30) })] }, options, now)
    expect(finding?.key).toBe('stalled:worker-1:T-1')
    expect(finding?.text).toContain('30 min')
    expect(finding?.text).toContain('has not reported')
  })

  it('reports a long turn only while the worker is actually running', () => {
    const started = now - at(60)
    const running = findings({ workers: [worker({ turnStartedMs: started, running: true })] }, options, now)
    const idle = findings({ workers: [worker({ turnStartedMs: started, running: false })] }, options, now)
    expect(running.map(item => item.key)).toEqual([`long-run:worker-1:${started}`])
    expect(idle).toEqual([])
  })

  it('gives each open question its own key', () => {
    // Concatenating ids meant answering one question changed the key and re-announced the others.
    const list = findings(
      { ...empty, openQuestions: [{ id: '11', task: 'T-1', question: 'which db' }, { id: '12', task: 'T-1', question: 'which port' }] },
      options,
      now,
    )
    expect(list.map(item => item.key).sort()).toEqual(['ask:11', 'ask:12'])
  })

  it('mentions a queued heavy job only when it cannot run', () => {
    const job = { id: '7', label: 'render', session: 'worker-1', minFreeGb: 16, queuedAt: now - at(30) }
    const starving = findings({ ...empty, heavy: { freeGb: 4, jobs: [job] } }, options, now)
    const affordable = findings({ ...empty, heavy: { freeGb: 32, jobs: [job] } }, options, now)
    expect(starving.map(item => item.key)).toEqual(['heavy-stuck:7'])
    expect(affordable).toEqual([])
  })

  it('mentions a waiting approval only after the grace period', () => {
    const waiting = { session: 'worker-1', kind: 'approval' as const, label: 'deploy', since: now - at(5) }
    expect(findings({ ...empty, waiting: [waiting] }, options, now)).toEqual([])
    const overdue = { ...waiting, since: now - at(20) }
    expect(findings({ ...empty, waiting: [overdue] }, options, now)).toHaveLength(1)
  })
})

describe('signatureOf', () => {
  it('ignores order', () => {
    const a = [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }]
    const b = [{ key: 'b', text: 'B' }, { key: 'a', text: 'A' }]
    expect(signatureOf(a)).toBe(signatureOf(b))
  })

  it('changes when the set changes', () => {
    expect(signatureOf([{ key: 'a', text: '' }])).not.toBe(signatureOf([{ key: 'a', text: '' }, { key: 'b', text: '' }]))
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
    const second = tick(stalled, options, now, {
      signature: first.signature,
      reported: reportedMap(first.added),
    })
    expect(second.kind).toBe('quiet')
    expect(second.text).toBeUndefined()
  })

  it('stays quiet when only some findings disappear', () => {
    // `gone-only`: a cleared question is not news, and waking the model to say so costs a turn.
    const two: PatrolInput = {
      workers: [
        worker({ lastReportMs: now - at(30) }),
        { session: 'worker-2', task: 'T-2', state: 'in_progress', lastReportMs: now - at(40), turnStartedMs: 0, running: false },
      ],
    }
    const first = tick(two, options, now, {})
    const second = tick(stalled, options, now, {
      signature: first.signature,
      reported: reportedMap(first.added),
    })
    expect(second.kind).toBe('quiet')
    expect(second.gone).toHaveLength(1)
    expect(second.text).toBeUndefined()
  })

  it('reports cleared when the last finding goes away, without any text', () => {
    // A distinct outcome so a caller can log "the board went clean", but there is still nothing to say.
    const first = tick(stalled, options, now, {})
    const second = tick({ workers: [worker()] }, options, now, {
      signature: first.signature,
      reported: reportedMap(first.added),
    })
    expect(second.kind).toBe('cleared')
    expect(second.added).toEqual([])
    expect(second.text).toBeUndefined()
  })

  it('carries a new signature on every outcome so a silent tick can still be recorded', () => {
    // The defect this guards: not storing the signature on a quiet tick makes the next one re-report
    // the same removals forever.
    const first = tick(stalled, options, now, {})
    const quiet = tick(stalled, options, now, { signature: first.signature, reported: reportedMap(first.added) })
    const gone = tick({ workers: [worker()] }, options, now, { signature: first.signature, reported: reportedMap(first.added) })
    expect(quiet.signature).toBe(first.signature)
    expect(gone.signature).not.toBe(first.signature)
  })

  it('speaks again when a genuinely new problem appears, and lists the old one as still present', () => {
    const first = tick(stalled, options, now, {})
    const more: PatrolInput = {
      workers: [
        worker({ lastReportMs: now - at(30) }),
        { session: 'worker-2', task: 'T-2', state: 'in_progress', lastReportMs: now - at(40), turnStartedMs: 0, running: false },
      ],
    }
    const second = tick(more, options, now, { signature: first.signature, reported: reportedMap(first.added) })
    expect(second.kind).toBe('reported')
    expect(second.added.map(item => item.key)).toEqual(['stalled:worker-2:T-2'])
    expect(second.text).toContain('already reported, still present 1')
  })

  it('keeps a still-stuck job in the text without re-announcing it', () => {
    const job = { id: '7', label: 'render', session: 'worker-1', minFreeGb: 16, queuedAt: now - at(30) }
    const first = tick({ ...empty, heavy: { freeGb: 4, jobs: [job] } }, options, now, {})
    // Free memory wobbles but stays below the threshold: same problem, no new news.
    const second = tick({ ...empty, heavy: { freeGb: 8, jobs: [job] } }, options, now, {
      signature: first.signature,
      reported: reportedMap(first.added),
    })
    expect(second.kind).toBe('quiet')
  })
})
