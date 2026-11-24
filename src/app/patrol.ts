/**
 * The patrol's production wiring: read the facts this plugin actually stores, decide once, and speak
 * only when the set changed.
 *
 * Four things are deliberate here.
 *
 * **No polling of its own.** The host's `Passes` tick every two seconds to drive the effect queue, and
 * hanging this scan off that would read every open ticket 30 times a minute for nothing. Instead one
 * timer is armed for the instant the *next* threshold is crossed (see `nextDue`), so a quiet system
 * wakes only when a number it is watching can change. `request()` covers what a clock cannot predict: a
 * ticket was accepted, a report arrived, the Router was started again.
 *
 * **It speaks without waking the model.** The message is the existing durable `notice` effect, injected
 * into the Router conversation's history. It is visible in the panel and read on the Router's next
 * turn, and costs nothing until then — which is the whole point of a silent patrol.
 *
 * **A failed notice is not a reported one.** The baseline signature moves only after that queue row has
 * left the queue, which the effect queue does only on a successful injection. While the row is there the
 * baseline stays put, so a notice that failed is re-sent after a restart instead of being recorded as
 * delivered. The row's own retry backoff is left alone: re-enqueueing it every tick would reset the
 * attempt count and hammer a target that is refusing.
 *
 * **Restarts are quiet.** Signature and per-key map live in the store, so a process that comes back up
 * re-derives the same set, finds nothing new, and says nothing.
 * @module dsh-superagent/src/app/patrol
 */
import { nextDue, reportedMap, tick, type DeliverySnapshot, type PatrolInput, type PatrolOptions, type ReplySnapshot, type WaitingSnapshot,
  type WorkerSnapshot } from '../core/index.ts'
import { FAILURES_BEFORE_ERROR, type Effects } from './effects.ts'
import { executionSessionId } from '../executor/dsh.ts'
import { KV } from '../kv.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Store } from './store.ts'

/** What the patrol remembers between ticks. Durable, so a restart re-derives the same set and stays quiet. */
export interface PatrolState {
  /** Hash of the finding keys the Router was last told about. */
  readonly signature: string
  /** The text it saw, per key, so a finding that is still present is not announced twice. */
  readonly reported: Record<string, string>
  /**
   * A report queued but not yet delivered. While it is here the baseline has not moved: a notice that
   * fails, or that a restart drops before delivery, is sent again.
   */
  readonly pending?: { readonly signature: string; readonly reported: Record<string, string>; readonly notice: string }
  /** ISO time of the last tick that spoke. */
  readonly at?: string
}

/** How long to wait before looking again while the Router is stopped; nothing else would wake this process. */
const STOPPED_RECHECK_MS = 5 * 60_000
/** How long to wait for a queued report to be injected before checking again. The queue retries on its own. */
const PENDING_RECHECK_MS = 60_000
/**
 * The longest gap between two ticks, whether or not a threshold is due.
 *
 * Some findings are true the instant they exist (a failed Input delivery, a reply the queue gave up on)
 * and have no threshold to cross, so `nextDue` returns nothing for them. Without a floor the patrol would
 * report one such problem and then sleep for ever, and never notice the next one. A tick is a handful of
 * SQLite reads and no model call, so one every few minutes costs nothing measurable.
 */
const FLOOR_RECHECK_MS = 10 * 60_000
/** The largest delay `setTimeout` accepts; a longer one fires immediately, which would spin. */
const MAX_DELAY_MS = 2 ** 31 - 1

/** The thresholds a deployment uses unless a host narrows them. */
export const PATROL_DEFAULTS: PatrolOptions = { stallMs: 20 * 60_000, longRunMs: 60 * 60_000, waitMs: 15 * 60_000 }

export interface PatrolHost {
  readonly store: Store
  readonly effects: Pick<Effects, 'enqueue' | 'pending'>
  readonly health: HealthEntry
  /** Whether the operator stopped the Router; a stopped Router is not told anything. */
  stopped(): boolean
  /** Whether the plugin is shutting down. */
  closing(): boolean
  /** Epoch ms; a test passes a fake clock so a threshold can be crossed without waiting. */
  now?: () => number
}

