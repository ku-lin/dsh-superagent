/**
 * Router-level Session selection: which stored Sessions the virtual Router workspace lists.
 *
 * Membership is "the conversation itself ran the router preset", read from the durable Session header and never from
 * the `agentPreset` projection. DSH projects the Agent Preset registry's last selection, and the shipped 常驻
 * conversation reads `standard` there while its header still says `dsh-superagent-router` (measured on this machine).
 * A header is immutable, so the selection survives restarts, resumes, and a DSH upgrade that keeps the format.
 *
 * Derived Sessions are excluded on purpose: a subagent spawned from a router conversation runs `standard` and belongs
 * to whatever it is working on, so listing it here would make the group "conversations the router produced" instead of
 * "router-level conversations". Executor Sessions are excluded for the same reason.
 *
 * The module holds no Context and no I/O: the host joins headers with its Session list, and a unit test drives the
 * selection directly.
 * @module dsh-superagent/src/app/router-sessions
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** Preset the main Session runs; the bundle's patch defines it. */
export const ROUTER_PRESET = 'dsh-superagent-router'
/** Preset an Executor Session runs. Work is not routing, so the virtual workspace never lists one. */
export const WORKER_PRESET = 'dsh-superagent-worker'
/** Id prefix a worker Session is created with since workers became ordinary Sessions. */
const WORKER_PREFIX = 'worker-'

/** One row of the virtual Router workspace: one conversation that itself ran the router preset. */
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

/** The row's conversation title from whichever seat the host filled, trimmed; undefined when it carries none. */
function titleOf(summary: SessionSummary | undefined): string | undefined {
  if (summary === undefined) return undefined
  const titled = summary as Titled
  for (const candidate of [titled.title, titled.projectionValues?.title, titled.projections?.values?.title]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/** Whether a header is an Executor Session: the worker preset, or the id prefix a worker is created with. */
function isWorker(header: SessionHeader): boolean {
  return header.agentPreset === WORKER_PRESET || header.id.startsWith(WORKER_PREFIX)
}

/** Whether a header belongs to a Session a router conversation spawned rather than a router conversation itself. */
function isDerived(header: SessionHeader): boolean {
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/**
 * Select the Sessions the virtual Router workspace lists: the conversations whose own header ran the router preset.
 * @param headers - every stored Session header; the durable authority for the preset and lineage.
 * @param summaries - the host's Session list, joined for title, recency and running state; a member it omits still lists
 *   from its header.
 * @param masterId - the permanent Router conversation, which lists first even when it is the oldest.
 * @returns router conversations, newest first, with the permanent one leading.
 */
export function selectRouterSessions(headers: readonly SessionHeader[], summaries: readonly SessionSummary[],
  masterId?: string): RouterSessionRow[] {
  const byId = new Map(summaries.map(summary => [summary.sessionId as string, summary]))
  // Only the conversation itself counts: a Session the router spawned runs `standard` and works somewhere else.
  const routers = headers.filter(header => header.agentPreset === ROUTER_PRESET
    && !isDerived(header) && !isWorker(header))
  const row = (header: SessionHeader): RouterSessionRow => {
    const summary = byId.get(header.id)
    const title = titleOf(summary)
    const cwd = header.cwd ?? summary?.cwd
    return { sessionId: header.id, ...title === undefined ? {} : { title }, ...cwd === undefined ? {} : { cwd },
      updatedAt: summary?.updatedAt ?? header.createdAt, running: summary?.running ?? false,
      agentAvailable: summary?.agentAvailable ?? false }
  }
  return routers.map(row).sort((a, b) =>
    a.sessionId === masterId ? -1 : b.sessionId === masterId ? 1 : b.updatedAt - a.updatedAt
      || a.sessionId.localeCompare(b.sessionId))
}
