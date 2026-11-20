/**
 * The virtual Router workspace: one group inside DSH's own workspace list that aggregates router-level Sessions.
 *
 * Virtual by construction — no Workspace record, no directory, no ownership write. The group is a DOM mount inside the
 * shipped browser's `[data-slot="sidebar.workspaces"]` region (the same seam the installed dsh-plugin-sidebar-views
 * uses), it lists whatever `GET router-sessions` selects from durable Session headers, and it hides those Sessions'
 * native rows so one conversation never appears twice. Nothing is persisted except the fold state, so disabling the
 * plugin restores the original list exactly.
 *
 * Every step degrades silently: a missing anchor, an unreachable host, or a renamed row attribute leaves the native
 * workspace list untouched and this module inert.
 * @module dsh-superagent/src/client/router-workspace
 */
import type { RouterSessionRow } from '../app/router-sessions.ts'
import { when, type T } from './text.ts'

/** Selector of the shipped workspace browsing region; the only element this module mounts into. */
const ANCHOR = '[data-slot="sidebar.workspaces"]'
/** Attribute naming one native row, which is how a migrated Session's own row is suppressed. */
const ROW_KEY = 'data-row-key'
/** Fold state of the group, the only value this module persists. */
const COLLAPSED_KEY = 'dsh-superagent/router-workspace/collapsed'
const POLL_MS = 4000

/** One row as the group renders it: the host row plus the label and recency the list shows. */
interface Item extends RouterSessionRow {
  readonly label: string
  readonly ago: string
}

/** Everything one render needs. */
interface View {
  readonly items: readonly Item[]
  readonly collapsed: boolean
  readonly error: string | undefined
}

/** Host dependencies the group needs: the Session opener and the current translator. */
export interface RouterWorkspaceDeps {
  /** Open a Session in the main column exactly as a native row does. */
  readonly openSession: (sessionId: string) => void
  /** Read the current translator, so a locale change needs no remount. */
  readonly t: () => T
}

/** Persistent DOM of the group; only its contents change between renders. */
interface Handle {
  readonly host: HTMLDivElement
  readonly head: HTMLButtonElement
  readonly count: HTMLSpanElement
  readonly label: HTMLSpanElement
  readonly body: HTMLDivElement
  readonly note: HTMLDivElement
  readonly css: HTMLStyleElement
  readonly hide: HTMLStyleElement
}

let handle: Handle | undefined
let deps: RouterWorkspaceDeps | undefined
let view: View | undefined
let timer: ReturnType<typeof setInterval> | undefined
let pendingReveal = false
let disposed = false
let polling = false

/**
 * Mount bookkeeping shared through the window, because a reloaded client bundle evaluates this module again and its
 * module-level state starts empty: without a shared registry each reload would leave a stale group and its interval
 * behind, and the sidebar would collect one group per reload.
 */
interface Shared {
  readonly stops: Set<() => void>
  /** Token of the mount that owns the DOM; a stale mount stops instead of re-attaching beside the current one. */
  owner: number
  next: number
}
const SHARED_KEY = '__dshSuperagentRouterWorkspace'

/** The window-level registry, created on first use and reused by every later evaluation of this module. */
function shared(): Shared {
  const host = window as unknown as Record<string, Shared | undefined>
  return host[SHARED_KEY] ??= { stops: new Set(), owner: 0, next: 0 }
}

/** Take ownership: stop every mount an earlier evaluation left running, and clear its leftover DOM. */
function supersede(): number {
  const registry = shared()
  for (const stop of [...registry.stops]) stop()
  registry.stops.clear()
  for (const stale of document.querySelectorAll('[data-router-workspace]')) stale.remove()
  registry.owner = ++registry.next
  return registry.owner
}

