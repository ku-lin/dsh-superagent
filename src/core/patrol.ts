/**
 * Silent patrol: look for problems on a timer without waking the model, then speak only when the set
 * of findings actually changes.
 *
 * Borrowed from dsh-master's `patrol.ts` (MIT, ZhuFrank/dsh-master-plugin). The mechanism worth
 * copying is narrow but important: findings are a **set keyed by a stable id**, and the whole set is
 * hashed. If the hash matches the last one, this tick does nothing at all — no message, no model call,
 * no event. A timer that wakes the Router every ten minutes to say "still two things waiting" is
 * worse than no timer, because it burns a model turn to deliver information the Router already had.
 *
 * Two subtleties lifted from upstream, both about not crying wolf:
 *
 * - **Only additions count.** If findings merely disappear (a question got answered, a failed delivery
 *   went through), that is not news; the Router does not need waking to be told that something
 *   stopped. So `gone` entries are reported alongside additions but cannot trigger a wake on their own.
 * - **A key that already fired stays quiet.** A stuck worker that was reported once keeps being
 *   reported in the text while it stays stuck, but does not re-announce itself just because its
 *   minutes-since counter moved between two ticks.
 *
 * What this is not: it does not judge the work. It cannot tell whether a worker is making progress or
 * just running long — it only knows how long it has been since the last report and how long its
 * assignment has been open. That is why every finding is phrased as an observation with a number in
 * it, not as a verdict.
 *
 * Every field of {@link PatrolInput} is a fact this system actually stores: an open Ticket's latest
 * Assignment, its `attention` question, its failed Input `delivery`, and the `reply` effect rows that
 * failed past the error threshold. A snapshot of memory pressure or of a queue this plugin never
 * measures is deliberately absent — an invented number would be reported with the same confidence as a
 * measured one, and a Router cannot tell the difference.
 */
import { createHash } from 'node:crypto'

/** One thing worth telling the Router, identified by a key that stays the same across ticks. */
export interface Finding {
  /** Stable across ticks for the same problem at the same place. This is what makes silence possible. */
  readonly key: string
  readonly text: string
}

/** Thresholds at which an observation becomes worth mentioning. All are durations in milliseconds. */
export interface PatrolOptions {
  /** How long a worker expected to report may go quiet before it counts as stalled. */
  readonly stallMs: number
  /** How long one Assignment may stay running before it is worth mentioning. */
  readonly longRunMs: number
  /** How long a question may wait on a person before it is worth mentioning. */
  readonly waitMs?: number
}

/** An open Assignment's worker, as its Ticket and that Assignment describe it. */
export interface WorkerSnapshot {
  /** The DSH Session the Assignment runs in. */
  readonly session: string
  /** The Ticket's id, which is what an operator acts on. */
  readonly task: string
  /** The Ticket's title, so the line reads without a lookup. */
  readonly title: string
  /**
   * What the worker last said of itself: a `ReportState`, `awaiting-report` before its first report, or
   * `reported` when its latest report is a state that legitimately waits instead of reporting.
   */
  readonly state: string
  /** Epoch ms of the latest report, the Assignment's start, or the Ticket's own timestamp, whichever applies. */
  readonly lastReportMs: number
  /** Epoch ms when the current Assignment started, or 0 when it is not running. */
  readonly runningSinceMs: number
  /**
   * Whether silence is suspicious. A worker that reported `waiting`, `ready`, `blocked` or `failed` is
   * waiting on something else on purpose; calling that a stall would report the same situation twice,
   * as a stall *and* as the question it is actually waiting on.
   */
  readonly expectsReports: boolean
}

/** A question only a person can answer: a Ticket's `attention`. */
export interface WaitingSnapshot {
  readonly ticket: string
  /** The `attention` id, which changes when the question does, so an answered one is not re-announced. */
  readonly id: string
  readonly question: string
  /** Epoch ms the question was raised, from the report that carried it. */
  readonly since: number
}

