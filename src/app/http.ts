/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ManagedRouterApi, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import { latestAssignment, liveTicket } from '../core/index.ts'
import type { RouterSessionRow } from './router-sessions.ts'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import type { Control } from './control.ts'
import { ControlError } from './control.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { lockPath, type LockRefusal } from './state-lock.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { FAILURE_KINDS, type FailureKind, type FailureLog, type FailureSource } from './failures.ts'
import type { StreamHub } from './stream.ts'
import type { TasksView } from './tasks.ts'
import { KnowledgeConflict, type KnowledgeReceipt, type KnowledgeSnapshot, type ProjectKnowledge } from './project-knowledge.ts'
import type { RouterIdentity, RouterRegistry } from './router-registry.ts'
import type { RouterRefreshOutcome } from './router-session-host.ts'
import { RouterRefreshRefused } from './router-session-host.ts'

export interface HttpHost {
  readonly store: Store
  /** Read-only DSH catalog; resolving a selected agent does not initialize a worker preset. */
  listDshSessions(): Promise<readonly SessionSummary[]>
  /** Router-level Sessions only, from the durable headers: the virtual Router workspace's whole data source. */
  routerSessions(): Promise<{ masterId: string; items: RouterSessionRow[] }>
  /** The router conversation's last exchanges (newest last). */
  routerChat(limit: number): Promise<{ sessionId: string; items: { role: 'user' | 'assistant'; text: string; dispatched: string[] }[] }>
  /** Delivers one message into the router conversation. */
  routerSend(text: string): Promise<{ sent: true }>
  /** True when no Source is enabled: nothing can open a Ticket, but the Router still works. */
  sourceless(): boolean
  /** Counts of the router transcript's event types (diagnostics for the chat view). */
  routerEventTypes(): Promise<{ counts: { type: string; count: number }[] }>
  /** One transcript event of a kind, verbatim (diagnostics for the chat view). */
  routerEventSample(type: string): Promise<{ found: string | null }>
  /** Optional read-only market service, resolved by the hosting DSH context. */
  pluginMarket?: { listIndexes(): { url: string; title?: string | Record<string, string>; error?: string }[]; search(url: string, query: { text: string; sort: { kind: 'relevance' }; offset: number; limit: number }): Promise<{ entries: readonly { name: string; title?: string | Record<string, string>; description?: string | Record<string, string>; defaultVersion?: string; installation: { status: string } }[]; total: number; nextOffset: number | null }> }
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount' | 'bindingInProgress'>
  /** The Router switch and the deletion of the conversations this plugin owns (`HTTP` route `router/*`, `sessions/:id`). */
  readonly control: Control
  /** Read-only Taskboard rows for the Router's task-list panel; never writes the board. */
  readonly tasks: { read(project?: string): TasksView }
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
  /** The panel's live channel: the change bus, the failure log, and the SSE route that holds a response open. */
  readonly stream: StreamHub
  readonly failures: FailureLog
  /**
   * The managed-Router binding and project-knowledge services. Optional on purpose: a host that composes neither (the
   * HTTP fixtures, or a runtime waiting for another process's state directory lock) still serves every other route, and
   * the three managed routes answer that the feature is absent instead of throwing during registration.
   */
  readonly managed?: ManagedRouters
}
/**
 * The durable services behind `managed-routers/*`: the registry owns the explicit Router/Project/Session binding and
 * the archive-before-refresh, project knowledge reads the snapshot row the receipt pins, and `refresh` runs one
 * archive-before-refresh through the DSH Session boundary. All are read through their published methods only.
 */
