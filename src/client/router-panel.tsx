/** Superagent Settings: management-console entry, Router switch, Router conversations, and their refresh/delete actions. */
import { useEffect, useState } from 'react'
import type { RouterSwitch } from '../app/control.ts'
import type { RouterSessionRow } from '../app/router-sessions.ts'
import { ControlRefusal, deleteSession, loadManagedRouters, loadRouterState, refreshRouter, startRouter, stopRouter,
  type ManagedRouterRow } from './router-control.ts'
import { loadRouterSessions } from './router-sessions-client.ts'
import { when, type T } from './text.ts'

/** Props supplied by the Settings section: translator, close callback and navigation. */
export interface RouterWorkspacePanelProps {
  readonly t: T
  /** Close the Settings dialog before leaving it. */
  readonly close: () => void
  /** Open a Session in the conversation column. */
  readonly openSession: (sessionId: string) => void
  /** Select the dsh-superagent management panel, registered in the main slot. */
  readonly openPanel: () => void
}

/**
 * Render Superagent Settings and keep its Router list current.
 *
 * This page is where a Router is replaced or deleted. The conversations themselves are listed natively by the sidebar,
 * in the group their own Workspace draws, so nothing on this page has to move or hide a row.
 * @param props - translator, Session opener and management-panel route.
 * @returns the page element.
 */