/** Report states that wait on someone else, so a worker in one of them is not "stalled" — it is waiting. */
const WAITING = new Set(['waiting', 'ready', 'blocked', 'failed', 'dropped'])

/**
 * The patrol itself: one timer armed for the next threshold, one snapshot read from the store, one
 * decision, and the durable notice that carries it.
 */
export class Patrol {
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private running?: Promise<void>
  /** A tick asked for while one was in flight; one follow-up tick, not a queue of them. */
  private again = false
  private readonly now: () => number
  constructor(private readonly host: PatrolHost, private readonly options: PatrolOptions = PATROL_DEFAULTS) {
    // Read the clock through `Date.now` on every call rather than capturing the function: a captured
    // reference keeps the real clock even under a faked one, which would make every threshold test lie.
    this.now = host.now ?? (() => Date.now())
  }

  /** Arm the first timer. The Runtime calls this once the effect queue and the Router conversation exist. */
  start(): void { if (!this.disposed) this.request() }

  /** Tick as soon as possible, because something the clock cannot predict changed. */
  request(): void {
    if (this.disposed) return
    if (this.running) { this.again = true; return }
    const run = this.running = this.run()
    void run.finally(() => {
      this.running = undefined
      if (this.again) { this.again = false; this.request() }
    })
  }

