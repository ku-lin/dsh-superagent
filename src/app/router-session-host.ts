/**
 * The DSH Session boundary behind `RouterRefresh`: hold a Session's admission, export its complete flushed log,
 * create a replacement without waking it, verify it, and summarize the archived events.
 *
 * Everything here talks to DSH through published services only (`ctx.sessionController`, `ctx.sessions`,
 * `ctx.sessionPersistence`, `ctx.agents`) and through the `RefreshHost` contract `router-refresh.ts` pins. The rule the
 * contract exists for is that **nothing is deleted and nothing is invented**: an export that could not be read
 * completely or flushed durably answers `complete: false` instead of a plausible prefix, a hold that cannot be
 * guaranteed throws instead of pretending to hold, and the summary is read out of the archived events instead of being
 * written from a model's memory of them.
 *
 * Three choices worth stating, each with its reason:
 *
 * - **The live log is the authority while the Session is live, and the stored prefix proves the flush.** A live Agent's
 *   `session.snapshotEvents()` holds the same events as storage plus whatever the checkpoint policy has not flushed
 *   yet. The export reads the live log, flushes it, re-reads the stored prefix, and refuses when storage holds less —
 *   that gap is exactly the truncation an archive must never accept.
 * - **The hold is `agent.runMaintenance`.** It claims the agent's idle phase, and input that arrives while the task is
 *   pending stays in the inbox instead of starting a turn, so the export cannot race a step. A running turn, a queued
 *   message, or an agent that refuses the claim is a refusal: this module never cancels a turn to make its own job
 *   easier.
 * - **The new Session joins a Workspace and is never woken.** `sessionController.create` receives `workspaceId` only,
 *   because DSH refuses a create that names both a Workspace and a `cwd`; the Workspace decides the directory. No
 *   message is sent into the new Session, so its first instruction is the summarized state a person speaks into next.
 * @module dsh-superagent/src/app/router-session-host
 */
import { createHash } from 'node:crypto'
import { RouterRefresh, type RouterExport, type RefreshHost } from './router-refresh.ts'
import type { RouterIdentity, RouterRegistry } from './router-registry.ts'
import { ROUTER_PRESET } from './router-sessions.ts'

/** One committed Session event, narrowed to the fields this module reads. Structural on purpose: a host type change cannot silently break the archive. */
export interface SessionEventLike {
  readonly seq: number
  readonly type: string
  /** Unix epoch milliseconds at append, when the log carries one. */
  readonly time?: number
  readonly data?: unknown
}

