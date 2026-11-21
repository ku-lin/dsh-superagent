/**
 * Operator control over the Router conversation: the stop/start switch, the audit trail of panel and tool writes, and the
 * deletion of the conversations this plugin owns.
 *
 * The switch suspends the Router without touching its history. Nothing in DSH can hold a Session's *turn* so that its
 * input survives — a rejected step consumes what it claimed — so the switch holds the *deliveries* instead: every message
 * bound for the Router conversation waits in the durable effect queue and is handed over once the Router starts again.
 * A message is therefore never lost and never reordered, and the Router simply has nothing to work on while stopped.
 *
 * What the switch deliberately does not touch is `settings.paused`: that gate is the Executor's, and stopping the Router
 * must leave running Tickets alone (they keep launching and delivering).
 * @module dsh-superagent/src/app/control
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ROUTER_PRESET } from './router-sessions.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

/** Who asked for a control write: the management panel, or a model through one of the `orchestrator_router_*` tools. */
export type ControlOrigin = 'panel' | 'tool'
/** The persisted Router switch. `at` and `reason` explain a stop, and stay after a start as the last transition. */
export interface RouterSwitch {
  readonly paused: boolean
  /** Why the Router was stopped, in the operator's words; empty for a start that follows nothing. */
  readonly reason: string
  readonly at: string
  readonly by: ControlOrigin
}
/** One audited write: what changed, when, by which origin, and whether it took effect. */
export interface AuditEntry {
  readonly at: string
  /** The operation, such as `router.stop`, `router.start` or `session.delete`. */
  readonly action: string
  /** The conversation or setting acted on. */
  readonly target?: string
  readonly by: ControlOrigin
  readonly ok: boolean
  readonly note?: string
}
/** How many audit entries the store keeps; older ones are dropped first. */
export const AUDIT_LIMIT = 200
const now = (): string => new Date().toISOString()
/** The switch as stored, or the implicit "never stopped" default. */
export function routerSwitch(store: Pick<Store, 'get'>): RouterSwitch {
  return store.get(KV.runtime.router) ?? { paused: false, reason: '', at: '', by: 'panel' }
}
/** Whether the Router is currently stopped. */
export function routerStopped(store: Pick<Store, 'get'>): boolean { return routerSwitch(store).paused }
/** The audit trail, newest last. */
export function auditTrail(store: Pick<Store, 'get'>): readonly AuditEntry[] { return store.get(KV.runtime.audit) ?? [] }
/** Appends one entry, keeping the newest {@link AUDIT_LIMIT}. Call inside `Store.atomic` with the write it records. */
export function audit(store: Pick<Store, 'get' | 'set'>, entry: Omit<AuditEntry, 'at'>): void {
  store.set(KV.runtime.audit, [...auditTrail(store), { at: now(), ...entry }].slice(-AUDIT_LIMIT))
}

