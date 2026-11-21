/** Browser plugin entry point registering Settings, the management panel, Plugin Manager config view and virtual Router group. */
import { useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
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
import { mountRouterWorkspace } from './router-workspace.ts'
import { RouterWorkspacePanel } from './router-panel.tsx'
import { loadSessionTitles, mountSessionLinks } from './session-links.ts'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'

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
/** Registers the Settings section, management panel, Router group, and the Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
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
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: ENTRY, order: 36,
    label: () => t('superagentSettings'), locale: NS },
    (props: SettingsSectionOwnerProps & { t: T }) => <RouterWorkspacePanel t={props.t} close={props.close}
      openSession={id => { props.close(); openSession(id) }}
      openPanel={() => { props.close(); ctx.layout.selectPanel(PANEL_ID) }} />))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