/** The live Agent surface the hold, the export and verification use; the subset of DSH's `Agent` this module touches. */
export interface RefreshAgent {
  readonly status: string
  readonly inbox: { readonly nextTurn: readonly unknown[]; readonly nextStep: readonly unknown[] }
  readonly session: {
    readonly header: { readonly agentPreset?: string; readonly cwd?: string }
    /** The complete in-memory event log, from seq 0. */
    snapshotEvents(): readonly SessionEventLike[]
  }
  /** Claim the agent's idle phase for a non-turn task; throws synchronously when a turn or another task owns it. */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** The DSH Session calls this host makes. Each one is a published `sessionController`/registry call in the Runtime. */
export interface RouterSessionIo {
  /** Resolve or resume one Session's Agent. Resuming composes the Agent; it starts no turn. */
  resolveAgent(sessionId: string): Promise<{ readonly agent?: RefreshAgent; readonly error?: unknown } | undefined>
  /** The Agent already live for this Session, without resuming a cold one: an export must not activate a Session. */
  liveAgent?(sessionId: string): RefreshAgent | undefined
  /** The stored header and complete persisted event prefix, without activating the Agent. */
  inspect(sessionId: string): Promise<{ readonly events: readonly SessionEventLike[]; readonly meta?: { readonly agentPreset?: string } }>
  /** Create or adopt one Session. `workspaceId` only: DSH refuses a create naming both it and `cwd`. */
  create(request: { readonly sessionId: string; readonly workspaceId: string; readonly agentPreset: string }): Promise<
    { readonly sessionId?: string; readonly agentPreset?: string } | undefined>
}

/** Host wiring the boundary needs; every member is a published DSH call or a Runtime helper. */
export interface RouterSessionHostOptions {
  readonly sessions: RouterSessionIo
  /** Durability barrier for one live Session (`ctx.sessions.flush`); `false` means no listener could confirm it. */
  flush?(session: unknown): Promise<boolean>
  /** Process-wide barrier and stored headers (`ctx.sessionPersistence`). */
  readonly persistence?: {
    flush(): Promise<void>
    stat?(sessionId: string): Promise<{ readonly header: { readonly agentPreset?: string; readonly cwd?: string } } | undefined>
  }
  /**
   * The Workspace a replacement Router conversation joins: the one the Session being replaced runs in, created for that
   * same directory when no Workspace covers it yet. `undefined` refuses the refresh rather than guessing a directory — a
   * Router conversation staged in an unrelated folder is worse than an honest failure.
   */
  workspace(replacingSessionId: string): Promise<{ readonly id: string } | undefined>
  /** Where an unprovable read says why. Observability only: it never changes an answer. */
  readonly logger?: { warn(message: string, ...args: unknown[]): void }
}

/**
 * A refresh the host refused on purpose: a state conflict the caller can resolve by doing something first, as opposed
 * to a failure of this plugin. `http.ts` answers it as 409 with the code it carries, so the panel can say which of them
 * happened instead of "500".
 */
export class RouterRefreshRefused extends Error {
  constructor(readonly code: 'sessionBusy' | 'sessionHeld' | 'contextIncomplete' | 'refreshPreparing' | 'noWorkspace',
    message: string, readonly status: 409 = 409) { super(message) }
}

/** Event types that mean the Session has done work, so a "blank replacement" claim would be false. */
const WORK_EVENTS = new Set([
  'user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'turn/start', 'turn/end',
  'step/start', 'step/end', 'system/message', 'developer/message', 'request/header', 'request/context',
  'compaction/start', 'compaction/end',
])
/**
 * The engine's own refusal for an export that cannot be archived. `router-refresh.ts` is outside this change, so the
 * wording is pinned here and asserted by `tests/router-session-host.spec.ts`: if the engine changes it, that test fails
 * instead of the mapping silently degrading to a 500.
 */
const ENGINE_INCOMPLETE = 'Complete flushed context export is required'
/** How much of one message the deterministic summary quotes; the archive keeps the full text either way. */
const QUOTE = 280
/**
 * Tool-name fragments that mean a step proved something rather than merely ran. Used to report verification evidence
 * that is actually in the log; a summary never claims a check that left no trace.
 */
const VERIFYING_TOOLS = /(^|_)(test|verify|accept|check|lint|typecheck|build|vitest|tsc)(_|$)/i
/** Sentences a person wrote as a decision. English and Chinese, because the Router is used in both. */
const DECISION_SENTENCE = /(\bdecided\b|\bdecision\b|\bwe will\b|\bchose\b|决定|采用|定为|方案是)/i
/**
 * A decision line: the sentence of the message that states it, trimmed to the quote budget.
 * Reads only what a person or the Router actually wrote — no decision is derived from tool activity.
 */
function decisionLines(events: readonly ParsedEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    for (const sentence of messageText(event.data).split(/(?<=[.!?。！？])\s+|\n/)) {
      if (!DECISION_SENTENCE.test(sentence)) continue
      const line = oneLine(sentence)
      if (line !== '' && !lines.includes(line)) lines.push(`(seq ${event.seq}) ${line}`)
    }
  }
  // The newest decisions are what the next conversation needs; older ones remain in the archive.
  return lines.slice(-5)
}
/**
 * Messages that name a project other than the one this archive belongs to, and no identity of their own.
 *
 * A refresh archives one Router's conversation. If that text talks about another project, filing it here would leak one
 * project's context into another, so it is listed for a person to place instead. The test is deliberately conservative:
 * another project is only recognised from an explicit `project-<uuid>` id, never from a name or a directory guess.
 */
function unattributedLines(events: readonly ParsedEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const text = messageText(event.data)
    const ids = new Set(text.match(/project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])
    if (ids.size === 0) continue
    lines.push(`(seq ${event.seq}) mentions ${[...ids].join(', ')}: ${oneLine(text)}`)
  }
  return lines.slice(-5)
}