/** Why a stop or start was refused, as a code the panel localizes plus the values it names. */
export class ControlError extends Error {
  constructor(readonly code: 'alreadyStopped' | 'alreadyRunning' | 'notDeletable' | 'routerSession' | 'unknownSession' | 'confirmRequired'
    | 'deleteFailed', message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}

/**
 * The control surface `Runtime` composes: the Router switch (persisted, and consulted by every delivery into the Router
 * conversation) and deletion of the conversations this plugin owns.
 */
export class Control {
  constructor(private readonly host: ControlHost) {}
  /** The switch as stored. */
  get router(): RouterSwitch { return routerSwitch(this.host.store) }
  /** Whether deliveries into the Router conversation are held. */
  get stopped(): boolean { return this.router.paused }
  /**
   * Stop the Router: deliveries bound for its conversation wait in the durable queue instead of being handed over.
   * Tickets and their workers are untouched, and the conversation keeps its history and its identity.
   * @param reason - why, in the operator's words; shown by `GET state`.
   * @param by - who asked, recorded in the audit trail.
   */
  stopRouter(reason: string, by: ControlOrigin): RouterSwitch {
    const current = this.router
    if (current.paused) throw new ControlError('alreadyStopped', 'The Router is already stopped', 409)
    const next: RouterSwitch = { paused: true, reason: reason.trim().slice(0, 500), at: now(), by }
    this.host.store.atomic(() => {
      this.host.store.set(KV.runtime.router, next)
      audit(this.host.store, { action: 'router.stop', by, ok: true, ...next.reason ? { note: next.reason } : {} })
    })
    // Queued deliveries stay queued; the executor's own gate is untouched, so running Tickets keep working.
    this.host.requestPass()
    return next
  }
  /**
   * Start the Router again: the held deliveries are handed over in the order they arrived.
   * @param by - who asked, recorded in the audit trail.
   */
  startRouter(by: ControlOrigin): RouterSwitch {
    const current = this.router
    if (!current.paused) throw new ControlError('alreadyRunning', 'The Router is already running', 409)
    const next: RouterSwitch = { paused: false, reason: '', at: now(), by }
    this.host.store.atomic(() => {
      this.host.store.set(KV.runtime.router, next)
      audit(this.host.store, { action: 'router.start', by, ok: true })
    })
    // Resume the held deliveries immediately rather than at the next pass.
    this.host.requestPass()
    return next
  }
  /**
   * Delete one conversation this plugin owns.
   *
   * Only a worker conversation (`worker-<ticketId>`) or a router-level conversation qualifies: the plugin never removes a
   * person's ordinary conversation. The permanent Router conversation refuses — deleting it would leave the panel with no
   * Router at all — and the caller must repeat the intent with `confirm`.
   *
   * Deletion is the host's own: the archived conversation stops receiving turns (the host's `agent/pre-step` gate reads
   * the archive set), is detached from every Workspace that accounted for it, and loses its projection-cache row. The
   * append-only event log is left on disk on purpose — see {@link DeleteReport.log}.
   * @param sessionId - the conversation to delete.
   * @param confirm - must be true; the API asks for it so a stray request cannot delete a conversation.
   * @param by - who asked, recorded in the audit trail.
   */
  async deleteSession(sessionId: string, confirm: boolean, by: ControlOrigin): Promise<DeleteReport> {
    if (!confirm) throw new ControlError('confirmRequired', 'Deleting a conversation requires confirm: true')
    const kind = await this.sessionKind(sessionId)
    if (kind === 'router-main') {
      audit(this.host.store, { action: 'session.delete', target: sessionId, by, ok: false, note: 'routerSession' })
      throw new ControlError('routerSession', 'The Router conversation cannot delete itself', 409)
    }
    if (kind === undefined) {
      audit(this.host.store, { action: 'session.delete', target: sessionId, by, ok: false, note: 'notDeletable' })
      throw new ControlError('notDeletable', 'Only a worker conversation or a router-level conversation can be deleted', 409)
    }
    const live = this.host.context.agents.get(sessionId as SessionId)
    // Stop the conversation's own work first: the archive gate blocks later steps, and the stop requests the running ones.
    live?.cancel({ kind: 'user' }, { keepInbox: true })
    try {
      await this.host.context.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
    } catch (error) {
      audit(this.host.store, { action: 'session.delete', target: sessionId, by, ok: false, note: String(error).slice(0, 200) })
      throw new ControlError('deleteFailed', `The host refused to delete the conversation: ${error instanceof Error ? error.message : String(error)}`, 400)
    }
    const detached: string[] = []
    const workspaces = [...this.host.context.workspaceRegistry.list()].filter(item => item.sessionIds.includes(sessionId as SessionId))
    for (const workspace of workspaces) {
      try { await workspace.detachSession(sessionId as SessionId); detached.push(workspace.title) }
      catch (error) { this.host.context.logger.warn('dsh-superagent could not detach %s from workspace %s: %s', sessionId, workspace.id, String(error)) }
    }
    const cache = await this.dropCachedProjections(sessionId)
    const log = await removeSessionLog(this.host.sessionRoot(), sessionId)
    audit(this.host.store, { action: 'session.delete', target: sessionId, by, ok: true,
      note: `${kind}; detached from ${detached.length} workspace(s); projections ${cache}; log ${log.state}` })
    return { sessionId, kind, archived: true, detached, projections: cache, log }
  }
  /**
   * Which kind of conversation `sessionId` is, or `undefined` when it is not one this plugin may delete.
   * `router-main` names the permanent Router conversation, which is refused rather than deleted.
   */
  async sessionKind(sessionId: string): Promise<'worker' | 'router' | 'router-main' | undefined> {
    if (sessionId === this.host.masterId) return 'router-main'
    if (sessionId.startsWith('worker-')) return 'worker'
    // A router-level conversation is identified by its durable header, the same authority `GET router-sessions` reads:
    // the `agentPreset` projection can read `standard` for a conversation the router preset composed.
    const stored = await this.host.context.sessionPersistence.list().catch(() => undefined)
    const header = stored?.find(item => item.header.id === sessionId)?.header
    return header?.agentPreset === ROUTER_PRESET ? 'router' : undefined
  }
  /** Drop the conversation's projection-cache row so a later conversation reusing the id cannot seed from it. */
  private async dropCachedProjections(sessionId: string): Promise<'dropped' | 'absent' | 'unavailable'> {
    try {
      // The cache declares one `sessions` table keyed by Session id; the row is a fold shortcut, never an authority.
      // Reached structurally so this plugin keeps no dependency on the cache package: a host without it reports `unavailable`.
      type Table = { get(key: string): unknown; delete(key: string): Promise<boolean> }
      const domains = this.host.context.get('storageDomain') as { get(name: string): { table(name: string): Table } | undefined } | undefined
      const domain = domains?.get('session_projcache')
      if (!domain) return 'unavailable'
      const table = domain.table('sessions')
      if (table.get(sessionId) === undefined) return 'absent'
      await table.delete(sessionId)
      return 'dropped'
    } catch (error) {
      this.host.context.logger.warn('dsh-superagent could not drop the projection cache of %s: %s', sessionId, String(error))
      return 'unavailable'
    }
  }
}
/** What a deletion actually did, so the panel and the audit trail never overstate it. */
export interface DeleteReport {
  readonly sessionId: string
  readonly kind: 'worker' | 'router'
  /** The host's archive set now hides the conversation and blocks its turns. */
  readonly archived: true
  /** Titles of the Workspaces the conversation was detached from. */
  readonly detached: readonly string[]
  readonly projections: 'dropped' | 'absent' | 'unavailable'
  /** Whether the append-only event log was removed from disk; `retained` names why it was not. */
  readonly log: SessionLogRemoval
}
/** The outcome of removing a deleted conversation's stored log. */
export type SessionLogRemoval = { readonly state: 'removed'; readonly path: string } | { readonly state: 'retained'; readonly reason: string }
  | { readonly state: 'absent' }
/** Host dependencies of `Control`. */
export interface ControlHost {
  readonly context: Context
  readonly store: Pick<Store, 'get' | 'set' | 'atomic'>
  readonly masterId: string
  /** Schedules a pass, which is what dispatches the deliveries a start released. */
  requestPass(): void
  /** The active persistence backend's session root, when it exposes one; the log is removed from it, or kept. */
  sessionRoot(): string | undefined
}

/**
 * The active session-persistence backend's log root, when it has one.
 *
 * The JSONL backend keeps `root` as a resolved directory and nothing in the DSH service contract names it, so it is read
 * off the mounted instance and never assumed: a backend without such a field (`undefined`) keeps every log, and a delete
 * then reports `retained` instead of guessing a path.
 * @param context - the host context the backend is mounted on.
 */
export function sessionRoot(context: Pick<Context, 'get'>): string | undefined {
  try {
    const backend = context.get('sessionPersistence') as { root?: unknown } | undefined
    return typeof backend?.root === 'string' && backend.root !== '' ? backend.root : undefined
  } catch { return undefined }
}

/**
 * Remove one session's stored directory under a JSONL persistence root.
 *
 * The backend groups logs as `<root>/<projectKey>/<encoded session id>`, and the project key is lossy, so the session
 * segment is matched by name instead of recomputing it. Every guard fails towards keeping the bytes: an unreadable root,
 * no match, more than one match, and a directory holding anything but session log files all report `retained`.
 * @param root - the persistence root, when the backend exposes one.
 * @param sessionId - the conversation whose directory is removed.
 */
export async function removeSessionLog(root: string | undefined, sessionId: string): Promise<SessionLogRemoval> {
  if (!root) return { state: 'retained', reason: 'the persistence backend does not expose its root' }
  const segment = encodeSegment(sessionId)
  let projects: string[]
  try { projects = await readdir(root) } catch (error) {
    return { state: 'retained', reason: `the persistence root is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const matches: string[] = []
  for (const project of projects) {
    const candidate = join(root, project, segment)
    try { if ((await stat(candidate)).isDirectory()) matches.push(candidate) } catch { /* No such conversation here. */ }
  }
  if (!matches.length) return { state: 'absent' }
  if (matches.length > 1) return { state: 'retained', reason: `${matches.length} project directories hold this session id` }
  const directory = matches[0]!
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    return { state: 'retained', reason: `the session directory is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Only a session log generation may be removed; an unexpected entry means this is not (only) a conversation's log.
  const logFile = /^session\.v\d+\.jsonl(?:\.zstd)?$/
  const foreign = names.filter(name => !logFile.test(name))
  if (foreign.length) return { state: 'retained', reason: `the session directory also holds ${foreign.slice(0, 3).join(', ')}` }
  try { await rm(directory, { recursive: true, force: true }) } catch (error) {
    return { state: 'retained', reason: `the session directory could not be removed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { state: 'removed', path: directory }
}
/**
 * The persistence backend's own path encoding for one session id: every code unit outside `[A-Za-z0-9._-]` (and `~`) is
 * written as `~XXXX`, with `.` and `..` escaped first. Mirrors `@deepseek-ai/dsh-session-persistence-jsonl` exactly, which
 * is what lets a deleted conversation's directory be found by name.
 * @param raw - the session id.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index), character = String.fromCharCode(code)
    out += character !== '~' && /^[A-Za-z0-9._-]$/.test(character) ? character : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}
