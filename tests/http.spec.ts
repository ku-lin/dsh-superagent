import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { ControlError } from '../src/app/control.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { kind: string; handler: Handler }) => { if (route.kind !== 'exact') handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('lists visible DSH sessions and binds one unstarted ticket with an exclusive idempotent loan', async () => {
  const first = { id: 't1', status: 'open', assignments: [{ id: 'a1', state: 'pending' }],
    execution: { name: 'one', directory: 'test', assignment: 'work' } }
  const second = { ...first, id: 't2', assignments: [{ id: 'a2', state: 'pending' }],
    execution: { ...first.execution } }
  const tickets = [first, second]
  const sessions = [{ sessionId: 'human-1', agentAvailable: true, updatedAt: 1, running: false, blank: false },
    { sessionId: 'worker-t1', agentAvailable: true, updatedAt: 1, running: false, blank: false }]
  const call = serve({
    masterId: 'orchestrator-id',
    listDshSessions: async () => sessions,
    executor: { bindingInProgress: () => false },
    store: { atomic: (work: () => unknown) => work(), tickets: {
      get: (id: string) => tickets.find(item => item.id === id), open: () => tickets, list: () => tickets,
      save: (item: typeof first) => { const index = tickets.findIndex(ticket => ticket.id === item.id); tickets[index] = item },
    } },
  })
  expect(await call('GET', 'dsh-sessions')).toMatchObject({ status: 200, body: { items: [
    { sessionId: 'human-1', borrowable: true }, { sessionId: 'worker-t1', borrowable: false }] } })
  expect(await call('POST', 'tickets/t1/worker-session', { sessionId: 'worker-t1' })).toMatchObject({ status: 404 })
  const bound = await call('POST', 'tickets/t1/worker-session', { sessionId: 'human-1' })
  expect(bound).toMatchObject({ status: 200, body: { ticketId: 't1', sessionId: 'human-1', unchanged: false } })
  expect(await call('GET', 'dsh-sessions')).toMatchObject({ body: { items: [{ leasedToTicketId: 't1', borrowable: false },
    { sessionId: 'worker-t1', borrowable: false }] } })
  expect(await call('POST', 'tickets/t1/worker-session', { sessionId: 'human-1' })).toMatchObject({ status: 200,
    body: { boundAt: bound.body.boundAt, unchanged: true } })
  expect(await call('POST', 'tickets/t2/worker-session', { sessionId: 'human-1' })).toMatchObject({ status: 409 })
  expect(await call('POST', 'tickets/t1/worker-session', { sessionId: 'other' })).toMatchObject({ status: 404 })
  tickets[1]!.assignments = [{ id: 'old', state: 'ended', startedAt: '2026-11-01T00:00:00Z' }, { id: 'a2', state: 'pending' }] as typeof tickets[1]['assignments']
  expect(await call('POST', 'tickets/t2/worker-session', { sessionId: 'worker-t1' })).toMatchObject({ status: 404 })
  sessions.push({ sessionId: 'human-2', agentAvailable: true, updatedAt: 1, running: false, blank: false })
  expect(await call('POST', 'tickets/t2/worker-session', { sessionId: 'human-2' })).toMatchObject({ status: 409 })
})

