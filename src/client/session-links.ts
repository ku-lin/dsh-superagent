/**
 * Worker titles in the Router's conversation become the way into that worker's conversation.
 *
 * Two seams, because DSH renders a link in two very different ways:
 *
 * 1. Its Markdown renderer hands `http(s)` links to the desktop browser and drops any other scheme, so a `dsh://session/…`
 *    link reaches the transcript as its label only. Whenever a host does render one as an anchor anyway, a capture-phase
 *    click listener (registered before any component handler runs) opens the conversation instead of navigating.
 * 2. The text the Router actually prints is the worker's own title (`worker-a1b2c3d4 · …`), which it copies from a report's
 *    `worker.link` label. This module watches the transcript for exactly those titles — the Router's own rows, plus the
 *    worker rows the management catalog lists, because a worker is no longer a member of the Router workspace group — and
 *    makes each one a button that opens that conversation.
 *
 * Both paths end in `openSession`, the same navigation the shipped sidebar rows use, so the Router's page stays in history
 * and a person returns to it with the sidebar or the browser's Back. Nothing is persisted, and any failure leaves the text
 * exactly as DSH rendered it.
 * @module dsh-superagent/src/client/session-links
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import { sessionIdOfHref } from '../app/session-link.ts'
import { sessionTitle } from '../app/router-sessions.ts'

/** The shipped conversation flow: the only region this module rewrites, so sidebar rows, the header and the composer keep
 * their own markup. `data-slot` is the browser's stable mount contract (this bundle mounts its own group the same way). */
const TRANSCRIPT = '[data-slot="conversation.chat.flow"]'
/** The attribute DSH renders a Markdown link into. */
const ANCHOR = 'a[href]'
/** A title this module turned into a button, so a later pass never re-wraps it. */
const LINK_ATTR = 'data-dsh-superagent-session'
/** How often the titles are re-read, matching the Router workspace group's own poll. */
const POLL_MS = 4000

/** One row the linkifier may match: a Session id and the title the Router prints for it. */
export interface SessionTitle {
  readonly sessionId: string
  readonly title: string
}

/** One endpoint's `items`, read for its ids and titles only; a failure rejects so the caller can keep the other source. */
async function readItems(path: string): Promise<readonly SessionSummary[]> {
  const response = await fetch(`/orchestrator/api/${path}`, { credentials: 'omit', signal: AbortSignal.timeout(8000),
    headers: { 'x-orchestrator-request': '1' } })
  if (!response.ok) throw new Error(`${path} ${response.status}`)
  const value = await response.json() as { items?: unknown }
  return Array.isArray(value.items) ? value.items as SessionSummary[] : []
}

/**
 * The titles a Router reply may print: its own conversations, and every worker Session.
 *
 * A worker is no longer a member of the virtual Router group, so its title cannot come from that group's endpoint any
 * more; the management catalog lists worker Sessions whether they run, are leased, or sit idle, and that title is exactly
 * the `worker.link` label a report carries into the transcript. Only `worker-` rows are taken from that catalog: matching
 * every conversation the catalog happens to list would turn ordinary prose into links. Both reads are joined by
 * `sessionTitle`, the same seat accessor the Router group uses, because a host row may carry its title under any of three
 * spellings.
 * @returns one title per Session whose host row carries one; a failed endpoint contributes nothing.
 */
export async function loadSessionTitles(): Promise<readonly SessionTitle[]> {
  const [router, catalog] = await Promise.allSettled([readItems('router-sessions'), readItems('dsh-sessions')])
  const items = [...router.status === 'fulfilled' ? router.value : [],
    ...catalog.status === 'fulfilled' ? catalog.value.filter(item => String(item.sessionId).startsWith('worker-')) : []]
  // One title per Session: a page reloaded against a host that still lists a worker in both reads must not match twice.
  const merged = new Map<string, SessionTitle>()
  for (const item of items) {
    const title = sessionTitle(item)
    if (title === undefined || typeof item.sessionId !== 'string') continue
    merged.set(item.sessionId, { sessionId: item.sessionId, title })
  }
  return [...merged.values()]
}

/** The Session id of the link an event targets, or undefined when it is not a Session link. */
function linkedSession(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  const anchor = target.closest(ANCHOR)
  if (!(anchor instanceof HTMLElement)) return undefined
  // The attribute, not `.href`: the browser resolves a custom scheme against the page and may normalize it.
  return sessionIdOfHref(anchor.getAttribute('href') ?? '')
}

