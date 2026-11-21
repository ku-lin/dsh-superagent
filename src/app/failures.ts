/**
 * Deterministic failure reporting for workers and tickets.
 *
 * Nothing here asks a model whether something went wrong: every record is produced by a fixed code path that a caller
 * reached because an event said so — a worker conversation that ended with an error, a turn whose `turn/end` reason is
 * `error`, a disposed worker that still had a running assignment, an executor report of `failed`/`blocked`, a prepare
 * command that hit its timeout, a shell job that exited non-zero, or a launch that threw. The same route serves an
 * external process (`scripts/report-failure.mjs`), so a crash outside this process is reported the same way.
 *
 * A record does two things, both durable: it is appended to the bounded log `GET worker/failures` serves and the
 * panel lists, and it is queued into the Router conversation as an ordinary next turn. The queue is the existing
 * `relay` effect with `queue: true`, so a stopped Router holds the alert instead of losing it, and a restart of this
 * plugin keeps it (the effect row is in SQLite).
 * @module dsh-superagent/src/app/failures
 */
import { key } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

/** What went wrong, by the code path that saw it. Never inferred: each value is set by one call site. */
export const FAILURE_KINDS = ['crash', 'turn-error', 'agent-error', 'report-failed', 'timeout', 'exit', 'launch'] as const
export type FailureKind = typeof FAILURE_KINDS[number]
/** Who reported it: an executor path, a session event, or an external process through the HTTP route. */
export type FailureSource = 'executor' | 'session' | 'api'

/** One recorded failure, as the panel and the Router read it. */
export interface FailureRecord {
  /** Content-derived id, so the same failure recorded twice keeps one identity. */
  readonly id: string
  readonly at: string
  readonly kind: FailureKind
  readonly source: FailureSource
  /** The ticket whose work stopped, when the failure is tied to one. */
  readonly ticketId?: string
  /** The worker conversation that failed, when there is one. */
  readonly sessionId?: string
  /** The failure in the caller's own words; already trimmed to a single line by {@link oneLine}. */
  readonly detail: string
  /** Process exit code, when the failure came from a child process that reported one. */
  readonly exitCode?: number
  /** The assignment that was running, when an executor path named it. */
  readonly assignmentId?: string
}

/** How many records the log keeps; older ones drop off the front. */
export const FAILURE_LIMIT = 200
/**
 * How long a repeated `ticket + session + kind` stays quiet.
 *
 * A single incident reaches several code paths at once — a turn errors, then the agent errors, then the session is
 * disposed — and each would otherwise wake the Router with its own alert. One alert per incident is what a person
 * reads; sixty seconds matches the window the panel and the Router both work on.
 */
export const FAILURE_DEDUPE_MS = 60_000
/** Characters kept from one failure's detail, so a stack trace cannot fill the log or the Router's queue. */
export const FAILURE_DETAIL_CHARS = 600

/** Collapse a thrown value, a stack trace, or multi-line output into one trimmed line of at most `max` characters. */
export function oneLine(value: unknown, max = FAILURE_DETAIL_CHARS): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * The exit code a job's or a package manager's own sentence reports, such as `exit code: 3`.
 *
 * The producers this plugin reads (`dsh-jobs`' settlement detail and the shell tool's own failures) spell it that way;
 * a sentence without one yields `undefined`, never a guess.
 */
export function exitCodeOf(value: unknown): number | undefined {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : ''
  const match = /\bexit code:?\s*(-?\d+)\b/i.exec(text)
  return match ? Number(match[1]) : undefined
}

/** What a caller knows when it records a failure; `id`, `at` and the normalised `detail` are filled in by the log. */
export interface FailureInput {
  readonly kind: FailureKind
  readonly source: FailureSource
  readonly detail: unknown
  readonly ticketId?: string
  readonly sessionId?: string
  readonly assignmentId?: string
  readonly exitCode?: number
}