it('discovers only configured plugin indexes without installing anything', async () => {
  const queries: unknown[] = []
  const call = serve({ pluginMarket: { listIndexes: () => [{ url: 'https://market.example/index.json', title: 'Fixture market' }],
    search: async (...args: unknown[]) => { queries.push(args); return { entries: [{ name: 'fixture.plugin', title: 'Fixture',
      description: 'Read only', defaultVersion: '1.2.3', installation: { status: 'not-installed' } }], total: 1, nextOffset: null } } } })
  expect(await call('GET', 'plugin-indexes')).toMatchObject({ status: 200, body: { available: true,
    items: [{ url: 'https://market.example/index.json' }] } })
  expect(await call('GET', 'plugin-search?url=https%3A%2F%2Fevil.example%2Fplugins&text=x')).toMatchObject({ status: 400 })
  expect(queries).toEqual([])
  expect(await call('GET', 'plugin-search?url=https%3A%2F%2Fmarket.example%2Findex.json&text=hello')).toMatchObject({ status: 200,
    body: { entries: [{ name: 'fixture.plugin', version: '1.2.3', installation: 'not-installed' }], total: 1 } })
  expect(queries).toEqual([['https://market.example/index.json',
    { text: 'hello', sort: { kind: 'relevance' }, offset: 0, limit: 30 }]])
  expect(await serve({})('GET', 'plugin-indexes')).toEqual({ status: 200, body: { available: false, items: [] } })
})

it('exposes the Router switch and deletes a conversation only with confirm and only for an owned one', async () => {
  const calls: [string, unknown][] = []
  const switchValue = { paused: false, reason: '', at: '', by: 'panel' as const }
  const control = {
    router: switchValue,
    stopRouter: (reason: string, by: string) => { calls.push(['stop', { reason, by }]); return { ...switchValue, paused: true, reason, by } },
    startRouter: (by: string) => { calls.push(['start', by]); return { ...switchValue, by } },
    deleteSession: async (id: string, confirm: boolean, by: string) => {
      calls.push(['delete', { id, confirm, by }])
      if (!confirm) throw new ControlError('confirmRequired', 'Deleting a conversation requires confirm: true')
      if (id === 'master') throw new ControlError('routerSession', 'The Router conversation cannot delete itself', 409)
      if (id === 'session-plain') throw new ControlError('notDeletable', 'Only a worker conversation can be deleted', 409)
      return { sessionId: id, kind: 'worker' as const, archived: true as const, detached: [], projections: 'absent' as const,
        log: { state: 'retained' as const, reason: 'no root' } }
    },
  }
  const call = serve({ control, store: { settings: () => SettingsSchema.parse({}), tickets: { open: () => [] } },
    configured: () => false,
    machine: { stateDir: '/state', promptMaxChars: { get: () => 1000 }, admissionContextMaxPages: { get: () => 1 },
      admissionContextTimeoutMs: { get: () => 1000 } },
    executor: { activeCount: () => 0 } })
  // The switch is part of `GET state`, separate from the Executor's own `paused`.
  expect(await call('GET', 'state')).toMatchObject({ status: 200, body: { paused: false, router: { paused: false } } })
  expect(await call('POST', 'router/stop', { reason: ' deploy ' })).toMatchObject({ status: 200,
    body: { paused: true, reason: ' deploy ', by: 'panel' } })
  expect(await call('POST', 'router/start')).toMatchObject({ status: 200, body: { paused: false } })
  expect(calls).toEqual([['stop', { reason: ' deploy ', by: 'panel' }], ['start', 'panel']])
  // A deletion without `confirm=true` is a 400, and the Router conversation is a 409; a person's own is a 409 too.
  expect(await call('DELETE', 'sessions/worker-t1')).toEqual({ status: 400,
    body: { error: 'Deleting a conversation requires confirm: true', code: 'confirmRequired' } })
  expect(await call('DELETE', 'sessions/worker-t1?confirm=false')).toMatchObject({ status: 400 })
  expect(await call('DELETE', 'sessions/master?confirm=true')).toEqual({ status: 409,
    body: { error: 'The Router conversation cannot delete itself', code: 'routerSession' } })
  expect(await call('DELETE', 'sessions/session-plain?confirm=true')).toMatchObject({ status: 409 })
  expect(await call('DELETE', 'sessions/worker-t1?confirm=true')).toMatchObject({ status: 200,
    body: { sessionId: 'worker-t1', kind: 'worker', archived: true, log: { state: 'retained' } } })
  // The switch is a management write like the others: no same-origin request header means no answer.
  expect(await call('POST', 'router/stop', { reason: '' }, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