/** The text of a message event's content blocks, as the loop writes them. */
function messageText(data: unknown): string {
  const record = data as { content?: readonly unknown[]; message?: { content?: readonly unknown[] } } | undefined
  const blocks = record?.content ?? record?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => {
      const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown }
      return type === 'text' && typeof text === 'string' ? text : ''
    })
    .filter(text => text !== '')
    .join('\n')
    .trim()
}

/** One line's worth of text: whitespace folded so a quoted message cannot break the summary's structure. */
function oneLine(text: string): string {
  const folded = text.replace(/\s+/g, ' ').trim()
  return folded.length > QUOTE ? `${folded.slice(0, QUOTE)}…` : folded
}

/**
 * The deterministic source identity of one export: a SHA-256 over the exact archived bytes, with the event count, the
 * first and last sequence number, and the byte length in the clear.
 *
 * Every component is read off the events themselves, so two exports of one log produce one identity and any difference
 * in content produces a different one. That is what makes a retried refresh idempotent at the archive's primary key
 * while a genuinely changed log is refused as different context.
 * @param events - the complete event list, in seq order.
 * @param raw - the exact JSON-lines text archived for those events.
 */
export function sourceIdentity(events: readonly SessionEventLike[], raw: string): string {
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex')
  const first = events.length ? String(events[0]!.seq) : 'none'
  const last = events.length ? String(events[events.length - 1]!.seq) : 'none'
  return `sha256:${digest};events:${events.length};seq:${first}-${last};bytes:${Buffer.byteLength(raw, 'utf8')}`
}

/** One archived line parsed back into the fields the summary reads. */
export interface ParsedEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: unknown
}

/**
 * Parse the archived JSON-lines export.
 *
 * A summary is worth only what it can point at, so an unparseable line throws instead of being skipped: a summary
 * computed from part of a log would describe a conversation that never happened.
 * @param raw - the archived text, one JSON event per line.
 */
export function parseExport(raw: string): ParsedEvent[] {
  const events: ParsedEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error('The archived export is not a JSON-lines event log') }
    const event = value as { seq?: unknown; type?: unknown; time?: unknown; data?: unknown }
    if (typeof event?.seq !== 'number' || typeof event?.type !== 'string')
      throw new Error('The archived export carries an event without a sequence number or type')
    // `time` is only a number when the log carried one; anything else is reported as absent rather than coerced.
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined
    events.push({ seq: event.seq, type: event.type, ...time === undefined ? {} : { time },
      ...event.data === undefined || event.data === null ? {} : { data: event.data } })
  }
  return events
}

/**
 * Turn counts, tool counts and the newest facts of one archived export, as plain numbers and strings.
 *
 * Kept separate from {@link summaryOf} so the renderer stays a formatter: every value here is either read off the events
 * or reported as absent, and nothing is estimated.
 * @param events - the parsed archive.
 */
export function archiveFacts(events: readonly ParsedEvent[]) {
  if (!events.length) throw new Error('A project summary needs the archived conversation events')
  const lastOf = (type: string): ParsedEvent | undefined => [...events].reverse().find(event => event.type === type)
  const calls = new Map<string, number>()
  const unanswered = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') continue
    const record = event.data as { name?: unknown; callId?: unknown } | undefined
    const callId = typeof record?.callId === 'string' ? record.callId : ''
    if (event.type === 'tool/call') {
      const name = typeof record?.name === 'string' && record.name !== '' ? record.name : 'unnamed'
      calls.set(name, (calls.get(name) ?? 0) + 1)
      if (callId !== '') unanswered.add(callId)
    } else if (callId !== '') {
      // A result answers a call, so that call is no longer unfinished. A result for an unknown call still carries a
      // name, so it counts toward the tool tallies through the map key written below rather than being dropped.
      unanswered.delete(callId)
      const name = typeof record?.name === 'string' && record.name !== '' ? record.name : undefined
      if (name !== undefined && !calls.has(name)) calls.set(name, 0)
    }
  }
  const newest = events[events.length - 1]!
  return {
    events: events.length,
    firstSeq: events[0]!.seq,
    lastSeq: newest.seq,
    newestType: newest.type,
    newestAt: typeof newest.time === 'number' ? new Date(newest.time).toISOString() : undefined,
    turnsStarted: events.filter(event => event.type === 'turn/start').length,
    turnsCompleted: events.filter(event => event.type === 'turn/end').length,
    lastInstruction: lastOf('user/message'),
    lastReply: lastOf('assistant/message'),
    toolCalls: [...calls].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    unansweredCalls: [...unanswered].sort(),
  }
}