/** An Input that could not be handed to its worker; the Ticket's `delivery` keeps the last one. */
export interface DeliverySnapshot {
  readonly ticket: string
  readonly error: string
  /** Epoch ms of the failed delivery. */
  readonly at: number
}

/** A message whose `reply` effect failed repeatedly and is still queued. */
export interface ReplySnapshot {
  /** The receipt's id, which the outbox and its effect row are keyed by. */
  readonly key: string
  /** Where it was going, as the Channel's thread. */
  readonly to: string
  readonly error: string
  readonly attempts: number
}

/** What the patrol reads. Deliberately a plain snapshot: the patrol performs no I/O of its own. */
export interface PatrolInput {
  readonly workers: ReadonlyArray<WorkerSnapshot>
  readonly waiting?: ReadonlyArray<WaitingSnapshot>
  readonly failedDeliveries?: ReadonlyArray<DeliverySnapshot>
  readonly stuckReplies?: ReadonlyArray<ReplySnapshot>
}

/** Longest a quoted field may be, so one long error cannot swamp the message. */
const QUOTE = 140
const clip = (text: string): string => text.length > QUOTE ? `${text.slice(0, QUOTE)}…` : text
const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000))

/** The full set of findings for one moment. Pure: same input, same output. */
export function findings(input: PatrolInput, options: PatrolOptions, now: number): Finding[] {
  const out: Finding[] = []

  for (const worker of input.workers) {
    const quiet = now - worker.lastReportMs
    if (worker.expectsReports && quiet > options.stallMs) {
      out.push({
        // The Ticket, not the Assignment: a worker that recovers and stalls again is the same problem in
        // the same place, and a new Assignment id would re-announce it as fresh news.
        key: `stalled:${worker.task}`,
        text: `${worker.title} (${worker.task}, ${worker.session}) has not reported for ${minutes(quiet)} min; its last word was ${worker.state}`,
      })
    }
    if (worker.runningSinceMs > 0 && now - worker.runningSinceMs > options.longRunMs) {
      out.push({
        // The start time stays in the key: a relaunched Assignment is a different run, and a Router that
        // was told about the first one should hear about the second.
        key: `long-run:${worker.task}:${worker.runningSinceMs}`,
        text: `${worker.title} (${worker.task}) has been running one assignment for ${minutes(now - worker.runningSinceMs)} min`,
      })
    }
  }

  const waitMs = options.waitMs ?? 10 * 60_000
  for (const item of input.waiting ?? []) {
    if (now - item.since <= waitMs) continue
    out.push({
      // The attention id, so answering this question and the worker asking another are two events rather
      // than one key that changes underneath the Router.
      key: `ask:${item.ticket}:${item.id}`,
      text: `${item.ticket} has waited ${minutes(now - item.since)} min for an answer only a person can give: ${clip(item.question)}`,
    })
  }

  for (const failed of input.failedDeliveries ?? []) {
    out.push({
      // Keyed by the Ticket: a retried delivery that keeps failing is one problem, and its newest error is
      // not news. A delivery that succeeds drops the entry, so a later failure is an addition again.
      key: `delivery-failed:${failed.ticket}`,
      text: `an input for ${failed.ticket} could not be handed to its worker ${minutes(now - failed.at)} min ago: ${clip(failed.error)}`,
    })
  }

  for (const reply of input.stuckReplies ?? []) {
    out.push({
      key: `reply-stuck:${reply.key}`,
      text: `a message to ${reply.to} has failed ${reply.attempts} times and is still queued: ${clip(reply.error)}`,
    })
  }

  return out
}

/**
 * The earliest instant, strictly after `now`, at which a condition that is quiet right now becomes a
 * finding. Pure, so the host can arm exactly one timer instead of ticking every few seconds.
 *
 * Conditions already true (a failed delivery, a stuck reply) contribute nothing: they are findings the
 * moment they exist, so a caller that has just ticked has already reported them. If they are gone, only
 * an external change can bring them back — which is what `request()` is for.
 *
 * @returns epoch ms of the next crossing, or `undefined` when nothing is waiting to cross a threshold.
 */
