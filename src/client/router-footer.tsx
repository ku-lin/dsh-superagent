/**
 * The Router's permanent home in the sidebar foot.
 *
 * The Router's conversations are listed natively now, under the group its own Workspace draws, so this is not a second
 * list and it never hides a row: it is one button that puts a person in the Router conversation from anywhere. Without
 * it the Router is reachable only by scrolling to its Workspace group, which is a long way down a sidebar with many of
 * them — and the whole point of a permanent conversation is that it is always one click away.
 */
import { useEffect, useState } from 'react'
import { loadRouterSessions } from './router-sessions-client.ts'
import type { T } from './text.ts'

/** Props the sidebar foot hands a registered action, plus what this button needs. */
export interface RouterFooterActionProps {
  readonly t: T
  /** Sidebar is expanded rather than collapsed to its 56px rail. */
  readonly wide?: boolean
  /** Open a conversation in the middle column, exactly as a native row does. */
  readonly openSession: (sessionId: string) => void
  /** Select the dsh-superagent management panel, for the case where no Router conversation resolves. */
  readonly openPanel: () => void
}

/**
 * One persistent control: the Router glyph plus the Router's own title, opening the permanent conversation.
 *
 * The conversation id comes from the host's own list rather than from a constant, because a replaced Router is a new
 * Session: `masterId` is what the host reports as the live one, so a refresh or a migration never leaves this button
 * pointing at a conversation that no longer exists.
 * @param props - translator, sidebar width flag and the two destinations.
 * @returns the footer button.
 */
export function RouterFooterAction({ t, wide = true, openSession, openPanel }: RouterFooterActionProps) {
  const [masterId, setMasterId] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void loadRouterSessions().then(rows => {
        if (!live) return
        // The host names the permanent conversation; the first row is it when the field is absent on an older host.
        setMasterId(rows[0]?.sessionId)
      }, () => { /* Keep the previous id: a failed read must not disarm the button. */ })
    }
    read()
    const timer = setInterval(read, 15_000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  const label = t('routerFooterOpen')
  return <button type="button" className="dt-footer-router" title={label} aria-label={label}
    onClick={() => { if (masterId === undefined) openPanel(); else openSession(masterId) }}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="3.1" cy="8" r="1.6" /><circle cx="12.9" cy="3.6" r="1.6" /><circle cx="12.9" cy="12.4" r="1.6" />
      <path d="M4.7 8h2.6" /><path d="M7.3 8 11.3 4.6" /><path d="M7.3 8l4 3.4" />
    </svg>
    {/* Collapsed to the rail there is no room for text, and the label stays on the title/aria-label. */}
    {wide ? <span className="dt-footer-router-text">{label}</span> : null}
  </button>
}