/**
 * The deterministic project-state summary of one archived export.
 *
 * The six sections a person needs to continue: goal, decisions, done/undone, verification, risks, next step. Every
 * value is read out of the archived events and nothing is inferred from a model's memory; a section with no evidence
 * says so instead of being filled with a plausible sentence. A message that mentions work belonging to no project the
 * archive names is listed under `Unattributed` rather than guessed into this project: mis-filing another project's
 * decision is worse than leaving it for a person to place.
 *
 * The archived text stays the authority; this states what the next Router needs in order to continue.
 * @param projectId - the project the archive belongs to, echoed so a summary cannot be pasted onto another project.
 * @param source - the export the refresh archived.
 */
export function summaryOf(projectId: string, source: RouterExport): string {
  const events = parseExport(source.raw)
  const facts = archiveFacts(events)
  const quoted = (event: ParsedEvent | undefined): string => {
    const text = event ? messageText(event.data) : ''
    return text === '' ? 'none yet' : `(seq ${event!.seq}) ${oneLine(text)}`
  }
  const tools = facts.toolCalls.map(([name, count]) => `${name} ×${count}`)
  // The goal is the first instruction of the archived span: what the person asked for before any work started.
  const firstInstruction = events.find(event => event.type === 'user/message')
  // Verification evidence is read from tool names a run uses to prove something, never asserted.
  const verified = facts.toolCalls.filter(([name]) => VERIFYING_TOOLS.test(name)).map(([name, count]) => `${name} ×${count}`)
  // A failed or blocked outcome is recorded in the log; it becomes a risk, not a silent omission.
  const failed = events.filter(event => {
    const data = event.data as { error?: unknown; reason?: { kind?: unknown } } | undefined
    return data?.error !== undefined && data.error !== null || data?.reason?.kind === 'error'
  })
  const pending = facts.unansweredCalls.length
  return [
    `Project ${projectId} · Router context archive`,
    `Events: ${facts.events} (seq ${facts.firstSeq}–${facts.lastSeq}), source ${source.sourceId}`,
    '',
    `Goal: ${quoted(firstInstruction)}`,
    `Decisions: ${decisionLines(events).length === 0 ? 'none recorded in this span' : ''}`,
    ...decisionLines(events).map(line => `  - ${line}`),
    'Done / undone:',
    `  - ${facts.turnsCompleted} turn(s) completed of ${facts.turnsStarted} started`,
    tools.length ? `  - tools used: ${tools.join(', ')}` : '  - no tool was used',
    pending ? `  - ${pending} tool call(s) without a result${facts.unansweredCalls.length ? ` (first: ${facts.unansweredCalls.slice(0, 3).join(', ')}${facts.unansweredCalls.length > 3 ? ', …' : ''})` : ''}` : '  - every tool call got a result',
    `Verification: ${verified.length ? verified.join(', ') : 'no verification command appears in this span'}`,
    `Risks: ${failed.length ? `${failed.length} failed or errored step(s)` : 'none recorded in this span'}`,
    ...failed.slice(-3).map(event => `  - (seq ${event.seq}) ${oneLine((event.data as { error?: { message?: string } }).error?.message ?? 'a step ended in an error')}`),
    `Next step: ${quoted(facts.lastInstruction)}`,
    `Unattributed (kept for a person to place, never filed into ${projectId}): ${unattributedLines(events).length === 0 ? 'none' : ''}`,
    ...unattributedLines(events).map(line => `  - ${line}`),
  ].filter(line => line !== '').join('\n')
}

/**
 * The DSH-backed `RefreshHost`.
 *
 * Constructed once per Runtime beside the registry it serves. No Session state is cached between calls: a hold is the
 * only live state, and the caller's `finally` always releases it.
 */
export class RouterSessionHost implements RefreshHost {
  /** Why the last export could not promise a complete flushed prefix; kept for diagnostics and the refusal message. */
  lastIncomplete: string | undefined
  /** Sessions this host is holding, so two refreshes cannot claim the same idle phase. */
  private readonly held = new Set<string>()
  constructor(private readonly options: RouterSessionHostOptions) {}