/** The Router message a failure produces, as JSON text the Router reads like any other worker report. */
export function failureRelay(record: FailureRecord): string {
  return JSON.stringify({ kind: 'worker_failure', failure_id: record.id, ticket_id: record.ticketId ?? null,
    session: record.sessionId ?? null, failure_kind: record.kind, reported_by: record.source, detail: record.detail,
    at: record.at, ...record.exitCode === undefined ? {} : { exit_code: record.exitCode },
    note: 'A fixed code path recorded this, not a model: the worker or its process stopped because of an error. '
      + 'Nothing is waiting on your judgement of the cause; read the failure list, then decide whether the ticket '
      + 'needs a retry, a stop, or a person.' })
}

/** Host dependencies of {@link FailureLog}. */
export interface FailureHost {
  readonly store: Pick<Store, 'get' | 'set' | 'atomic'>
  /** Queues one message for the Router conversation; a stopped Router holds it in the durable queue. */
  routerMessage(requestId: string, text: string): void
  /** Announces a new record to every live panel; a host without a stream simply has none. */
  publish?(record: FailureRecord): void
}

/**
 * The bounded, deduplicated failure log, and the one place a failure becomes a Router message.
 *
 * `record` is deliberately synchronous and safe to call from inside a `Store.atomic` transaction: the log write joins
 * the caller's transaction, and the Router delivery is queued only after it commits, so a rolled-back ticket update
 * leaves neither a record nor an alert behind.
 */
export class FailureLog {
  /** When each `ticket|session|kind` was last recorded, in this process; the dedupe window needs no persistence. */
  private readonly seen = new Map<string, number>()
  constructor(private readonly host: FailureHost, private readonly now: () => number = Date.now) {}

  /** The log, oldest first, as `GET worker/failures` and the panel list it. */
  list(): readonly FailureRecord[] { return this.host.store.get(KV.runtime.failures) ?? [] }

  /** The failures of one ticket, newest first. */
  ofTicket(ticketId: string): readonly FailureRecord[] { return this.list().filter(record => record.ticketId === ticketId).reverse() }

  /**
   * Records one failure, unless the same ticket, session and kind was recorded within {@link FAILURE_DEDUPE_MS}.
   * @param input - what the caller saw; `detail` is flattened to one line.
   * @returns the stored record, or `undefined` when the window suppressed it.
   */
  record(input: FailureInput): FailureRecord | undefined {
    const detail = oneLine(input.detail)
    const dedupe = `${input.ticketId ?? ''}|${input.sessionId ?? ''}|${input.kind}`
    const at = this.now()
    const previous = this.seen.get(dedupe)
    if (previous !== undefined && at - previous < FAILURE_DEDUPE_MS) return undefined
    // Prune the window so a long-lived process does not grow one entry per incident for ever.
    for (const [name, when] of this.seen) if (at - when >= FAILURE_DEDUPE_MS) this.seen.delete(name)
    this.seen.set(dedupe, at)
    const record: FailureRecord = { id: key('failure', input.ticketId ?? '', input.sessionId ?? '', input.kind, detail, String(at)),
      at: new Date(at).toISOString(), kind: input.kind, source: input.source, detail,
      ...input.ticketId === undefined ? {} : { ticketId: input.ticketId },
      ...input.sessionId === undefined ? {} : { sessionId: input.sessionId },
      ...input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId },
      ...input.exitCode === undefined ? {} : { exitCode: input.exitCode } }
    const store = this.host.store
    // The queue row joins the same transaction as the log entry, exactly as the executor's own failure relay does: a
    // caller whose ticket write rolls back leaves neither the record nor the alert behind.
    store.atomic(() => {
      store.set(KV.runtime.failures, [...this.list(), record].slice(-FAILURE_LIMIT))
      this.host.routerMessage(`failure:${record.id}`, failureRelay(record))
    })
    this.host.publish?.(record)
    return record
  }
}