export interface ManagedRouters {
  readonly registry: Pick<RouterRegistry, 'get' | 'list' | 'register' | 'read'>
  readonly knowledge: Pick<ProjectKnowledge, 'snapshot' | 'versions'>
  /**
   * Replace the Router's current Session with a fresh one, archiving the complete old log first. Not part of
   * {@link ManagedRouters} as a required member for the same reason the registry reads are `Pick`s: a fixture states
   * exactly what it serves, and a host without the boundary answers that the operation is unavailable.
   */
  refresh?(routerId: string, sessionId: string, generation: number): Promise<RouterRefreshOutcome>
}
/**
 * What `GET managed-routers/:routerId/knowledge` answers: the identity that authorized the read (including the
 * generation the caller's Session must still hold), the snapshot at the receipt's revision, and the single-use receipt
 * an operation must present. The receipt is minted by the registry read, so a caller cannot supply its own.
 */
export interface ManagedRouterKnowledgeView {
  identity: RouterIdentity
  snapshot: KnowledgeSnapshot
  receipt: KnowledgeReceipt
  /** Every state summary this project committed, newest first, each naming the archive it came from. */
  versions?: { revision: number; summary: string; sourceId: string; routerId: string; createdAt: string }[]
}
/**
 * Represents a client-facing 400, 404, 409 or 503 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed, target records are missing or in conflict, or an optional
 * host service is not composed; registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof ControlError) return [error.status, { error: error.message, code: error.code }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  // A binding or receipt conflict is a state conflict the caller can resolve by re-reading, never a server fault.
  if (error instanceof KnowledgeConflict) return [409, { error: error.message }]
  // A refused refresh names what a caller must do first (drain the Session, retry once the export can be complete);
  // it is a conflict with the current state, not a fault of this plugin, so it never answers 500.
  if (error instanceof RouterRefreshRefused) return [error.status, { error: error.message, code: error.code }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/**
 * The failure log as `GET worker/failures` answers it: newest first, optionally narrowed to one ticket, one kind, or
 * the recent window the panel's "异常" list shows.
 */
function failureList(runtime: HttpHost, query: Record<string, string>) {
  const { ticket, kind, limit: asked } = z.object({ ticket: z.string().optional(), kind: z.enum(FAILURE_KINDS).optional(),
    limit: z.coerce.number().int().positive().catch(50) }).parse(query)
  // A report a person just sent may not be in the log yet on a host that restarted: an empty answer is honest.
  const all = runtime.failures.list()
  const shown = all.filter(record => (ticket === undefined || record.ticketId === ticket) && (kind === undefined || record.kind === kind))
  const newest = [...shown].reverse().slice(0, Math.min(asked, 200))
  return { items: newest, total: shown.length }
}
/**
 * Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`).
 */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings(), router = runtime.control.router
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health,
    // The Router's own switch is separate from `paused`: stopping the Router never stops Tickets or their workers.
    router: { paused: router.paused, reason: router.reason, at: router.at, by: router.by } }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

/**
 * The managed-Router services, or a refusal when this host composed none (a fixture, or a runtime waiting for the state
 * directory lock). Answering 503 keeps the panel's other routes working instead of failing registration.
 */
function managedOf(runtime: HttpHost): ManagedRouters {
  if (!runtime.managed) throw new RouteError(503, 'Managed Router knowledge is unavailable on this host')
  return runtime.managed
}
/**
 * Confirms a project against the only authority this plugin has: the Taskboard's project rows, matched on the stable
 * `id` the board stores (not the human `key`, which the board itself matches case-insensitively). A board that is
 * absent, locked or unreadable proves nothing, so it is refused as unavailable rather than treated as "no project".
 */
function requireProject(runtime: HttpHost, projectId: string): void {
  const view = runtime.tasks.read()
  if (!view.available) throw new RouteError(503, `No authoritative project list: ${view.detail || view.at}`)
  if (!view.projects.some(project => project.id === projectId))
    throw new RouteError(404, `Project ${projectId} is not on the Taskboard`)
}
/** Identities a call site must state explicitly; nothing is inferred from the caller's transcript or model output. */
const ManagedRouterRequest = z.object({
  routerId: z.string().trim().min(1).max(300),
  projectId: z.string().trim().min(1).max(300),
  sessionId: z.string().trim().min(1).max(300),
}).strict()
const ManagedRouterSessionQuery = z.object({ sessionId: z.string().trim().min(1).max(300) })
/**
 * A refresh states the generation it believes the Router is on. `sessionId` is the conversation being replaced and
 * `generation` is what the caller last read, so a retried or stale request is refused by the registry instead of
 * replacing a generation the caller never saw.
 */