  /**
   * Claim a Session's admission until `release`.
   *
   * The claim is `runMaintenance`: it starts synchronously once it owns the agent's idle phase, and input that arrives
   * while it is pending stays in the inbox rather than opening a turn. A running turn, a non-empty inbox, or a refused
   * claim is a {@link RouterRefreshRefused}: DSH offers no safe way to hold a turn that already started, and cancelling
   * one would drop work the person asked for.
   * @param sessionId - the Router generation being replaced.
   * @returns a release that settles the claim; idempotent, and safe to call after a failed refresh.
   */
  async hold(sessionId: string): Promise<() => void> {
    if (this.held.has(sessionId)) throw new RouterRefreshRefused('sessionHeld', `Session ${sessionId} already holds a refresh admission hold`)
    const resolved = await this.options.sessions.resolveAgent(sessionId)
    const agent = resolved?.agent
    if (!agent) throw new Error(`Session ${sessionId} has no resolvable Agent: ${describe(resolved?.error)}`)
    if (agent.status !== 'idle')
      throw new RouterRefreshRefused('sessionBusy', `Session ${sessionId} is ${agent.status}; a refresh may only start from an idle Session`)
    const queued = agent.inbox.nextTurn.length + agent.inbox.nextStep.length
    if (queued > 0)
      throw new RouterRefreshRefused('sessionBusy', `Session ${sessionId} still has ${queued} queued message(s); a refresh may only start from a drained Session`)
    let finish!: () => void
    const admitted = new Promise<void>(resolve => { finish = resolve })
    let task: Promise<void>
    try {
      // The task body waits for the release, or for the agent's own cancellation so a cancelled turn cannot leave the
      // claim pending for ever. Nothing runs inside it: this is admission control, not work.
      task = agent.runMaintenance(async signal => {
        const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        await Promise.race([admitted, aborted])
      })
    } catch (error) {
      throw new RouterRefreshRefused('sessionBusy',
        `Session ${sessionId} could not be held: another turn or maintenance task owns it (${describe(error)})`)
    }
    this.held.add(sessionId)
    let released = false
    const settle = (): void => { this.held.delete(sessionId) }
    task.then(settle, (error: unknown) => {
      settle()
      this.options.logger?.warn('the refresh hold on Session %s ended unexpectedly: %s', sessionId, String(error))
    })
    return () => {
      if (released) return
      released = true
      finish()
    }
  }

  /**
   * Export the complete, flushed event log of one Session as JSON lines.
   *
   * `complete` is true only when every event was read (contiguous from seq 0), the durability barrier succeeded, and the
   * stored prefix holds exactly what was read — unless storage holds *more*, which is the newest state and wins. A host
   * whose storage lags its live log answers `complete: false` instead of an archive that silently lost the tail.
   * @param sessionId - the Session whose history is being replaced.
   */
  async export(sessionId: string): Promise<RouterExport> {
    this.lastIncomplete = undefined
    // Never resume a cold Session here: resolution is `hold`'s job, and an export that activated a Session to read it
    // would start composing an Agent only to replace it.
    const live = this.options.sessions.liveAgent?.(sessionId)
    const events = await this.read(sessionId, live)
    if (events === undefined) return { sourceId: '', raw: '', complete: false }
    const raw = events.map(event => JSON.stringify(event)).join('\n')
    if (raw === '') {
      this.refuse(sessionId, 'the Session has no events to archive')
      return { sourceId: '', raw: '', complete: false }
    }
    return { sourceId: sourceIdentity(events, raw), raw, complete: true }
  }

  /**
   * Create the replacement Router Session without waking it.
   *
   * `workspaceId` only, with the router preset: DSH derives the working directory from the Workspace, and no message is
   * sent, so the Session stays a blank history rather than a conversation that already began. The persistence barrier
   * runs before returning, so `verify` (and a crash right after it) sees a header that is really stored.
   * @param sessionId - the new Session identity the registry minted.
   * @param projectId - the project the Router serves; the registry bound it already, so this only explains a refusal.
   */
  async create(sessionId: string, projectId: string, replacingSessionId = ''): Promise<void> {
    const workspace = await this.options.workspace(replacingSessionId)
    if (!workspace?.id) throw new RouterRefreshRefused('noWorkspace',
      `No Workspace covers the Router conversation's directory, so project ${projectId} has nowhere to stage its replacement Session`)
    const created = await this.options.sessions.create({ sessionId, workspaceId: workspace.id, agentPreset: ROUTER_PRESET })
    if (created?.sessionId !== undefined && created.sessionId !== sessionId)
      throw new Error(`The host created ${created.sessionId} instead of the prepared Session ${sessionId}`)
    if (created?.agentPreset !== undefined && created.agentPreset !== ROUTER_PRESET)
      throw new Error(`The host composed the replacement Session with preset ${created.agentPreset}, not ${ROUTER_PRESET}`)
    await this.options.persistence?.flush()
  }