export function RouterWorkspacePanel({ t, close, openSession, openPanel }: RouterWorkspacePanelProps) {
  const [rows, setRows] = useState<readonly RouterSessionRow[]>([])
  const [error, setError] = useState(false)
  // The Router switch, its reason field, and the refusal the last control write produced, if any.
  const [router, setRouter] = useState<RouterSwitch | undefined>(undefined)
  // The permanent Router conversation: it cannot delete itself, so its row offers no button.
  const [masterId, setMasterId] = useState<string | undefined>(undefined)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const [deleted, setDeleted] = useState<string | undefined>(undefined)
  // The Router this page's conversation is bound to, when the host has one: only a bound Router can archive to a project.
  const [managed, setManaged] = useState<ManagedRouterRow[]>([])
  const [refreshed, setRefreshed] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    const load = (): void => {
      void loadRouterSessions().then(items => { if (live) { setRows(items); setError(false) } },
        () => { if (live) setError(true) })
      // A failed switch read leaves the previous value: the rows keep working without it.
      void loadRouterState().then(value => { if (live) { setRouter(value.router); setMasterId(value.masterId) } }, () => {})
      // A host that predates managed Routers answers 404 here; the page then offers no refresh button instead of erroring.
      void loadManagedRouters().then(items => { if (live) setManaged(items) }, () => { if (live) setManaged([]) })
    }
    load()
    const timer = setInterval(load, 4000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  /** Run one control write, reporting a refusal in place instead of throwing at the page. */
  const control = async (run: () => Promise<RouterSwitch>): Promise<void> => {
    setBusy(true); setRefused(undefined)
    try { setRouter(await run()) } catch (failure) {
      setRefused(failure instanceof ControlRefusal || failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  /** Delete one conversation after the browser's own second confirmation, then reload the rows. */
  const remove = async (sessionId: string): Promise<void> => {
    if (!window.confirm(t('routerDeleteConfirm'))) return
    setBusy(true); setRefused(undefined); setDeleted(undefined)
    try {
      const report = await deleteSession(sessionId)
      setRows(current => current.filter(row => row.sessionId !== sessionId))
      setDeleted(`${t('routerDeleteDone')}: ${report.sessionId} (${report.log.state === 'removed'
        ? t('routerDeleteLogRemoved') : t('routerDeleteLogKept')})`)
    } catch (failure) {
      setRefused(failure instanceof ControlRefusal || failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  /** Archive this conversation and continue in a clean one; a refusal is shown in place, and nothing switches. */
  const refresh = async (row: ManagedRouterRow): Promise<void> => {
    if (!window.confirm(t('routerRefreshConfirm'))) return
    setBusy(true); setRefused(undefined); setRefreshed(undefined)
    try {
      const outcome = await refreshRouter(row.routerId, row.sessionId, row.generation)
      setRefreshed(`${t('routerRefreshDone')}: ${outcome.identity.sessionId} (${outcome.identity.generation})`)
      // The Router group reads durable headers, so the new generation needs a re-read rather than a local append.
      setRows(await loadRouterSessions())
      setManaged(current => current.map(item => item.routerId === row.routerId ? outcome.identity : item))
    } catch (failure) {
      const code = failure instanceof ControlRefusal ? failure.code : undefined
      const localized = code === 'sessionBusy' || code === 'sessionHeld' ? t('routerRefreshBusy')
        : code === 'noWorkspace' ? t('routerRefreshUnbound') : undefined
      setRefused(localized ?? (failure instanceof ControlRefusal || failure instanceof Error ? failure.message : String(failure)))
    } finally { setBusy(false) }
  }
  return <div className="dsr-page">
    <header className="dsr-page-head">
      <span className="dsr-glyph"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="3.1" cy="8" r="1.6" /><circle cx="12.9" cy="3.6" r="1.6" /><circle cx="12.9" cy="12.4" r="1.6" />
        <path d="M4.7 8h2.6" /><path d="M7.3 8 11.3 4.6" /><path d="M7.3 8l4 3.4" />
      </svg></span>
      <h2 className="dsr-page-title">{t('superagentSettings')}</h2>
      <button type="button" className="dsr-page-locate" onClick={() => { openPanel() }}>
        {t('superagentOpenConsole')}
      </button>
    </header>
    <p className="dsr-page-hint">{t('superagentSettingsHint')}</p>
    {/* The switch: stopping keeps every message and every running ticket, which is what the hint says. */}
    <section className="dsr-switch">
      <h3 className="dsr-page-subtitle">{t('routerSwitchTitle')}</h3>
      <p className="dsr-switch-state">
        {router?.paused ? t('routerStopped') : t('routerRunning')}
        {router?.paused && router.at
          ? ` · ${t('routerStoppedAt')} ${when(router.at, t('lang'))}${router.reason ? ` · ${router.reason}` : ''} · ${router.by === 'tool' ? t('routerByTool') : t('routerByPanel')}`
          : ''}
      </p>
      <p className="dsr-page-hint">{t('routerStopHint')}</p>
      {router?.paused
        ? <button type="button" className="dsr-page-locate" disabled={busy} onClick={() => { void control(() => startRouter()) }}>
            {t('routerStart')}
          </button>
        : <div>
            <label className="dsr-page-toggle">
              {t('routerReasonLabel')}
              <input type="text" className="dsr-switch-reason" value={reason} maxLength={500}
                placeholder={t('routerReasonPlaceholder')} onChange={event => { setReason(event.target.value) }} />
            </label>
            <button type="button" className="dsr-page-locate" disabled={busy}
              title={t('routerStopConfirm')} onClick={() => { void control(() => stopRouter(reason)) }}>
              {t('routerStop')}
            </button>
          </div>}
      {refused ? <p className="dsr-page-note">{t('routerSwitchFailed')}: {refused}</p> : null}
      {deleted ? <p className="dsr-page-note">{deleted}</p> : null}
    </section>
    <p className="dsr-page-hint">{t('routerWorkspaceHint')}</p>
    {/* Archive-before-refresh: only a Router the host has bound to a project can archive, so an unbound one explains that. */}
    <h3 className="dsr-page-subtitle">{t('routerRefreshTitle')}</h3>
    <p className="dsr-page-hint">{t('routerRefreshHint')}</p>
    {managed.length === 0
      ? <p className="dsr-page-note">{t('routerRefreshUnbound')}</p>
      : <ul className="dsr-page-list">{managed.map(row => <li key={row.routerId} className="dsr-row">
          <span className="dsr-page-row-title">{row.projectId}</span>
          <span className="dsr-ago">{row.sessionId} · {row.generation}</span>
          <button type="button" className="dsr-page-locate" disabled={busy}
            title={t('routerRefreshConfirm')} onClick={() => { void refresh(row) }}>
            {t('routerRefresh')}
          </button>
        </li>)}</ul>}
    {refreshed ? <p className="dsr-page-note">{refreshed}</p> : null}
    {refused ? <p className="dsr-page-note">{t('routerRefreshFailed')}: {refused}</p> : null}
    <h3 className="dsr-page-subtitle">{t('routerDeleteTitle')}</h3>
    <p className="dsr-page-hint">{t('routerDeleteHint')}</p>
    {rows.length === 0
      ? <p className="dsr-page-note">{error ? t('routerWorkspaceUnavailable') : t('routerWorkspaceEmpty')}</p>
      : <ul className="dsr-page-list">{rows.map(row => <li key={row.sessionId} className="dsr-row">
          <button type="button" className="dsr-page-row dsr-row-open" onClick={() => { openSession(row.sessionId) }}>
            <span className={`dsr-dot${row.running ? ' dsr-dot-on' : ''}`} />
            <span className="dsr-page-row-title">{row.title ?? t('routerWorkspaceUntitled')}</span>
            <span className="dsr-ago">{when(new Date(row.updatedAt).toISOString(), t('lang'))}</span>
          </button>
          {/* The conversation serving as the Router cannot delete itself; a replaced, archived one can, and the host
              refuses either way, so the page only hides the button for the live generation. */}
          {row.sessionId === masterId ? null : <button type="button" className="dsr-page-delete dsr-delete"
            disabled={busy} title={t('routerDeleteConfirm')} onClick={() => { void remove(row.sessionId) }}>
            {t('routerDelete')}
          </button>}
        </li>)}</ul>}
  </div>
}
