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
 * - **Only additions count.** If findings merely disappear (a question got answered, a failed
 *   delivery cleared), that is not news; the Router does not need waking to be told that something
 *   stopped. So `gone` entries are reported alongside additions but cannot trigger a wake on their own.
 * - **A key that already fired stays quiet.** A stuck job that was reported once keeps being reported
 *   in the text while it stays stuck, but does not re-announce itself just because memory free space
 *   wobbled across the threshold between two ticks.
 *
 * What this is not: it does not judge the work. It cannot tell whether a worker is making progress or
 * just running long — it only knows how long it has been since the last report and how long the
 * current turn has been open. That is why every finding is phrased as an observation with a number in
 * it, not as a verdict.
 */
import { createHash } from 'node:crypto'

/** One thing worth telling the Router, identified by a key that stays the same across ticks. */
export interface Finding {
  /** Stable across ticks: same problem, same key. This is what makes silence possible. */
  readonly key: string
  readonly text: string
}

/** A worker that has not reported for longer than this is stalled, not just busy. */
export interface PatrolOptions {
  /** How long without a report before it counts as stalled. */
  readonly stallMs: number
  /** How long a single open turn may run before it is worth mentioning. */
  readonly longRunMs: number
  /** How long something may wait on a person before it is worth mentioning. */
  readonly waitMs?: number
  /** How long a queued heavy job may wait before it is worth mentioning. */
  readonly heavyStuckMs?: number
}

/** What the patrol reads. Deliberately a plain snapshot: the patrol performs no I/O of its own. */
export interface PatrolInput {
  /** Workers that are currently active, with their latest activity in epoch ms. */
  readonly workers: ReadonlyArray<{
    readonly session: string
    readonly task: string
    readonly state: string
    /** Epoch ms of the last report, or of the last update when none arrived. */
    readonly lastReportMs: number
    /** Epoch ms when the current turn opened, or 0 when idle. */
    readonly turnStartedMs: number
    readonly running: boolean
  }>
  /** Items blocked on a human: approvals and open questions. */
  readonly waiting?: ReadonlyArray<{
    readonly session: string
    readonly kind: 'approval' | 'question'
    readonly label: string
    readonly since: number
  }>
  /** Deliveries that gave up retrying. */
  readonly failedDeliveries?: ReadonlyArray<{
    readonly key: string
    readonly from: string
    readonly to: string
    readonly error: string
  }>
  /** Open questions waiting on a person, one finding each. */
  readonly openQuestions?: ReadonlyArray<{
    readonly id: string
    readonly task: string
    readonly question: string
  }>
  /** Heavy jobs that are queued, with the free memory the queue sees. */
  readonly heavy?: {
    readonly freeGb: number
    readonly jobs: ReadonlyArray<{
      readonly id: string
      readonly label: string
      readonly session: string
      readonly minFreeGb: number
      readonly queuedAt: number
    }>
  }
}