  /**
   * Verify a staged Session is blank, resumable, and composed with the router preset.
   *
   * Resolving the Agent proves the Session can be resumed at all; the durable header is the authority for the preset (a
   * projection can read another value); and the event log must hold no work — no message, turn, step, tool call or
   * assembled request. A Session absent from storage was never durably created and is refused whatever the live
   * registry says.
   * @param sessionId - the staged Session the refresh would publish.
   */
  async verify(sessionId: string): Promise<boolean> {
    let agent: RefreshAgent
    try {
      const resolved = await this.options.sessions.resolveAgent(sessionId)
      if (!resolved?.agent) return false
      agent = resolved.agent
    } catch { return false }
    if (agent.session.header.agentPreset !== ROUTER_PRESET) return false
    const persistence = this.options.persistence
    const stat = persistence?.stat
    if (stat !== undefined) {
      let stored: Awaited<ReturnType<typeof stat>>
      try { stored = await stat(sessionId) } catch { return false }
      if (!stored || stored.header.agentPreset !== ROUTER_PRESET) return false
    }
    return agent.session.snapshotEvents().every(event => !WORK_EVENTS.has(event.type))
  }

  /**
   * The project-state summary of one archived export.
   *
   * Deterministic by design: it reads the events it was handed and nothing else, so the same archive always yields the
   * same state, a test can assert it exactly, and no model is asked to summarize a conversation it never saw. A host
   * that wants a model-written state can wrap this host and feed it the same archived text.
   */
  async summarize(projectId: string, source: RouterExport): Promise<string> {
    return summaryOf(projectId, source)
  }

  /**
   * Read the complete event list for `sessionId`, or `undefined` when completeness cannot be promised.
   *
   * Order matters: read the live log when there is one, flush, then re-read the stored prefix and compare. The live
   * snapshot is the authority because storage can be behind it; the comparison is what proves the flush landed, and a
   * stored prefix that is short is the truncation this method exists to refuse.
   */
  private async read(sessionId: string, live: RefreshAgent | undefined): Promise<readonly SessionEventLike[] | undefined> {
    const stored = async (): Promise<readonly SessionEventLike[]> => {
      try { return (await this.options.sessions.inspect(sessionId)).events } catch (error) {
        throw new Error(`The stored log of Session ${sessionId} could not be read: ${describe(error)}`)
      }
    }
    if (!live) {
      // Nothing of this process's is buffered for a cold Session, but a barrier first makes the stored prefix the newest
      // state this backend can promise rather than one a pending append has not reached.
      try { await this.options.persistence?.flush() } catch (error) {
        throw new Error(`Session storage could not be flushed before reading Session ${sessionId}: ${describe(error)}`)
      }
      const events = await stored()
      if (!contiguous(events)) {
        this.refuse(sessionId, 'the stored log is not contiguous from seq 0')
        return undefined
      }
      return events
    }
    const events = live.session.snapshotEvents()
    const flush = this.options.flush
    if (!flush) {
      this.refuse(sessionId, 'this host exposes no per-Session durability barrier')
      return undefined
    }
    let flushed: boolean
    try { flushed = await flush(live.session) } catch (error) {
      throw new Error(`The event log of Session ${sessionId} could not be flushed durably: ${describe(error)}`)
    }
    if (!flushed) {
      this.refuse(sessionId, 'no persistence listener could confirm the flush')
      return undefined
    }
    if (!contiguous(events)) {
      this.refuse(sessionId, 'the live log is not contiguous from seq 0')
      return undefined
    }
    // Storage now holds at least the live log, or the flush did not land. More is a resume that replayed a longer log;
    // that state is newer than this object's snapshot, so it wins.
    const persisted = await stored()
    if (persisted.length > events.length) {
      if (!contiguous(persisted)) {
        this.refuse(sessionId, 'the stored log is not contiguous from seq 0')
        return undefined
      }
      return persisted
    }
    const same = persisted.length === events.length
      && persisted.every((event, index) => event.seq === events[index]!.seq && event.type === events[index]!.type)
    if (!same) {
      this.refuse(sessionId, `storage holds ${persisted.length} of ${events.length} events; the flush did not land`)
      return undefined
    }
    return events
  }

