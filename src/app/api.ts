/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DeleteReport, RouterSwitch } from './control.ts'
import type { FailureKind, FailureRecord } from './failures.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { RouterSessionRow } from './router-sessions.ts'
import type { PromptsView, StateView, TicketPageView, ManagedRouterKnowledgeView } from './http.ts'
import type { TasksView } from './tasks.ts'
import type { RouterIdentity } from './router-registry.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'
/** The `GET worker/failures` answer: the newest records first, and how many the filter matched in all. */
export interface FailureListView { items: FailureRecord[]; total: number }
/** What an external process sends to `POST worker/failure`; only `detail` is always known. */
export interface FailureRequest {
  kind?: FailureKind
  ticket?: string
  session?: string
  detail: string
  exitCode?: number
  source?: 'api' | 'executor' | 'session'
}
/** The route's answer: the stored record, or the fact that the window suppressed a repeat. */
export type FailureReport = { recorded: true; failure: FailureRecord } | { recorded: false; duplicate: true }

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  /** Read-only DSH catalog. `title` is the conversation title the host projects; leasedToTicketId marks the exclusive lease reserved by a ticket (including one that can reopen). */
  'GET dsh-sessions': { response: { items: (SessionSummary & { title?: string; leasedToTicketId?: string; ticketTitle?: string; borrowable: boolean })[] } }
  /**
   * Router-level Sessions only: every stored Session whose header ran the router preset, plus its direct children, and
   * the permanent conversation's id. This is the virtual Router workspace's whole data source, so it selects on the
   * durable header rather than the `agentPreset` projection (which reads `standard` for a Session created before the
   * preset registry composed it).
   */
  'GET router-sessions': { response: { masterId: string; items: RouterSessionRow[] } }
  /** The permanent router conversation: its last exchanges, and the route that speaks into it. `queued` marks a message a
   * stopped Router holds instead of delivering. */
  'GET router-chat': { query?: { limit?: number }; response: { sessionId: string; items: { role: 'user' | 'assistant'; text: string; dispatched: string[] }[] } }
  'POST router-chat': { body: { text: string }; response: { sent: true; queued?: true } }
  /** Stop the Router: its conversation keeps its history, and further messages wait in the queue. Tickets keep running. */
  'POST router/stop': { body: { reason?: string }; response: RouterSwitch }
  /** Start the Router again: the held messages are handed over in arrival order. */
  'POST router/start': { response: RouterSwitch }
  /** Delete one worker or router-level conversation; the permanent Router conversation and other people's are refused. */
  'DELETE sessions/:id': { query?: { confirm?: string }; response: DeleteReport }
  /** Subagent-origin conversations this deployment still holds; the manual cleanup list, never an automatic sweep. */
  'GET delegated-sessions': { response: { items: { sessionId: string; updatedAt: number; running: boolean; title?: string }[]; total: number } }
  'GET router-events': { response: { counts: { type: string; count: number }[] } }
  'GET router-event-sample': { query?: { type?: string }; response: { found: string | null } }
  /**
   * Read-only Taskboard rows for the Router's task-list panel: every project with its unfinished tasks, or one project
   * when `project` names its key. The board belongs to the Taskboard plugin; this route opens it read-only and answers
   * `available: false` with a sentence when it cannot (a board that does not exist yet is not an error).
   */
  'GET tasks': { query?: { project?: string }; response: TasksView }
  /**
   * The ordered log of failures a fixed code path recorded (a worker that ended in an error, a turn whose reason was
   * `error`, a disposed worker with a running assignment, a `failed`/`blocked` report, a prepare timeout, a shell job's
   * non-zero exit, a failed launch). Newest first; `total` counts every record the filter matched.
   */
  'GET worker/failures': { query?: { ticket?: string; kind?: FailureKind; limit?: number }; response: FailureListView }
  /**
   * Report one failure from outside this process, so a wrapper that sees a worker die records it without a model in
   * the loop. Same-origin fenced like every other write; a repeat inside the sixty-second window answers
   * `{ recorded: false, duplicate: true }` instead of failing.
   */
  'POST worker/failure': { body: FailureRequest; response: FailureReport }
  /** Read-only list of configured plugin market sources; no network fetch. */
  'GET plugin-indexes': { response: { available: boolean; items: { url: string; title?: string | Record<string, string>; error?: string }[] } }
  /** Explicit read-only search of one configured plugin market source; never installs. */
  'GET plugin-search': { query?: { url?: string; text?: string }; response: { entries: { name: string; title?: string | Record<string, string>; description?: string | Record<string, string>; version?: string; installation?: string }[]; total: number; nextOffset: number | null } }
  /** Opt in before assignment launch. Same binding is idempotent; busy, unavailable and worker-owned Sessions cannot be loaned. */
  'POST tickets/:id/worker-session': { body: { sessionId: string }; response: { ticketId: string; sessionId: string; boundAt: string; unchanged: boolean } }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