/** Whether an element holds editable or interactive content this module must not rewrite. */
function protectedContent(element: Element): boolean {
  return element.closest('a, button, textarea, input, select, [contenteditable="true"], [data-dsh-superagent-session]') !== null
}

/**
 * Replace every occurrence of a known title inside one text node with an opening button, in place.
 * @param node - the text node to inspect.
 * @param titles - the titles to match, longest first so a longer title wins over one it contains.
 * @param open - the navigation to call.
 */
function linkifyNode(node: Text, titles: readonly SessionTitle[], open: (sessionId: string) => void): void {
  const parent = node.parentElement
  if (parent === null || protectedContent(parent)) return
  const text = node.data
  const hits: { at: number; length: number; row: SessionTitle }[] = []
  for (const row of titles) {
    for (let at = text.indexOf(row.title); at >= 0; at = text.indexOf(row.title, at + row.title.length)) {
      hits.push({ at, length: row.title.length, row })
    }
  }
  if (hits.length === 0) return
  hits.sort((a, b) => a.at - b.at)
  // Overlapping matches would split the same span twice; the first (and longest, by the order above) wins.
  const kept: typeof hits = []
  for (const hit of hits) {
    const previous = kept.at(-1)
    if (previous !== undefined && hit.at < previous.at + previous.length) continue
    kept.push(hit)
  }
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const hit of kept) {
    if (hit.at > cursor) fragment.append(text.slice(cursor, hit.at))
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dt-session-link'
    button.dataset.dshSuperagentSession = hit.row.sessionId
    button.title = hit.row.title
    button.textContent = hit.row.title
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      open(hit.row.sessionId)
    })
    fragment.append(button)
    cursor = hit.at + hit.length
  }
  if (cursor < text.length) fragment.append(text.slice(cursor))
  node.replaceWith(fragment)
}

/**
 * Make the Router's conversation link to its workers.
 * @param openSession - the client's navigation path (see `openKnownSession`).
 * @param titles - reads the Sessions the host lists for the Router, whose titles are the ones to match.
 * @returns dispose, which removes every listener and button.
 */
export function mountSessionLinks(openSession: (sessionId: string) => void,
  titles: () => Promise<readonly SessionTitle[]>): () => void {
  /** The titles of the last successful read; empty until one lands, so nothing is rewritten on a guess. */
  let known: readonly SessionTitle[] = []
  let disposed = false

  const click = (event: MouseEvent): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const sessionId = linkedSession(event.target)
    if (sessionId === undefined) return
    event.preventDefault()
    event.stopPropagation()
    openSession(sessionId)
  }
  // Middle-click and `auxclick` never open a DSH conversation; suppressing the default stops a blank tab for a `dsh:` link.
  const aux = (event: MouseEvent): void => { if (linkedSession(event.target) !== undefined) event.preventDefault() }

  /** Rewrite every text node the transcript currently shows, once. */
  const pass = (): void => {
    if (disposed || known.length === 0) return
    for (const root of document.querySelectorAll(TRANSCRIPT)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const found: Text[] = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node instanceof Text) found.push(node)
      }
      for (const node of found) linkifyNode(node, known, openSession)
    }
  }

  const observer = new MutationObserver(() => { pass() })
  observer.observe(document.body, { childList: true, subtree: true })

  const refresh = async (): Promise<void> => {
    try {
      const rows = await titles()
      if (disposed) return
      const next = rows.filter(row => row.title.trim() !== '')
        .map(row => ({ sessionId: row.sessionId, title: row.title }))
        .sort((a, b) => b.title.length - a.title.length)
      const changed = next.length !== known.length || next.some((row, index) => row.title !== known[index]?.title)
      known = next
      if (changed) pass()
    } catch { /* The linkifier is a convenience: a failed read leaves the transcript as DSH rendered it. */ }
  }
  void refresh()
  const timer = window.setInterval(() => { void refresh() }, POLL_MS)

  document.addEventListener('click', click, true)
  document.addEventListener('auxclick', aux, true)
  return () => {
    disposed = true
    observer.disconnect()
    window.clearInterval(timer)
    document.removeEventListener('click', click, true)
    document.removeEventListener('auxclick', aux, true)
    for (const button of document.querySelectorAll(`[${LINK_ATTR}]`)) button.replaceWith(document.createTextNode(button.textContent ?? ''))
  }
}

export { LINK_ATTR }