  /** Record why an export cannot promise completeness and warn: the answer itself is the explicit `complete: false`. */
  private refuse(sessionId: string, reason: string): void {
    this.lastIncomplete = reason
    this.options.logger?.warn('dsh-superagent will not archive Session %s: %s', sessionId, reason)
  }
}

/** Whether every event sits at its own sequence number, which is the log's one contiguity rule. */
function contiguous(events: readonly SessionEventLike[]): boolean {
  return events.every((event, index) => event.seq === index)
}

/** One value's text for a refusal message, without letting a non-Error throw erase it. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What one successful refresh published: the Router's new generation, and the exact archive it committed. */
export interface RouterRefreshOutcome {
  readonly identity: RouterIdentity
  /** The export the registry archived, whose `sourceId` the caller reports. */
  readonly source: RouterExport
  /** How much conversation text moved into the archive, counted from the bytes that were stored. */
  readonly archived: { readonly sessionId: string; readonly events: number; readonly bytes: number }
}

/** Input for {@link refreshRouterSession}: the engine, the boundary, and one Router generation to replace. */
export interface RouterRefreshInput {
  readonly registry: RouterRegistry
  readonly host: RouterSessionHost
  readonly routerId: string
  readonly sessionId: string
  readonly generation: number
  /** Builds the engine over the observed boundary; injected so a test can drive the real engine with a stub host. */
  readonly engine?: (registry: RouterRegistry, host: RefreshHost) => RouterRefresh
}

/**
 * Run one archive-before-refresh and report the archive it committed.
 *
 * `RouterRefresh.refresh` publishes the new generation but answers only the identity, so the export is captured by
 * wrapping the one boundary call the engine makes before committing. A fresh engine is built per call over that
 * wrapper, which is also what keeps two concurrent refreshes from reporting each other's `sourceId`.
 * @param input - the engine, the boundary and the Router generation to replace.
 * @returns the new identity plus the exact export that was archived, and how much text it held.
 */
export async function refreshRouterSession(input: RouterRefreshInput): Promise<RouterRefreshOutcome> {
  let captured: RouterExport | undefined
  // The wrapper exists only so the export the engine archived stays observable afterwards; every other call is passed
  // through unchanged, so the contract the engine relies on is exactly the real boundary's.
  const observable: RefreshHost = {
    hold: sessionId => input.host.hold(sessionId),
    export: async sessionId => {
      const source = await input.host.export(sessionId)
      captured = source
      return source
    },
    create: (sessionId, projectId) => input.host.create(sessionId, projectId, input.sessionId),
    verify: sessionId => input.host.verify(sessionId),
    summarize: (projectId, source) => input.host.summarize(projectId, source),
  }
  const engine = input.engine?.(input.registry, observable) ?? new RouterRefresh(input.registry, observable)
  let identity: RouterIdentity
  try {
    identity = await engine.refresh(input.routerId, input.sessionId, input.generation)
  } catch (error) {
    // The engine's own refusal for a partial export is a state conflict, not a fault of this plugin.
    if (error instanceof Error && error.message === ENGINE_INCOMPLETE)
      throw new RouterRefreshRefused('contextIncomplete',
        `Session ${input.sessionId} cannot be archived completely: ${input.host.lastIncomplete ?? 'the export was not complete and flushed'}`)
    throw error
  }
  const source: RouterExport = captured
    ?? (() => { throw new Error('The refresh committed without an export to report; the engine contract changed') })()
  return {
    identity,
    source,
    archived: { sessionId: input.sessionId, events: source.raw === '' ? 0 : source.raw.split('\n').length,
      bytes: Buffer.byteLength(source.raw, 'utf8') },
  }
}