const ManagedRouterRefreshRequest = z.object({
  sessionId: z.string().trim().min(1).max(300),
  generation: z.number().int().positive(),
}).strict()
/**
 * Reads one Router's snapshot and receipt so the two describe the same revision.
 *
 * The registry mints the receipt inside its own transaction; the snapshot row is read through its own statement, so a
 * concurrent checkpoint of the same project can land between them. One retry covers that window, and a second miss is a
 * conflict the caller resolves by reading again rather than an answer whose receipt cannot be used. A discarded attempt
 * leaves its receipt row unconsumed, which grants nothing: `operate` refuses a receipt whose revision has moved, and no
 * caller ever sees that id.
 */
function readManagedKnowledge(services: ManagedRouters, routerId: string, sessionId: string): ManagedRouterKnowledgeView {
  for (let attempt = 0; ; attempt++) {
    const read = services.registry.read(routerId, sessionId)
    const snapshot = services.knowledge.snapshot(read.identity.projectId)
    if (snapshot.revision === read.receipt.revision) {
      // The history travels with the read: a reader that only saw the latest summary could not tell that an earlier,
      // much larger archive had been summarized and then superseded by a later refresh.
      const versions = services.knowledge.versions?.(read.identity.projectId)
      return { identity: read.identity, snapshot, receipt: read.receipt, ...versions === undefined ? {} : { versions } }
    }
    if (attempt > 0) throw new KnowledgeConflict('Project information changed while it was read; read it again')
  }
}

/** Every route this layer serves: the panel's own `Api` plus the managed-Router knowledge routes. */
type RouteTable = Api & ManagedRouterApi
type RouteName = keyof RouteTable
interface Input<K extends RouteName> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in RouteName]: (input: Input<K>) => RouteTable[K]['response'] | Promise<RouteTable[K]['response']> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
/**
 * A failure report from an external process. Every field the alert is built from is required except the ones a
 * process genuinely may not know: the ticket and the session it was working on, and the exit code of a process that
 * was killed by a signal rather than by an exit.
 *
 * `ticket` and `session` are opaque names: a worker conversation is named `worker-<ticket>` by this plugin, but a
 * crash reporter may know only one of them, and a report that names neither is still worth recording (it is what a
 * person reads when nothing else survives).
 */