  /** Stop the timer and wait for a tick in flight, so a shutdown closes the database under nobody. */
  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.again = false
    await this.running?.catch(() => { /* a tick that threw recorded itself in health. */ })
  }

  /** One tick. Exposed so a test can drive it on a fake clock rather than waiting for the timer. */
  async run(): Promise<void> {
    if (this.disposed || this.host.closing()) return
    clearTimeout(this.timer)
    this.timer = undefined
    try { await this.tickOnce() } catch (error) {
      this.host.health.set({ state: 'error', detail: `The patrol failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
      // A failed tick is worth retrying, but not in a tight loop: a broken store would spin.
      this.arm(this.now() + PENDING_RECHECK_MS)
    }
  }

  private async tickOnce(): Promise<void> {
    const { store, effects, health } = this.host
    const now = this.now()
    let prior = this.state()

    // A report queued last time is confirmed by its row leaving the queue: the effect queue deletes a row
    // only after its handler returned, so absence means the notice reached the Router conversation.
    if (prior.pending) {
      if (effects.pending('notice', prior.pending.notice)) {
        // Still queued. Leave the baseline and the row alone — the queue is retrying it on its own
        // backoff — and look again later.
        health.set({ state: 'ready', detail: 'A patrol report is still queued for delivery', at: new Date(now).toISOString() })
        this.arm(now + PENDING_RECHECK_MS)
        return
      }
      prior = { signature: prior.pending.signature, reported: prior.pending.reported, ...prior.at ? { at: prior.at } : {} }
      store.set(KV.runtime.patrol, prior)
    }

    // A stopped Router is not reading anything, and a notice is a delivery it has asked to hold. Come back
    // later; a start also calls `request()`, so this delay is only a backstop.
    if (this.host.stopped()) {
      health.set({ state: 'ready', detail: 'The Router is stopped; the patrol is holding its report', at: new Date(now).toISOString() })
      this.arm(now + STOPPED_RECHECK_MS)
      return
    }

    const input = this.snapshot(now)
    const result = tick(input, this.options, now, { signature: prior.signature, reported: prior.reported })

    if (result.kind === 'reported' && result.text) {
      const notice = `patrol:${result.signature}`
      const at = new Date(now).toISOString()
      // Queued and recorded in one transaction: a crash between the two must not leave the baseline saying
      // "already told them" about a message that was never queued.
      store.atomic(() => {
        store.set(KV.runtime.patrol, { signature: prior.signature, reported: prior.reported,
          pending: { signature: result.signature, reported: reportedMap(result.current), notice }, at } satisfies PatrolState)
        effects.enqueue('notice', notice, { value: { patrol: { signature: result.signature, text: result.text, items: result.current.length } },
          summary: `patrol found ${result.current.length} item(s)` })
      })
      health.set({ state: 'ready', detail: `${result.current.length} finding(s), reported now`, at })
    } else {
      // Every outcome stores the signature, including `quiet` and `cleared`: a tick that only lost findings
      // still moved the set, and keeping the old hash would report the same removals forever.
      store.set(KV.runtime.patrol, { signature: result.signature, reported: reportedMap(result.current),
        ...prior.at ? { at: prior.at } : {} } satisfies PatrolState)
      health.set({ state: 'ready', detail: result.current.length ? `${result.current.length} finding(s), nothing new` : 'Nothing to report', at: new Date(now).toISOString() })
    }

    this.arm(Math.min(nextDue(input, this.options, now) ?? Number.POSITIVE_INFINITY, now + FLOOR_RECHECK_MS))
  }

  private arm(at: number | undefined): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || at === undefined) return
    const delay = Math.min(Math.max(0, at - this.now()), MAX_DELAY_MS)
    this.timer = setTimeout(() => { this.request() }, delay)
    // A timer must not be the only thing keeping the process alive; the host's own work does that.
    this.timer.unref?.()
  }

  private state(): PatrolState {
    return this.host.store.get(KV.runtime.patrol) ?? { signature: '', reported: {} }
  }

  /** What the store says right now, in the patrol's terms. A pure read: nothing is written. */
  snapshot(now: number): PatrolInput {
    const { store } = this.host
    const at = (iso: string | undefined): number => {
      if (!iso) return 0
      const value = Date.parse(iso)
      return Number.isFinite(value) ? value : 0
    }
    const workers: WorkerSnapshot[] = []
    const waiting: WaitingSnapshot[] = []
    const failedDeliveries: DeliverySnapshot[] = []
    for (const ticket of store.tickets.open()) {
      const running = ticket.assignments.find(item => item.state === 'running')
      const assignment = running ?? ticket.assignments.at(-1)
      if (assignment) {
        const report = assignment.report
        workers.push({ session: executionSessionId(ticket), task: ticket.id, title: ticket.title,
          state: report?.state ?? (assignment.state === 'ended' ? 'ended' : 'awaiting-report'),
          lastReportMs: at(report?.at) || at(assignment.startedAt) || at(ticket.updatedAt) || now,
          runningSinceMs: running ? at(running.startedAt) || at(ticket.updatedAt) || now : 0,
          // Only a running assignment with no report yet, or a `progress` one, is expected to keep
          // reporting. Anything else is waiting on a person or a Source and is covered by that finding.
          expectsReports: running !== undefined && (report === undefined || !WAITING.has(report.state)) })
      }
      if (ticket.attention) {
        waiting.push({ ticket: ticket.id, id: ticket.attention.id, question: ticket.attention.question,
          // The report that carried the question is when the wait began; the ticket's own timestamp is the
          // last resort for an attention written by a version that recorded nothing else.
          since: at(assignment?.report?.at) || at(ticket.updatedAt) || now })
      }
      if (ticket.delivery) failedDeliveries.push({ ticket: ticket.id, error: ticket.delivery.error, at: at(ticket.delivery.at) || now })
    }
    const stuckReplies: ReplySnapshot[] = store.read.failingReplies()
      // Only what the queue has already given up on: a first retry is the queue working, not a problem.
      .filter(receipt => receipt.attempts >= FAILURES_BEFORE_ERROR)
      .map(receipt => ({ key: receipt.id, to: receipt.channel.thread, error: receipt.error, attempts: receipt.attempts }))
    return { workers, waiting, failedDeliveries, stuckReplies }
  }
}

/** The snapshot types the wiring reads, re-exported so a caller does not import the core directly. */
export type { DeliverySnapshot, ReplySnapshot, WaitingSnapshot, WorkerSnapshot }
