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
