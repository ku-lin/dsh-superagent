/**
 * The Router workspace's own page: the same rows the sidebar group lists, with a locator back to that group.
 *
 * It exists so the group has an entry that is independent of the top-left workspace list: the shell's rail icon opens
 * this page and the page locates the group. The rows come from the same host endpoint, so the two surfaces can never
 * disagree about which conversations are router-level.
 * @module dsh-superagent/src/client/router-panel
 */
import { useEffect, useState } from 'react'
import type { RouterSessionRow } from '../app/router-sessions.ts'
import { loadRouterSessions, revealRouterWorkspace } from './router-workspace.ts'
import { when, type T } from './text.ts'

/** Props the main-panel seat supplies: this page's translator, the Session opener, and the management-panel route. */
export interface RouterWorkspacePanelProps {
  readonly t: T
  /** Open a Session in the conversation column, exactly as the group's rows do. */
  readonly openSession: (sessionId: string) => void
  /** Select the dsh-superagent management panel, which has no sidebar row of its own since this page replaced it. */
  readonly openPanel: () => void
}

/**
 * Render the Router workspace page and keep it current.
 * @param props - translator, Session opener and management-panel route.
 * @returns the page element.
 */
export function RouterWorkspacePanel({ t, openSession, openPanel }: RouterWorkspacePanelProps) {
  const [rows, setRows] = useState<readonly RouterSessionRow[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    const load = (): void => {
      void loadRouterSessions().then(items => { if (live) { setRows(items); setError(false) } },
        () => { if (live) setError(true) })
    }
    load()
    // Locate the sidebar group as soon as the page opens: that is what this entry is for.
    revealRouterWorkspace()
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
      <h2 className="dsr-page-title">{t('routerWorkspacePage')}</h2>
      <button type="button" className="dsr-page-locate" onClick={() => { revealRouterWorkspace() }}>
        {t('routerWorkspaceEntry')}
      </button>
      <button type="button" className="dsr-page-locate" onClick={() => { openPanel() }}>
        {t('routerWorkspaceAdmin')}
      </button>
    </header>
    <p className="dsr-page-hint">{t('routerWorkspaceHint')}</p>
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
