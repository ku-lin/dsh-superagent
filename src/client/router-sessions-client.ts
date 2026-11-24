/**
 * The Router's conversations, read the one way the client reads them.
 *
 * The Router is an ordinary Workspace now: its conversations are accounted to a Workspace of their own, so the sidebar
 * lists them natively under the group that Workspace draws. Nothing here mounts a group or moves a row — this module is
 * only the read those surfaces share, so the Router page and any other reader agree on the answer.
 */
import type { RouterSessionRow } from '../app/router-sessions.ts'

/**
 * Fetch the host-selected router Sessions.
 *
 * The deadline sits above the host's own (20 s) so the host gets to answer its last good snapshot instead of this side
 * giving up first: a client-side abort would throw away an answer that was about to arrive.
 */
export async function loadRouterSessions(): Promise<readonly RouterSessionRow[]> {
  const response = await fetch('/orchestrator/api/router-sessions', { credentials: 'omit',
    signal: AbortSignal.timeout(25_000), headers: { 'x-orchestrator-request': '1' } })
  if (!response.ok) throw new Error(`router-sessions ${response.status}`)
  const value = await response.json() as { items?: unknown }
  return Array.isArray(value.items) ? value.items as RouterSessionRow[] : []
}