/** The full set of findings for one moment. Pure: same input, same output. */
export function findings(input: PatrolInput, options: PatrolOptions, now: number): Finding[] {
  const out: Finding[] = []
  const minutes = (ms: number) => Math.round(ms / 60_000)

  for (const worker of input.workers) {
    const last = Math.max(worker.lastReportMs, 0)
    if (now - last > options.stallMs) {
      out.push({
        key: `stalled:${worker.session}:${worker.task}`,
        text: `${worker.session} on ${worker.task} [${worker.state}] has not reported for ${minutes(now - last)} min`,
      })
    }
    if (worker.running && worker.turnStartedMs && now - worker.turnStartedMs > options.longRunMs) {
      out.push({
        key: `long-run:${worker.session}:${worker.turnStartedMs}`,
        text: `${worker.session} has been in one turn for ${minutes(now - worker.turnStartedMs)} min`,
      })
    }
  }

  const waitMs = options.waitMs ?? 10 * 60_000
  for (const item of input.waiting ?? []) {
    if (now - item.since <= waitMs) continue
    const what = item.kind === 'approval' ? 'approval' : 'an answer'
    out.push({
      key: `waiting:${item.session}:${item.since}`,
      text: `${item.session} has been waiting ${minutes(now - item.since)} min for ${what}: ${item.label} (only a person can clear it)`,
    })
  }

  for (const failed of input.failedDeliveries ?? []) {
    out.push({
      key: `delivery-failed:${failed.key}`,
      text: `a message gave up retrying: ${failed.from} → ${failed.to}, ${failed.key}: ${failed.error}`,
    })
  }

  // One finding per question. Concatenating the ids into one key was a real upstream defect: answering
  // any single question changed the key, so the remaining ones looked like fresh news.
  for (const question of input.openQuestions ?? []) {
    out.push({
      key: `ask:${question.id}`,
      text: `waiting on a person: ${question.question.slice(0, 60)} (${question.task})`,
    })
  }

  const stuckMs = options.heavyStuckMs ?? 15 * 60_000
  if (input.heavy) {
    const queued = input.heavy.jobs
    for (const job of queued) {
      const waited = now - job.queuedAt
      // Stuck means *both* waited too long and cannot run: a job that is merely waiting its turn behind
      // a bigger one is the queue working, not a problem. Reporting it would make every long queue look
      // stuck and train the reader to ignore this line.
      const stuck = waited > stuckMs && job.minFreeGb > input.heavy.freeGb
      if (!stuck) continue
      const behind = queued.filter(other => other.id > job.id).length
      out.push({
        key: `heavy-stuck:${job.id}`,
        text:
          `heavy job ${job.id}「${job.label}」(${job.session}) queued ${minutes(waited)} min and cannot start: ` +
          `needs ${job.minFreeGb} GB free, ${input.heavy.freeGb.toFixed(1)} GB available` +
          `${behind ? `, ${behind} more behind it` : ''}`,
      })
    }
  }

  return out
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
}

/**
 * One patrol tick against the last signature.
 *
 * `previous` holds what the Router was last told: the signature and, for each key, the text it saw.
 * Passing `{}` on a cold start means every finding is new, which is correct — nobody has been told yet.
 *
 * **Every outcome carries the new signature and the caller must store it**, including `quiet`. A tick
 * that stays silent because nothing was added still has a different signature when something was
 * removed; not storing it makes the next tick report the same removals forever.
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
    return { kind: 'quiet', signature, added: [], gone: [] }
  }

  const seen = previous.reported ?? {}
  const gone = Object.entries(seen)
    .filter(([key]) => !current.some(item => item.key === key))
    .map(([, text]) => text)
  const added = current.filter(item => !(item.key in seen))

  if (!current.length) {
    // Everything cleared. Worth recording as its own outcome so a caller can log it, but never worth
    // waking anyone: "nothing is wrong" is not news.
    return { kind: 'cleared', signature, added: [], gone }
  }

  if (!added.length) {
    // Only losses. Upstream calls this `gone-only` and stays silent; so do we. The new signature is
    // still returned so the caller stops re-reporting the entries that disappeared.
    return { kind: 'quiet', signature, added: [], gone }
  }

  const kept = current.filter(item => item.key in seen)
  const lines = [
    `patrol found ${current.length} item(s) (sent because the set changed; ask for the full list to see all):`,
    `new ${added.length}:`,
    ...added.map(item => `- ${item.text}`),
    ...(gone.length ? [`cleared, no action needed: ${gone.join('; ')}`] : []),
    ...(kept.length ? [`already reported, still present ${kept.length}:`, ...kept.map(item => `- ${item.text}`)] : []),
  ]

  return { kind: 'reported', signature, text: lines.join('\n'), added, gone }
}

/** The map to store back after a tick, so the next one can tell additions from repeats. */
export function reportedMap(list: ReadonlyArray<Finding>): Record<string, string> {
  return Object.fromEntries(list.map(item => [item.key, item.text.slice(0, 120)]))
}
