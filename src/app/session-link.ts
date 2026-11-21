/**
 * Links from a Router message to the exact DSH conversation it is about.
 *
 * DSH's Session list has no URL of its own: opening a conversation is `uiWorkspace.openSession(sessionId)`, called by the
 * shipped sidebar rows and by this bundle's client. A Router reply is Markdown rendered by DSH's own renderer, so a link
 * is the one clickable element that survives into the transcript. The scheme is deliberately not `http(s)`: DSH's link
 * renderer hands those to the desktop browser, while anything else is emitted as a plain anchor whose click this bundle's
 * client intercepts (see `src/client/session-links.ts`).
 *
 * The module is pure text: no Context, no DOM, so both sides of the bundle and the unit tests can use it.
 * @module dsh-superagent/src/app/session-link
 */

/** Scheme and path prefix of a link that opens one DSH conversation (`dsh://session/<sessionId>`). */
export const SESSION_LINK_PREFIX = 'dsh://session/'
/** The hash spelling the interceptor also accepts, for a host whose Markdown sanitizer drops unknown schemes. */
export const SESSION_HASH_PREFIX = '#session='

/**
 * The session a Markdown href points at, or undefined when the href is not a Session link.
 * @param href - the raw `href` attribute DSH rendered.
 * @returns the Session id the link opens.
 */
export function sessionIdOfHref(href: string): string | undefined {
  for (const prefix of [SESSION_LINK_PREFIX, SESSION_HASH_PREFIX]) {
    if (!href.startsWith(prefix)) continue
    const id = href.slice(prefix.length).trim()
    return id === '' ? undefined : id
  }
  return undefined
}

/**
 * A Markdown link that opens `sessionId` in this client.
 *
 * The label is the conversation's own title, so the transcript says which worker a paragraph is about without exposing an
 * id; `[` and `]` are stripped because they would end the label early.
 * @param sessionId - the conversation to open.
 * @param label - the text the person clicks.
 * @returns a Markdown link, or the bare label when there is nothing to open.
 */
export function sessionLink(sessionId: string, label: string): string {
  const text = label.replace(/[[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  return sessionId === '' ? text : `[${text || sessionId}](${SESSION_LINK_PREFIX}${sessionId})`
}