/** Styles for the group; every colour is a DSH alias token so the group follows the active theme. */
const CSS = `
.dsr-root{box-sizing:border-box;margin-top:2px;padding:0 8px}
.dsr-head{display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 4px;border:none;border-radius:var(--dsw-radius-md,8px);
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;font-weight:600;text-align:start}
.dsr-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary)}
.dsr-chevron{flex:none;display:inline-flex;align-items:center;justify-content:center;width:10px;margin-inline-start:2px;font-size:9px;line-height:1;
  color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dsr-collapsed .dsr-chevron{transform:rotate(-90deg)}
.dsr-glyph{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-brand-primary,#6366f1)}
.dsr-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-count{flex:none;min-width:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;text-align:center}
.dsr-rows{display:flex;flex-direction:column;padding-bottom:2px}
.dsr-collapsed .dsr-rows{display:none}
.dsr-row{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:30px;padding:0 8px;border-radius:var(--dsw-radius-md,8px);
  color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;user-select:none}
.dsr-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dsr-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6366f1);outline-offset:-2px}
.dsr-dot{flex:none;width:7px;height:7px;border-radius:50%;background:transparent}
.dsr-running .dsr-dot{background:var(--dsw-alias-state-success-primary,#22c55e);animation:dsr-pulse 1.6s ease-in-out infinite}
.dsr-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-ago{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsr-note{padding:2px 8px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsr-flash{animation:dsr-flash 1.2s ease-out}
.dt-router-entry{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px;border:none;border-radius:var(--dsw-radius-md,8px);
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px}
.dt-router-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary)}
.dt-router-entry-label{white-space:nowrap}
.dsr-page{box-sizing:border-box;max-width:720px;margin:0 auto;padding:24px 20px;display:flex;flex-direction:column;gap:10px}
.dsr-page-head{display:flex;align-items:center;gap:8px}
.dsr-page-title{margin:0;font-size:16px;font-weight:600;flex:1;min-width:0}
.dsr-page-locate{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));
  border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px}
.dsr-page-locate:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary)}
.dsr-page-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsr-page-note{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 0}
.dsr-page-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dsr-page-row{display:flex;align-items:center;gap:8px;width:100%;height:34px;padding:0 10px;border:none;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;text-align:start}
.dsr-page-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dsr-page-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-dot-on{background:var(--dsw-alias-state-success-primary,#22c55e)}
@keyframes dsr-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes dsr-flash{0%,40%{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.2))}100%{background:transparent}}
@media (prefers-reduced-motion:reduce){.dsr-running .dsr-dot{animation:none}.dsr-flash{animation:none}}
`

/** The group's mark: a routed branch, deliberately nothing like the folder glyph the shipped rows use. */
const GLYPH = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="3.1" cy="8" r="1.6"/><circle cx="12.9" cy="3.6" r="1.6"/><circle cx="12.9" cy="12.4" r="1.6"/>'
  + '<path d="M4.7 8h2.6"/><path d="M7.3 8 11.3 4.6"/><path d="M7.3 8l4 3.4"/></svg>'

/** Create a plugin-owned style element under a stable id, replacing a leftover from an earlier mount. */
function styleTag(id: string, css: string): HTMLStyleElement {
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
  if (existing instanceof HTMLStyleElement) return existing
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-superagent'
  tag.dataset.pluginCss = id
  tag.textContent = css
  document.head.appendChild(tag)
  return tag
}

/** Build the group's persistent DOM once: header, rows container, note, and the suppression style element. */
function buildOnce(): Handle {
  if (handle !== undefined) return handle
  const css = styleTag('dsh-superagent/router-workspace', CSS)
  const hide = styleTag('dsh-superagent/router-workspace-migrated', '')
  const host = document.createElement('div')
  host.className = 'dsr-root'
  host.dataset.plugin = 'dsh-superagent'
  host.dataset.routerWorkspace = ''
  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'dsr-head'
  const chevron = document.createElement('span')
  chevron.className = 'dsr-chevron'
  chevron.textContent = '▼'
  const glyph = document.createElement('span')
  glyph.className = 'dsr-glyph'
  glyph.innerHTML = GLYPH
  const label = document.createElement('span')
  label.className = 'dsr-label'
  const count = document.createElement('span')
  count.className = 'dsr-count'
  const body = document.createElement('div')
  body.className = 'dsr-rows'
  const note = document.createElement('div')
  note.className = 'dsr-note'
  note.hidden = true
  // Mark and title lead; the fold arrow trails at the right edge, so the row reads like the person's own list.
  head.append(glyph, label, count, chevron)
  host.append(head, body, note)
  head.addEventListener('click', () => {
    const collapsed = !(view?.collapsed ?? false)
    persistCollapsed(collapsed)
    view = { items: view?.items ?? [], collapsed, error: view?.error }
    render()
  })
  // One delegated listener: rows are rebuilt on every render, so per-row listeners would leak.
  host.addEventListener('click', event => {
    const row = rowOf(event.target)
    if (row !== null) open(row)
  })
  host.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const row = rowOf(event.target)
    if (row === null) return
    event.preventDefault()
    open(row)
  })
  handle = { host, head, count, label, body, note, css, hide }
  return handle
}