const FailureRequest = z.object({
  kind: z.enum(FAILURE_KINDS).default('crash'),
  ticket: z.string().trim().min(1).max(300).optional(),
  session: z.string().trim().min(1).max(300).optional(),
  detail: z.string().trim().min(1).max(4000),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  /** Recorded per report only when a caller states it; an external process never claims to be the executor. */
  source: z.enum(['api', 'executor', 'session']).default('api'),
}).strict()

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem, runtime.sourceless()),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    /** What the Router's task-list panel shows: the Taskboard's projects and their tasks, read-only. */
    'GET tasks': ({ query }) => runtime.tasks.read(query.project ?? ''),
    /**
     * The managed Routers this host binds, each with the Project it is bound to and the Session that is its current
     * generation. Read-only; a Router whose registration failed is absent rather than listed half-bound.
     */
    'GET managed-routers': () => {
      const { registry } = managedOf(runtime)
      const items = registry.list().map(identity => ({ identity }))
      return { items, total: items.length }
    },
    /**
     * Bind a Router to a project and its first Session. All three identities are stated by the caller; the project must
     * already exist on the Taskboard (matched by stable id), so a typo cannot create a knowledge bucket nothing owns.
     * Registering the same triple again is idempotent; a different triple for a known router (or a Session another
     * Router generation already holds) is a 409.
     */
    'POST managed-routers': async ({ body }) => {
      const { registry } = managedOf(runtime)
      const request = ManagedRouterRequest.parse(await body(16 * 1024))
      // Checked before the write so a refused project leaves no binding behind; the registry then re-checks it atomically.
      requireProject(runtime, request.projectId)
      const created = registry.get(request.routerId) === undefined
      const identity = registry.register(request.routerId, request.projectId, request.sessionId)
      return { identity, created }
    },
    /**
     * Read one managed Router's project snapshot with the receipt an operation must present. The caller's Session is a
     * required explicit parameter and the registry verifies it is the Router's current generation, so a stale worker
     * cannot read project context with a superseded identity.
     */
    'GET managed-routers/:routerId/knowledge': ({ params, query }) => {
      const { sessionId } = ManagedRouterSessionQuery.parse(query)
      return readManagedKnowledge(managedOf(runtime), params.routerId, sessionId)
    },
    /**
     * Replace one Router's current Session with a fresh one, archiving the old log byte-exact before the pointer moves.
     *
     * `generation` is required because a refresh is the one operation whose cost grows with what it replaces: a caller
     * that read the Router must state which generation it believes it holds, so a retried request cannot quietly archive
     * the wrong conversation. The answer carries the new identity, the exact archive (`sourceId`), and how much text it
     * held. A refusal is a 409 naming what to do first; a registry conflict is a 409 too; only an unexpected fault is a
     * 500, and it leaves the old Session, its history and its pointer untouched.
     *
     * The success publishes the `router` topic, because the Router group's rows are chosen from the durable headers:
     * the new generation is a new conversation, and every open panel must re-read the group.
     */
    'POST managed-routers/:routerId/refresh': async ({ params, body }) => {
      const services = managedOf(runtime)
      if (!services.refresh) throw new RouteError(503, 'Router refresh is unavailable on this host')
      const request = ManagedRouterRefreshRequest.parse(await body(16 * 1024))
      const outcome = await services.refresh(params.routerId, request.sessionId, request.generation)
      runtime.stream.publish('router')
      return { identity: outcome.identity, archived: outcome.archived, sourceId: outcome.source.sourceId }
    },
    /** The ordered log of failures a fixed code path recorded; newest last, capped by `FAILURE_LIMIT`. */
    'GET worker/failures': ({ query }) => failureList(runtime, query),
    /**
     * Report a failure from outside this process. The route is same-origin fenced like every other write, and it is
     * reached by `scripts/report-failure.mjs` so a wrapper that sees a worker die can record it without a model in the
     * loop. A suppressed duplicate answers `{ recorded: false, duplicate: true }` rather than failing.
     */
    'POST worker/failure': async ({ body }) => {
      const request = FailureRequest.parse(await body(16 * 1024))
      const record = runtime.failures.record({ kind: request.kind as FailureKind, source: request.source as FailureSource,
        detail: request.detail, ...request.ticket === undefined ? {} : { ticketId: request.ticket },
        ...request.session === undefined ? {} : { sessionId: request.session },
        ...request.exitCode === undefined ? {} : { exitCode: request.exitCode } })
      // A ticket named by a report is re-read by the panel even when the window suppressed the alert.
      runtime.stream.publish('tickets')
      return record ? { recorded: true as const, failure: record } : { recorded: false as const, duplicate: true as const }
    },
    'GET plugin-indexes': () => ({ available: !!runtime.pluginMarket, items: runtime.pluginMarket?.listIndexes() ?? [] }),
    'GET plugin-search': async ({ query }) => {
      const market = runtime.pluginMarket
      if (!market) throw new RouteError(404, 'Plugin market is unavailable')
      const url = query.url ?? ''
      if (!market.listIndexes().some(index => index.url === url)) throw new RouteError(400, 'Select a configured plugin index')
      const result = await market.search(url, { text: (query.text ?? '').slice(0, 200), sort: { kind: 'relevance' }, offset: 0, limit: 30 })
      return { entries: result.entries.map(entry => ({ name: entry.name, ...entry.title ? { title: entry.title } : {},
        ...entry.description ? { description: entry.description } : {}, version: entry.defaultVersion,
        installation: entry.installation.status })), total: result.total, nextOffset: result.nextOffset }
    },
    'GET router-events': () => runtime.routerEventTypes(),
    'GET router-event-sample': ({ query }) => runtime.routerEventSample(query.type ?? 'user/message'),
    'GET router-sessions': () => runtime.routerSessions(),
    'GET router-chat': async ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit ?? 40) || 40, 1), 200)
      return runtime.routerChat(limit)
    },
    'POST router-chat': async ({ body }) => {
      const { text } = z.object({ text: z.string().trim().min(1).max(8000) }).strict().parse(await body())
      return runtime.routerSend(text)
    },
    /** Stop the Router: its conversation keeps everything it has, and every further message waits in the durable queue. */
    'POST router/stop': async ({ body }) => {
      const { reason } = z.object({ reason: z.string().max(500).default('') }).strict().parse(await body())
      return runtime.control.stopRouter(reason, 'panel')
    },
    /** Start the Router again: what the stop held is handed over in arrival order. */
    'POST router/start': () => runtime.control.startRouter('panel'),
    /**
     * Delete one worker or router-level conversation. `confirm=true` is required; the permanent Router conversation, and
     * any conversation this plugin does not own, are refused.
     */
    'DELETE sessions/:id': async ({ params, query }) => {
      const confirm = z.enum(['true', 'false']).catch('false').parse(query.confirm) === 'true'
      return runtime.control.deleteSession(params.id, confirm, 'panel')
    },
    'GET dsh-sessions': async () => {
      const leases = new Map(store.tickets.open().flatMap(ticket => ticket.execution?.borrowedSession
        ? [[ticket.execution.borrowedSession.sessionId, ticket] as const] : []))
      // A host can hold hundreds of Sessions; the Router acts only on those it can borrow, already leases, or sees running.
      const shown = (await runtime.listDshSessions()).map(session => {
        const lease = leases.get(session.sessionId)
        // The host list may carry the title itself or as a `title` projection value; the panel shows the title, never the id.
        const titled = session as typeof session & { title?: string; projectionValues?: { title?: string } }
        const title = titled.title ?? titled.projectionValues?.title
        return { ...session, ...(title ? { title } : {}), leased: !!lease,
          borrowable: session.agentAvailable && !session.running && session.origin !== 'subagent'
            && session.sessionId !== runtime.masterId && !session.sessionId.startsWith('worker-')
            && !lease }
      }).filter(session => session.borrowable || session.leased || session.running || session.sessionId.startsWith('worker-'))
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30)
      return { items: shown.map(({ leased: _leased, ...session }) => {
        const lease = leases.get(session.sessionId)
        return lease ? { ...session, leasedToTicketId: lease.id, ticketTitle: lease.title } : session
      }) }
    },
    /**
     * Conversations this deployment holds that were spawned as subagents rather than routed.
     *
     * Read-only on purpose: the list exists so a person can remove a delegation that left the ticket pipeline, one
     * conversation at a time, through the ordinary delete contract. Nothing here archives, deletes or rewrites
     * anything; a Router that never delegates again stops adding rows, and the historical ones stay exactly as they are
     * until somebody decides about each.
     */
    'GET delegated-sessions': async () => {
      const sessions = await runtime.listDshSessions()
      const owned = await Promise.all(sessions.filter(session => session.origin === 'subagent')
        .map(async session => await runtime.control.sessionKind(session.sessionId) === 'delegated' ? session : undefined))
      const items = owned.filter((session): session is NonNullable<typeof session> => session !== undefined).map(session => {
        const titled = session as typeof session & { title?: string; projectionValues?: { title?: string } }
        const title = titled.title ?? titled.projectionValues?.title
        return { sessionId: session.sessionId, updatedAt: session.updatedAt, running: session.running,
          ...title ? { title } : {} }
      }).sort((a, b) => b.updatedAt - a.updatedAt)
      return { items, total: items.length }
    },
    'POST tickets/:id/worker-session': async ({ params, body }) => {
      const { sessionId } = z.object({ sessionId: z.string().min(1).max(300) }).strict().parse(await body())
      const existing = store.tickets.get(params.id)
      if (!existing) throw new RouteError(404, 'Ticket not found')
      const previous = existing.execution?.borrowedSession
      if (previous?.sessionId === sessionId) return { ticketId: params.id, sessionId, boundAt: previous.boundAt, unchanged: true }
      const available = await runtime.listDshSessions()
      const session = available.find(item => item.sessionId === sessionId)
      if (!session || !session.agentAvailable || session.running || session.origin === 'subagent'
        || sessionId === runtime.masterId || sessionId.startsWith('worker-'))
        throw new RouteError(404, 'Borrowable DSH Session not found')
      return store.atomic(() => {
        const current = store.tickets.get(params.id)
        if (!current) throw new RouteError(404, 'Ticket not found')
        const bound = current.execution?.borrowedSession
        if (bound?.sessionId === sessionId) return { ticketId: params.id, sessionId, boundAt: bound.boundAt, unchanged: true }
        if (!liveTicket(current) || !current.execution || latestAssignment(current)?.state !== 'pending'
          || current.assignments.some(item => !!item.startedAt) || bound
          || runtime.executor.bindingInProgress(params.id))
          throw new RouteError(409, 'Ticket worker binding requires an unstarted assignment without a prior loan')
        if (store.tickets.open().some(ticket => ticket.id !== params.id && ticket.execution?.borrowedSession?.sessionId === sessionId))
          throw new RouteError(409, 'DSH Session is already leased to another open ticket')
        const boundAt = new Date().toISOString()
        store.tickets.save({ ...current, execution: { ...current.execution, borrowedSession: { sessionId, boundAt } } })
        return { ticketId: params.id, sessionId, boundAt, unchanged: false }
      })
    },
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<RouteName>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
/**
 * Register the panel's live channel as its own exact route.
 *
 * It is kept out of {@link registerHttp} on purpose. The JSON routes answer and end; this one takes ownership of the
 * response and holds it, which is a different contract, and an exact path wins over the `/orchestrator` prefix without
 * reordering anything. Registering it separately also means a host that refuses the second route (an occupied path, or
 * a web server double in a test) loses only the live channel: the panel falls back to its manual refresh, and every
 * management route keeps working.
 * @returns the disposer that unmounts the route.
 */