/**
 * The managed-Router knowledge routes, kept out of `Api` because that map is the panel's own route table: the web panel
 * does not render these (no client code in this change), and a total map would force every panel fixture to answer routes
 * no view calls. They are still same-origin management routes, typed here so a caller (a test, a script, or a later
 * panel route) reads the exact shape the host answers.
 *
 * Every identity is explicit. `projectId` is matched against the Taskboard's stable project id — never a display name,
 * the project key, or a Session's working directory — and `sessionId` on the read is the caller's own Session, checked
 * against the Router's current generation by the registry.
 */
export interface ManagedRouterApi {
  /**
   * The Routers this host manages: one row per explicit Router/Project/Session binding. Read-only; `total` counts every
   * binding, not a page. A host that composed no registry answers 503.
   */
  'GET managed-routers': { response: { items: { identity: RouterIdentity }[]; total: number } }
  /**
   * Bind a Router to a project and its first Session. The project must exist on the Taskboard (matched by stable id); an
   * unknown project is a 404, an unreadable board a 503. Repeating the same triple is idempotent and answers
   * `created: false`; a conflicting triple, or a Session another Router generation already holds, is a 409.
   */
  'POST managed-routers': {
    body: { routerId: string; projectId: string; sessionId: string }
    response: { identity: RouterIdentity; created: boolean }
  }
  /**
   * One managed Router's project snapshot plus the single-use receipt a durable operation must present. `sessionId` is
   * required: the registry verifies it is the Router's current generation, so a stale Session is a 409 instead of a read.
   * `snapshot.revision` always equals `receipt.revision` (the route retries once and then answers 409 rather than return
   * a receipt that cannot be used). A refresh in preparation, and an unbound Router, are 409s too; `params.sessionId`
   * missing is a 400.
   */
  'GET managed-routers/:routerId/knowledge': {
    query: { sessionId: string }
    response: ManagedRouterKnowledgeView
  }
  /**
   * Replace one Router's current Session with a fresh one, archiving the old log byte-exact first. `generation` is the
   * generation the caller read: stating it is what makes a retried or stale request a 409 instead of a refresh of a
   * conversation the caller never saw. `sourceId` is the deterministic identity of the archived prefix (a SHA-256 over
   * the exact JSON-lines text plus the event count, the first/last sequence number and the byte length), so a caller can
   * prove afterwards that the archive it reports is the one this refresh committed.
   *
   * Refusals are 409s and name what to do first — a running or undrained Session, an export that cannot be proven
   * complete and flushed, a Router already preparing, and no Workspace for the replacement — while `generation` that is
   * not a positive integer, or a missing `sessionId`, is a 400. An unexpected fault is a 500 and leaves the old Session,
   * its history and its pointer untouched. Success publishes the `router` stream topic.
   */
  'POST managed-routers/:routerId/refresh': {
    body: { sessionId: string; generation: number }
    response: {
      identity: RouterIdentity
      /** How much conversation text moved into the archive: the Session it came from, its event count, and its bytes. */
      archived: { sessionId: string; events: number; bytes: number }
      sourceId: string
    }
  }
}
/** A managed-Router route name, for callers that dispatch by name rather than through the panel's `Api`. */
export type ManagedRouterRoute = keyof ManagedRouterApi
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api | keyof ManagedRouterApi> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