/** The Session id of the row an event target belongs to, or null when it is not a row. */
function rowOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const row = target.closest('[data-session-id]')
  return row instanceof HTMLElement ? row.dataset.sessionId ?? null : null
}

/** Open one listed Session through the caller's navigation path. */
function open(sessionId: string): void {
  try { deps?.openSession(sessionId) } catch { /* A Session the catalog cannot open leaves the group as it is. */ }
}

function persistCollapsed(collapsed: boolean): void {
  try { window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0') } catch { /* Reading memory is a convenience. */ }
}

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

/** Fetch the host-selected router Sessions; the endpoint is this group's only data source. */
export async function loadRouterSessions(): Promise<readonly RouterSessionRow[]> {
  const response = await fetch('/orchestrator/api/router-sessions', { credentials: 'omit',
    signal: AbortSignal.timeout(8000), headers: { 'x-orchestrator-request': '1' } })
  if (!response.ok) throw new Error(`router-sessions ${response.status}`)
  const value = await response.json() as { items?: unknown }
  return Array.isArray(value.items) ? value.items as RouterSessionRow[] : []
}

/** Turn a host answer into the rendered view, formatting titles and recency once. */
function toView(items: readonly RouterSessionRow[], t: T, collapsed: boolean, error: string | undefined): View {
  const lang = t('lang')
  return { items: items.map(item => ({ ...item, label: item.title ?? t('routerWorkspaceUntitled'),
    ago: when(new Date(item.updatedAt).toISOString(), lang) })), collapsed, error }
}

/** A comparable form of the rows, so an unchanged poll does not touch the DOM. */
function signature(items: readonly Item[]): string {
  return JSON.stringify(items.map(item => [item.sessionId, item.label, item.ago, item.running]))
}

/** One session row: status dot, title, and recency; a derived Session is indented under its router. */
function rowElement(item: Item, collapsed: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = `dsr-row${item.running ? ' dsr-running' : ''}`
  row.dataset.sessionId = item.sessionId
  row.setAttribute('role', 'button')
  row.tabIndex = collapsed ? -1 : 0
  row.title = item.cwd !== undefined ? `${item.label}\n${item.cwd}` : item.label
  const dot = document.createElement('span')
  dot.className = 'dsr-dot'
  const title = document.createElement('span')
  title.className = 'dsr-title'
  title.textContent = item.label
  const ago = document.createElement('span')
  ago.className = 'dsr-ago'
  ago.textContent = item.ago
  row.append(dot, title, ago)
  return row
}

/** Paint the current view: header label and count, rows, note, and the migration rules. */
function render(): void {
  const dom = buildOnce()
  const t = deps?.t()
  if (t === undefined) return
  const current: View = view ?? { items: [], collapsed: readCollapsed(), error: undefined }
  dom.label.textContent = t('routerWorkspace')
  dom.head.title = t('routerWorkspaceHint')
  dom.head.setAttribute('aria-label', t('routerWorkspace'))
  dom.head.setAttribute('aria-expanded', current.collapsed ? 'false' : 'true')
  dom.host.classList.toggle('dsr-collapsed', current.collapsed)
  dom.count.textContent = String(current.items.length)
  dom.count.hidden = current.items.length === 0
  dom.body.replaceChildren(...current.items.map(item => rowElement(item, current.collapsed)))
  const note = current.error ?? (current.items.length === 0 ? t('routerWorkspaceEmpty') : '')
  dom.note.textContent = note
  dom.note.hidden = note === ''
  // A migrated Session keeps its native row out of the list: the same conversation must not appear twice.
  applySuppression(dom)
}

/** Suppress exactly the listed Sessions' native rows, and nothing at all while the group is not mounted. */
function applySuppression(dom: Handle): void {
  const items = view?.items ?? []
  // Without the mount the group cannot show the conversation, so its native row must stay visible: never hide and drop.
  dom.hide.textContent = dom.host.isConnected
    ? items.map(item => `[data-slot="sidebar.workspaces"] [${ROW_KEY}="session:${item.sessionId}"]{display:none!important}`).join('\n')
    : ''
}

/** Watch the list so a render that appends its own rows cannot leave the group in the middle of it. */
let observer: MutationObserver | undefined
let observed: HTMLElement | undefined

/** Keep the group the last child of the list, and re-assert that when the list's children change. */
function pinLast(root: HTMLElement, dom: Handle): void {
  if (dom.host.parentElement !== root || root.lastElementChild !== dom.host) root.appendChild(dom.host)
  if (observer !== undefined && observed === root) return
  observer?.disconnect()
  observed = root
  // Our own append re-enters this callback once, and the same check then leaves it alone.
  observer = new MutationObserver(() => { observer?.takeRecords(); pinLast(root, dom) })
  observer.observe(root, { childList: true })
}

/** Attach the group at the bottom of the shipped browser, unless the region is absent. */
function attach(): void {
  const root = document.querySelector(ANCHOR)?.firstElementChild
  // Degrade silently: without the region there is nothing to join, and the native list stays exactly as it was.
  if (!(root instanceof HTMLElement)) {
    if (handle !== undefined) handle.hide.textContent = ''
    observer?.disconnect()
    observer = undefined
    observed = undefined
    return
  }
  const dom = buildOnce()
  // Always last: a later render appends its own rows after this mount, and the group's position must stay fixed.
  pinLast(root, dom)
  applySuppression(dom)
  if (pendingReveal) { pendingReveal = false; reveal() }
}

/** Scroll the group into view, unfold it, and flash it: the independent entry's whole behaviour. */
function reveal(): void {
  const dom = handle
  if (dom === undefined || dom.host.parentElement === null) { pendingReveal = true; return }
  if (view?.collapsed === true) {
    persistCollapsed(false)
    view = { ...view, collapsed: false }
    render()
  }
  dom.host.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  dom.host.classList.remove('dsr-flash')
  // Read the offset so the animation restarts when the entry is used twice in a row.
  void dom.host.offsetWidth
  dom.host.classList.add('dsr-flash')
  window.setTimeout(() => dom.host.classList.remove('dsr-flash'), 1400)
}

/** Reveal the group from anywhere: the sidebar-foot entry calls this. */
export function revealRouterWorkspace(): void {
  reveal()
  // A cold page may not have mounted the region yet; retry once after the sidebar renders.
  if (pendingReveal) window.setTimeout(attach, 400)
}

/** One poll: refresh from the host and repaint only when the answer differs. */
async function poll(): Promise<void> {
  if (disposed || polling) return
  polling = true
  try {
    const t = deps?.t()
    if (t === undefined) return
    const collapsed = view?.collapsed ?? readCollapsed()
    const next = toView(await loadRouterSessions(), t, collapsed, undefined)
    const changed = view === undefined || signature(next.items) !== signature(view.items)
    view = next
    if (changed) render()
    attach()
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    view = { items: view?.items ?? [], collapsed: view?.collapsed ?? readCollapsed(),
      error: deps?.t()('routerWorkspaceUnavailable') ?? message }
    render()
    attach()
  } finally { polling = false }
}

/**
 * Mount the virtual Router workspace group and keep it attached and current.
 * @param options - the Session opener and the current-translator reader.
 * @returns dispose, which detaches the group and restores the native list.
 */
export function mountRouterWorkspace(options: RouterWorkspaceDeps): () => void {
  // This mount's ownership token: a later mount takes it, and this one then stops instead of fighting over the DOM.
  const mine = supersede()
  deps = options
  disposed = false
  const onVisible = (): void => { if (!document.hidden) void poll() }
  const stop = (): void => {
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    document.removeEventListener('visibilitychange', onVisible)
    const dom = handle
    handle = undefined
    view = undefined
    deps = undefined
    pendingReveal = false
    shared().stops.delete(stop)
    if (dom === undefined) return
    dom.host.remove()
    dom.hide.textContent = ''
    dom.css.remove()
    dom.hide.remove()
    observer?.disconnect()
    observer = undefined
    observed = undefined
  }
  document.addEventListener('visibilitychange', onVisible)
  timer = setInterval(() => {
    if (shared().owner !== mine) { stop(); return }
    attach(); void poll()
  }, POLL_MS)
  shared().stops.add(stop)
  attach()
  void poll()
  return stop
}