export function registerStream(ctx: Context, runtime: Pick<HttpHost, 'stream'>): () => void {
  return ctx.webServer.register({ kind: 'exact', path: '/orchestrator/api/stream', handler: (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') { json(res, 405, { error: 'The change stream is read with GET' }); return }
    if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
    // A response that cannot hold a stream is answered, never thrown out of: the panel then shows 已断开 with its
    // manual refresh, which is the same state a dropped connection produces.
    if (!runtime.stream.attach(req, res)) json(res, 503, { error: 'This host cannot hold a change stream' })
  } })
}
/** What a process waiting for the state directory's lock answers with: the lock it could not take and the health it reports. */
export interface LockWaitView {
  readonly refusal: LockRefusal
  readonly machine: Machine
  health(): Record<string, Health>
}
/**
 * Serves the management API while another process holds the state directory. Every request answers 503 with the
 * `runtime` health entry and the lock's holder trace, so the panel says why it is stopped instead of showing the 404s
 * of routes that were never mounted.
 */
export function registerLockWaitHttp(ctx: Context, wait: LockWaitView): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  // Read per request: the health board keeps the sentence, and how long the lock has been held changes while it lasts.
  const waiting = () => {
    const health = wait.health()
    const runtime = health['runtime']
    return {
      error: runtime?.detail || `dsh-superagent is waiting for the state directory lock ${lockPath(wait.machine.stateDir)}`,
      code: runtime?.code ?? 'lockWait',
      lock: { path: lockPath(wait.machine.stateDir), attempts: wait.refusal.attempts, waitedMs: wait.refusal.waitedMs,
        holder: wait.refusal.holder ?? null },
      health,
    }
  }
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      json(res, 503, waiting())
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
