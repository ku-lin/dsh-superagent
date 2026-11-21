/** Superagent Settings: management-console entry, Router group locator, row visibility and router conversations. */
import { useEffect, useState } from 'react'
import type { RouterSessionRow } from '../app/router-sessions.ts'
import { loadRouterSessions, readSuppressNative, revealRouterWorkspace, setSuppressNative } from './router-workspace.ts'
import { when, type T } from './text.ts'

/** Props supplied by the Settings section: translator, close callback and navigation. */
export interface RouterWorkspacePanelProps {
  readonly t: T
  /** Close the Settings dialog before locating the sidebar group. */
  readonly close: () => void
  /** Open a Session in the conversation column, exactly as the group's rows do. */
  readonly openSession: (sessionId: string) => void
  /** Select the dsh-superagent management panel, registered in the main slot. */
  readonly openPanel: () => void
}

/**
 * Render Superagent Settings and keep its Router list current.
 * @param props - translator, Session opener and management-panel route.
 * @returns the page element.
 */
export function RouterWorkspacePanel({ t, close, openSession, openPanel }: RouterWorkspacePanelProps) {
  const [rows, setRows] = useState<readonly RouterSessionRow[]>([])
  const [error, setError] = useState(false)
  // The operator's own restore switch: off means every native row stays visible, incident or not.
  const [suppress, setSuppress] = useState(readSuppressNative)
  useEffect(() => {
    let live = true
    const load = (): void => {
      void loadRouterSessions().then(items => { if (live) { setRows(items); setError(false) } },
        () => { if (live) setError(true) })
    }
    load()
    const timer = setInterval(load, 4000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  return <div className="dsr-page">
    <header className="dsr-page-head">
      <span className="dsr-glyph"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="3.1" cy="8" r="1.6" /><circle cx="12.9" cy="3.6" r="1.6" /><circle cx="12.9" cy="12.4" r="1.6" />
        <path d="M4.7 8h2.6" /><path d="M7.3 8 11.3 4.6" /><path d="M7.3 8l4 3.4" />
      </svg></span>
      <h2 className="dsr-page-title">{t('superagentSettings')}</h2>
      <button type="button" className="dsr-page-locate" onClick={() => { close(); revealRouterWorkspace() }}>
        {t('routerWorkspaceEntry')}
      </button>
      <button type="button" className="dsr-page-locate" onClick={() => { openPanel() }}>
        {t('superagentOpenConsole')}
      </button>
    </header>
    <p className="dsr-page-hint">{t('superagentSettingsHint')}</p>
    <p className="dsr-page-hint">{t('routerWorkspaceHint')}</p>
    {/* The restore switch: the person can always put every native row back, without waiting for a fix. */}
    <label className="dsr-page-toggle">
      <input type="checkbox" checked={suppress}
        onChange={event => { const next = event.target.checked; setSuppress(next); setSuppressNative(next) }} />
      {t('routerWorkspaceSuppress')}
    </label>
    <p className="dsr-page-hint">{t('routerWorkspaceSwitchHint')}</p>
    {rows.length === 0
      ? <p className="dsr-page-note">{error ? t('routerWorkspaceUnavailable') : t('routerWorkspaceEmpty')}</p>
      : <ul className="dsr-page-list">{rows.map(row => <li key={row.sessionId}>
          <button type="button" className="dsr-page-row" onClick={() => { openSession(row.sessionId) }}>
            <span className={`dsr-dot${row.running ? ' dsr-dot-on' : ''}`} />
            <span className="dsr-page-row-title">{row.title ?? t('routerWorkspaceUntitled')}</span>
            <span className="dsr-ago">{when(new Date(row.updatedAt).toISOString(), t('lang'))}</span>
          </button>
        </li>)}</ul>}
  </div>
}
