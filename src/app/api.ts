/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DeleteReport, RouterSwitch } from './control.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { RouterSessionRow } from './router-sessions.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
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
  'GET router-events': { response: { counts: { type: string; count: number }[] } }
  'GET router-event-sample': { query?: { type?: string }; response: { found: string | null } }
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
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
