/**
 * Router-level Session selection: which stored Sessions the virtual Router workspace lists.
 *
 * Membership is read from the durable Session header, never from the `agentPreset` projection. DSH projects the Agent
 * Preset registry's last selection, and the shipped 常驻 conversation reads `standard` there while its header still says
 * `dsh-superagent-router` (measured on this machine). A header is immutable, so the selection survives restarts,
 * resumes, and a DSH upgrade that keeps the format.
 *
 * Exactly one kind of conversation belongs to the router: a router-level conversation, whose own header ran the router
 * preset. The Executor Sessions the router creates are ordinary Sessions inside the ticket's Workspace, and the person
 * asked for them to stay there — a worker is listed in the Workspace it works in, not in the Router's group. The group is
 * the router's own list, so a worker row never enters it (whatever its preset, id prefix or projected title says).
 *
 * Derived Sessions are excluded on purpose: a subagent spawned from a router or worker conversation runs `standard` and
 * belongs to whatever it is working on, so listing it here would make the group "conversations the router produced"
 * instead of "the router's own conversations". Every other conversation — and every other agent's — stays out.
 *
 * The module holds no Context and no I/O: the host joins headers with its Session list, and a unit test drives the
 * selection directly.
 * @module dsh-superagent/src/app/router-sessions
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** Preset the main Session runs; the bundle's patch defines it. */
export const ROUTER_PRESET = 'dsh-superagent-router'
/** Preset an Executor Session runs. Exported because the Executor creates workers with it; the group does not select on it. */
export const WORKER_PRESET = 'dsh-superagent-worker'

/** One row of the virtual Router workspace: one of the router's own conversations. */
export interface RouterSessionRow {
  readonly sessionId: string
  /** Projected conversation title; absent until DSH projects one. */
  readonly title?: string
  /** Working directory the Session was created in, when its header records one. */
  readonly cwd?: string
  /** Epoch milliseconds of the last mutation; header creation time when the list omits the Session. */
  readonly updatedAt: number
  readonly running: boolean
  readonly agentAvailable: boolean
  /**
   * Whether this conversation already lives in the Router's own Workspace, so the sidebar lists it there natively.
   *
   * A Router created before that Workspace existed keeps the deployment checkout as its `cwd`, and a Workspace accounts
   * only for a Session whose stored `cwd` equals its own `path`; DSH refuses to attach one to the other. Those rows are
   * still Router conversations, so the group lists them and the client hides their duplicate row. A row that is already
   * at home needs no such hiding, and saying so is what lets the group stop injecting a rule for it.
   */
  readonly atHome: boolean
}

/**
 * List-row metadata DSH may carry under either spelling. Read through one accessor so a host that moves the title
 * between `title`, `projectionValues.title` and `projections.values.title` cannot hide a conversation.
 */
type Titled = SessionSummary & {
  readonly title?: unknown
  readonly projectionValues?: { readonly title?: unknown }
  readonly projections?: { readonly values?: { readonly title?: unknown } }
}

/**
 * The row's conversation title from whichever seat the host filled, trimmed; undefined when it carries none.
 *
 * Exported so a second reader of the same host rows (the client's transcript linkifier, which also reads the management
 * catalog) uses the one spelling the host actually fills instead of guessing at it.
 */
export function sessionTitle(summary: SessionSummary | undefined): string | undefined {
  if (summary === undefined) return undefined
  const titled = summary as Titled
  for (const candidate of [titled.title, titled.projectionValues?.title, titled.projections?.values?.title]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/** Whether the header is a router-level conversation: the conversation itself ran the router preset. */
function isRouter(header: SessionHeader): boolean {
  return header.agentPreset === ROUTER_PRESET
}

/** Whether a header belongs to a Session a router or worker conversation spawned rather than one of those itself. */
function isDerived(header: SessionHeader): boolean {
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/** Newest first, with a stable tie-break so two rows updated in the same millisecond never swap between polls. */
const newestFirst = (a: RouterSessionRow, b: RouterSessionRow): number =>
  b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId)

/**
 * One directory spelling, for comparing a Session's `cwd` with the Router's Workspace `path`.
 *
 * The registry compares resolved paths, so the two spellings a person or a host may produce for one directory — either
 * separator, a trailing one, or a different case on Windows — must compare equal here too; anything else would report a
 * Router as living elsewhere and leave a duplicate row hidden for no reason.
 */
const place = (path: string): string => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()

/**
 * Select the Sessions the virtual Router workspace lists: the router's own conversations.
 * @param headers - every stored Session header; the durable authority for the preset and lineage.
 * @param summaries - the host's Session list, joined for title, recency and running state; a member it omits still lists
 *   from its header.
 * @param masterId - the permanent Router conversation, which lists first even when it is the oldest.
 * @param homeDirectory - the Router's own Workspace directory, compared with each Session's stored `cwd`; omit it and
 *   every row reports `atHome: false`, which is the safe answer for a deployment whose Router predates that Workspace.
 * @returns the router's conversations — the permanent one first, then the rest newest first.
 */
export function selectRouterSessions(headers: readonly SessionHeader[], summaries: readonly SessionSummary[],
  masterId?: string, homeDirectory?: string): RouterSessionRow[] {
  const byId = new Map(summaries.map(summary => [summary.sessionId as string, summary]))
  const home = homeDirectory === undefined ? undefined : homeDirectory.toLowerCase()
  const row = (header: SessionHeader): RouterSessionRow => {
    const summary = byId.get(header.id)
    const title = sessionTitle(summary)
    const cwd = header.cwd ?? summary?.cwd
    // Compared the way the registry compares them, so a trailing separator, a letter's case or a separator spelling
    // cannot report a Router as being at home when DSH itself would refuse to attach it.
    const atHome = home !== undefined && cwd !== undefined && place(cwd) === place(home)
    return { sessionId: header.id, ...title === undefined ? {} : { title }, ...cwd === undefined ? {} : { cwd }, atHome,
      updatedAt: summary?.updatedAt ?? header.createdAt, running: summary?.running ?? false,
      agentAvailable: summary?.agentAvailable ?? false }
  }
  // Only the conversations themselves count, and only those the router itself ran: a Session a router or worker spawned
  // works somewhere else, and a worker works in the Workspace the person sees it in.
  const ordered = headers.filter(header => !isDerived(header) && isRouter(header)).map(row).sort(newestFirst)
  // The permanent conversation leads; the stable sort leaves the rest's own order untouched.
  return masterId === undefined ? ordered : ordered.sort((a, b) =>
    a.sessionId === masterId ? -1 : b.sessionId === masterId ? 1 : 0)
}
