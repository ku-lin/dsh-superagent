/**
 * The three Router control operations as the Settings page calls them: stop, start, and delete one conversation.
 *
 * Every call carries the same panel headers the rest of the surface uses, so the host's same-origin check admits it and
 * nothing else can. A refusal is an ordinary answer here: the host words it by code, and the page shows it as it came.
 * @module dsh-superagent/src/client/router-control
 */
import type { DeleteReport, RouterSwitch } from '../app/control.ts'

/** A refusal the host worded, with the code it named so the page can localize it. */
export class ControlRefusal extends Error {
  constructor(readonly code: string | undefined, message: string) { super(message) }
}

/** One request to the host's management routes, with the panel's own headers. */
async function call<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(`/orchestrator/api/${path}`, { method: init.method, credentials: 'omit',
    signal: AbortSignal.timeout(15_000), headers: { 'x-orchestrator-request': '1',
      ...init.body === undefined ? {} : { 'content-type': 'application/json' } },
    ...init.body === undefined ? {} : { body: JSON.stringify(init.body) } })
  const text = await response.text()
  let parsed: unknown
  try { parsed = text ? JSON.parse(text) as unknown : undefined } catch { throw new ControlRefusal(undefined, `${path} ${response.status}`) }
  if (!response.ok) {
    const failure = parsed as { error?: unknown; code?: unknown } | undefined
    throw new ControlRefusal(typeof failure?.code === 'string' ? failure.code : undefined,
      typeof failure?.error === 'string' ? failure.error : `${path} ${response.status}`)
  }
  return parsed as T
}

/**
 * Read the switch as the host reports it, with the permanent Router conversation's id.
 *
 * Both come from `GET state` and `GET router-sessions`, which the page already polls, so the stop and start buttons, the
 * "stopped since" line and the one row that offers no delete button never disagree with the host's own records.
 */
export function loadRouterState(): Promise<{ router: RouterSwitch; masterId: string }> {
  return Promise.all([call<{ router: RouterSwitch; masterId: string }>('state', { method: 'GET' }),
    call<{ masterId: string }>('router-sessions', { method: 'GET' })]).then(([state, sessions]) =>
    ({ router: state.router, masterId: sessions.masterId || state.masterId }))
}

/**
 * Stop the Router, keeping its history and queueing what arrives.
 * @param reason - why, shown in the state and kept in the audit trail.
 * @returns the switch as the host stored it.
 */
export function stopRouter(reason: string): Promise<RouterSwitch> {
  return call<RouterSwitch>('router/stop', { method: 'POST', body: { reason } })
}

/** Start the Router again, releasing what the stop held. */
export function startRouter(): Promise<RouterSwitch> { return call<RouterSwitch>('router/start', { method: 'POST' }) }

/**
 * Delete one conversation the host owns. `confirm` is what makes the deletion possible at all, so the page asks twice.
 * @param sessionId - the conversation to delete.
 * @returns what the deletion did, including whether its log left the disk.
 */
export function deleteSession(sessionId: string): Promise<DeleteReport> {
  return call<DeleteReport>(`sessions/${encodeURIComponent(sessionId)}?confirm=true`, { method: 'DELETE' })
}

/** One managed-Router row as `GET managed-routers` reports it. */
export interface ManagedRouterRow { routerId: string; projectId: string; sessionId: string; generation: number }
/** One historical delegation as `GET delegated-sessions` reports it. */
export interface DelegatedSessionRow { sessionId: string; updatedAt: number; running: boolean; title?: string }

/**
 * Conversations this deployment still holds that were spawned as subagents instead of routed.
 *
 * Read-only: it exists so a person can decide about each one. A Router no longer delegates (the guard refuses it), so
 * this list only ever shrinks by the deletions a person makes here.
 */
export function loadDelegatedSessions(): Promise<DelegatedSessionRow[]> {
  return call<{ items: DelegatedSessionRow[] }>('delegated-sessions', { method: 'GET' }).then(value => value.items)
}
/** What a refresh answers: the new generation, and exactly which archive it committed. */
export interface RefreshOutcome { identity: ManagedRouterRow; archived: number; sourceId: string }

/** Every Router this host has bound to a project, with the Session that is its current generation. */
export function loadManagedRouters(): Promise<ManagedRouterRow[]> {
  return call<{ items: { identity: ManagedRouterRow }[] }>('managed-routers', { method: 'GET' })
    .then(value => value.items.map(item => item.identity))
}

/**
 * Archive one Router's conversation and continue in a clean one.
 *
 * `generation` is what makes this safe to retry: the host refuses a refresh whose generation no longer matches, so a
 * second click after a successful refresh cannot archive the conversation twice. A refusal carries the code the page
 * localizes — an idle/busy conflict, an unbound Router, or an archive that could not be read completely.
 * @param routerId - the managed Router to refresh.
 * @param sessionId - the conversation believed to be its current generation.
 * @param generation - that conversation's generation, as last read.
 */
export function refreshRouter(routerId: string, sessionId: string, generation: number): Promise<RefreshOutcome> {
  return call<RefreshOutcome>(`managed-routers/${encodeURIComponent(routerId)}/refresh`,
    { method: 'POST', body: { sessionId, generation } })
}
