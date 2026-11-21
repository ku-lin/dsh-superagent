/** Browser plugin entry point registering the sidebar icon, main management panel, Plugin Manager config view, and the virtual Router workspace group with its own foot entry. */
import { useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarFooterActionOwnerProps, SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { App } from './app.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import { mountRouterWorkspace, revealRouterWorkspace } from './router-workspace.ts'
import { RouterWorkspacePanel } from './router-panel.tsx'
import { loadSessionTitles, mountSessionLinks } from './session-links.ts'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions }
// No command-palette entry: this shell exposes no shortcut catalog to client plugins (declaring it as an injected
// dependency leaves the whole plugin waiting and the web boot reports "1 entry did not activate"), so the group's
// entry is the sidebar rail row below instead.
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
/** The virtual Router workspace's own panel, and the rail row that opens it. */
const ROUTER_PANEL = 'dsh-superagent-router-workspace' as MainPanelId
const ENTRY = 'dsh-superagent'
/** List id of the virtual Router workspace's foot entry, distinct from every other footer action. */
const ROUTER_ENTRY = 'dsh-superagent-router-workspace'

/** The Router workspace mark: a routed branch, matching the group's own glyph and nothing like a folder. */
function RouterGlyph({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="3.1" cy="8" r="1.6" /><circle cx="12.9" cy="3.6" r="1.6" /><circle cx="12.9" cy="12.4" r="1.6" />
    <path d="M4.7 8h2.6" /><path d="M7.3 8 11.3 4.6" /><path d="M7.3 8l4 3.4" />
  </svg>
}

/** Rail row mark for the Router workspace page: the same branch glyph, sized by the seat. */
function RouterWorkspaceIcon({ size }: SidebarPanelIconOwnerProps) {
  return <RouterGlyph size={size} />
}

/**
 * The Router workspace's independent entry at the sidebar foot: it locates the group wherever the person is, so the
 * group is reachable without the top-left workspace list. Rail mode keeps the icon and drops the label.
 */
function RouterWorkspaceEntry({ wide, t }: SidebarFooterActionOwnerProps & { t: T }) {
  return <button type="button" className="dt-router-entry" title={t('routerWorkspaceEntry')}
    aria-label={t('routerWorkspaceEntry')} onClick={() => { revealRouterWorkspace() }}>
    <RouterGlyph size={16} />{wide ? <span className="dt-router-entry-label">{t('routerWorkspace')}</span> : null}
  </button>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      // The router owns its own Session, which the client catalog does not always list; open it directly then.
      if (error instanceof SessionNavigationError && error.code === 'not-listed') {
        ctx.uiWorkspace.openSession(id as SessionId)
        return
      }
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <App t={t} sessions={ctx.sessions} openSession={openSession} deploymentForm={form} />
}

export const inject = ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace']
/** Registers the management panel, the Router workspace group and its rail row, and the Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  /** Open a listed Session the way a native row does; a Session the catalog omits still opens directly. */
  const openSession = (id: string): void => {
    void openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) },
      new AbortController().signal).catch((error: unknown) => {
      if (error instanceof SessionNavigationError && error.code === 'not-listed') ctx.uiWorkspace.openSession(id as SessionId)
      else ctx.logger.warn('dsh-superagent could not open a router Session: %s', String(error))
    })
  }
  ctx.effect(() => mountRouterWorkspace({ openSession, t: () => t }), 'dsh-superagent: virtual Router workspace group')
  // The Router's conversation names the worker it is talking about; that title opens the conversation. DSH's Markdown
  // renderer drops a `dsh:` link, so the title is matched in the transcript instead (see session-links.ts). The titles
  // come from the Router's own rows and from the management catalog, because a worker is listed in its Workspace, not in
  // the Router workspace group.
  ctx.effect(() => mountSessionLinks(openSession, loadSessionTitles),
  'dsh-superagent: Session links in the Router conversation')
  // The management panel keeps no rail row: the sidebar now has one Router entry, the Router workspace page, so its
  // constant is reached from that page instead (`selectPanel`), and the registration stays referenced.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  // The group's entry: a rail row that opens this page and locates the group. It is independent of the top-left
  // workspace list, which is where the person said the entry must not live. No command-palette entry is registered:
  // this shell exposes no shortcut catalog to client plugins (see the note by the locale namespace).
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ROUTER_PANEL, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <RouterWorkspacePanel t={props.t} openSession={openSession}
      openPanel={() => { ctx.layout.selectPanel(PANEL_ID) }} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: ROUTER_PANEL, order: 11,
    label: () => t('routerWorkspacePage'), locale: NS }, RouterWorkspaceIcon))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: ROUTER_ENTRY, order: 20, locale: NS }, RouterWorkspaceEntry))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