export function nextDue(input: PatrolInput, options: PatrolOptions, now: number): number | undefined {
  const candidates: number[] = []
  // One millisecond past the threshold: `findings` uses a strict `>`, so a timer armed exactly on the
  // boundary would re-arm itself for the same instant and spin.
  const consider = (when: number): void => { if (when >= now) candidates.push(when + 1) }
  for (const worker of input.workers) {
    if (worker.expectsReports) consider(worker.lastReportMs + options.stallMs)
    if (worker.runningSinceMs > 0) consider(worker.runningSinceMs + options.longRunMs)
  }
  const waitMs = options.waitMs ?? 10 * 60_000
  for (const item of input.waiting ?? []) consider(item.since + waitMs)
  return candidates.length ? Math.min(...candidates) : undefined
}

/** A hash of the sorted keys: equal signatures mean "the same set of problems". */
export function signatureOf(list: ReadonlyArray<Finding>): string {
  return createHash('sha1').update(list.map(item => item.key).sort().join('\n')).digest('hex')
}

/** What a tick decided, and what to say if it decided to speak. */
export interface TickResult {
  readonly kind: 'quiet' | 'reported' | 'cleared'
  readonly signature: string
  /** Present only when `kind === 'reported'`. */
  readonly text?: string
  readonly added: readonly Finding[]
  readonly gone: readonly string[]
  /**
   * The whole set at this moment, added and kept alike. The caller stores `reportedMap(current)` after a
   * tick that spoke; recomputing the map from `added` alone drops the findings that are still present,
   * and the next tick announces them as new.
   */
  readonly current: readonly Finding[]
}

/**
 * One patrol tick against the last signature.
 *
 * `previous` holds what the Router was last told: the signature and, for each key, the text it saw.
 * Passing `{}` on a cold start means every finding is new, which is correct — nobody has been told yet.
 *
 * **Every outcome carries the new signature and the caller must store it**, including `quiet`. A tick
 * that stays silent because nothing was added still has a different signature when something was
 * removed; not storing it makes the next tick report the same removals forever — and keeps a problem
 * that disappeared inside the map, so its return would be silent.
 */
export function tick(
  input: PatrolInput,
  options: PatrolOptions,
  now: number,
  previous: { signature?: string | undefined; reported?: Record<string, string> | undefined },
): TickResult {
  const current = findings(input, options, now)
  const signature = signatureOf(current)

  if (signature === previous.signature) {
    return { kind: 'quiet', signature, added: [], gone: [], current }
  }

  const seen = previous.reported ?? {}
  const gone = Object.entries(seen)
    .filter(([key]) => !current.some(item => item.key === key))
    .map(([, text]) => text)
  const added = current.filter(item => !(item.key in seen))

  if (!current.length) {
    // Everything cleared. Worth recording as its own outcome so a caller can log it, but never worth
    // waking anyone: "nothing is wrong" is not news.
    return { kind: 'cleared', signature, added: [], gone, current }
  }

  if (!added.length) {
    // Only losses. Upstream calls this `gone-only` and stays silent; so do we. The new signature is
    // still returned so the caller stops re-reporting the entries that disappeared.
    return { kind: 'quiet', signature, added: [], gone, current }
  }

  const kept = current.filter(item => item.key in seen)
  const lines = [
    `patrol found ${current.length} item(s):`,
    `new ${added.length}:`,
    ...added.map(item => `- ${item.text}`),
    ...(gone.length ? [`cleared, no action needed: ${gone.join('; ')}`] : []),
    ...(kept.length ? [`already reported, still present ${kept.length}:`, ...kept.map(item => `- ${item.text}`)] : []),
  ]

  return { kind: 'reported', signature, text: lines.join('\n'), added, gone, current }
}

/** The map to store back after a tick, so the next one can tell additions from repeats. */
export function reportedMap(list: ReadonlyArray<Finding>): Record<string, string> {
  return Object.fromEntries(list.map(item => [item.key, item.text.slice(0, 120)]))
}
