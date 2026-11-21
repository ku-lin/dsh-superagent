/**
 * The deterministic failure log and its route: a failure a fixed code path saw becomes one record and one Router
 * message, a repeat inside the window is suppressed, and the report route is fenced and validated like every other
 * write.
 *
 * What is pinned here is the property that makes the tool trustworthy: nothing asks a model whether to report. Each
 * case reaches a `FailureLog.record` from a code path that already knew something stopped, and then reads what the
 * Router and the panel would see.
 */
import { describe, expect, it } from 'vitest'
import { FailureLog, exitCodeOf, failureRelay, oneLine, FAILURE_DEDUPE_MS, FAILURE_LIMIT } from '../src/app/failures.ts'
import type { FailureRecord } from '../src/app/failures.ts'
import { registerHttp } from '../src/app/http.ts'
import type { HttpHost } from '../src/app/http.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'

/** A store enough to hold one KV record, which is all the failure log reads and writes. */
function memoryStore() {
  const values = new Map<string, unknown>()
  return {
    get: <V,>(name: string): V | undefined => values.get(name) as V | undefined,
    set: (name: string, value: unknown): void => { values.set(name, structuredClone(value)) },
    // The log wraps its write in a transaction; here a savepoint is the identity, and it runs the work.
    atomic: <T,>(work: () => T): T => work(),
  }
}
/** A log with a recording queue and a recording publisher. */
function log(now?: () => number) {
  const store = memoryStore()
  const queued: { id: string; text: string }[] = []
  const published: FailureRecord[] = []
  const failures = new FailureLog({ store, routerMessage: (id, text) => { queued.push({ id, text }) },
    publish: record => { published.push(record) } }, now)
  return { store, queued, published, failures }
}

describe('oneLine and exitCodeOf', () => {
  it('flattens a thrown value or a trace into one trimmed line', () => {
    expect(oneLine(new TypeError('cannot read p\n  at foo.js:1:1'))).toBe('TypeError: cannot read p at foo.js:1:1')
    expect(oneLine('  a\u0000b  ')).toBe('a\u0000b')
    expect(oneLine('x'.repeat(900)).length).toBe(600)
  })

  it('reads the exit code a producer writes, and never guesses one', () => {
    expect(exitCodeOf('The prepare command failed: exit code: 3')).toBe(3)
    expect(exitCodeOf(new Error('bash exited with exit code 127'))).toBe(127)
    expect(exitCodeOf('killed by SIGTERM')).toBeUndefined()
    expect(exitCodeOf(undefined)).toBeUndefined()
  })
})

describe('FailureLog', () => {
  it('records a failure, tells the Router, and announces it to the panels', () => {
    const { failures, queued, published } = log()
    const record = failures.record({ kind: 'crash', source: 'session', detail: 'Worker conversation worker-t1 was disposed',
      ticketId: 't1', sessionId: 'worker-t1', assignmentId: 'a1' })
    expect(record).toMatchObject({ kind: 'crash', source: 'session', ticketId: 't1', sessionId: 'worker-t1', assignmentId: 'a1' })
    expect(failures.list()).toEqual([record])
    expect(published).toEqual([record])
    // The Router reads a fixed shape, and the id is the message's own idempotency key.
    expect(queued).toHaveLength(1)
    expect(queued[0]!.id).toBe(`failure:${record!.id}`)
    expect(JSON.parse(queued[0]!.text)).toMatchObject({ kind: 'worker_failure', ticket_id: 't1', session: 'worker-t1',
      failure_kind: 'crash', reported_by: 'session' })
  })

  it('carries an exit code only when the failure had one', () => {
    const { failures } = log()
    const withCode = failures.record({ kind: 'exit', source: 'executor', detail: 'exit code: 3', ticketId: 't1', exitCode: 3 })
    const without = failures.record({ kind: 'timeout', source: 'executor', detail: 'prepare timed out', ticketId: 't2' })
    expect(withCode?.exitCode).toBe(3)
    expect(without).not.toHaveProperty('exitCode')
    expect(JSON.parse(failureRelay(without!))).not.toHaveProperty('exit_code')
  })

  it('suppresses the same ticket, session and kind inside the window, and records it again after', () => {
    let clock = 1_000_000
    const { failures, queued } = log(() => clock)
    const input = { kind: 'crash' as const, source: 'session' as const, detail: 'disposed', ticketId: 't1', sessionId: 'worker-t1' }
    expect(failures.record(input)).toBeDefined()
    // A single incident reaches several paths: the second and third are the same alert.
    clock += 1_000
    expect(failures.record({ ...input, detail: 'disposed again' })).toBeUndefined()
    clock += FAILURE_DEDUPE_MS - 2_000
    expect(failures.record({ ...input, detail: 'still the same incident' })).toBeUndefined()
    clock += 1_500
    expect(failures.record({ ...input, detail: 'a new incident' })).toBeDefined()
    expect(queued).toHaveLength(2)
  })

  it('treats a different kind or session as a different incident', () => {
    const { failures } = log()
    expect(failures.record({ kind: 'crash', source: 'session', detail: 'a', ticketId: 't1', sessionId: 'worker-t1' })).toBeDefined()
    expect(failures.record({ kind: 'turn-error', source: 'session', detail: 'b', ticketId: 't1', sessionId: 'worker-t1' })).toBeDefined()
    expect(failures.record({ kind: 'crash', source: 'session', detail: 'c', ticketId: 't1', sessionId: 'worker-t2' })).toBeDefined()
    expect(failures.record({ kind: 'crash', source: 'session', detail: 'd', ticketId: 't2', sessionId: 'worker-t1' })).toBeDefined()
  })

  it('keeps the newest records once the log is full', () => {
    // A fresh clock per record steps past the dedupe window each time.
    let clock = 0
    const { failures } = log(() => (clock += FAILURE_DEDUPE_MS + 1))
    for (let index = 0; index < FAILURE_LIMIT + 5; index++) {
      failures.record({ kind: 'crash', source: 'session', detail: `incident ${index}`, ticketId: `t${index}` })
    }
    const kept = failures.list()
    expect(kept).toHaveLength(FAILURE_LIMIT)
    expect(kept.at(-1)!.detail).toBe(`incident ${FAILURE_LIMIT + 4}`)
    expect(kept[0]!.detail).toBe('incident 5')
  })

  it('lists one ticket\'s failures newest first', () => {
    let clock = 0
    const { failures } = log(() => (clock += FAILURE_DEDUPE_MS + 1))
    failures.record({ kind: 'crash', source: 'session', detail: 'first', ticketId: 't1' })
    failures.record({ kind: 'exit', source: 'executor', detail: 'other ticket', ticketId: 't2' })
    failures.record({ kind: 'timeout', source: 'executor', detail: 'second', ticketId: 't1' })
    expect(failures.ofTicket('t1').map(record => record.detail)).toEqual(['second', 'first'])
  })
})

/** Mount the management routes on a fake web server, as `tests/http.spec.ts` does. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  const routes: { kind: string; path: string; handler: (req: never, res: never) => unknown }[] = []
  const ctx = { webServer: { host, port: 3082, register: (route: typeof routes[number]) => {
    routes.push(route)
    if (route.kind === 'prefix') handler = route.handler as never
    return () => {}
  } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers })
      .filter(([, value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  return { call, routes }
}

describe('POST worker/failure', () => {
  /** A host whose failure log is real, so the route's own behaviour is what is under test. */
  function host() {
    const { failures, queued } = log()
    const published: unknown[] = []
    return { failures, queued, published, runtime: { failures, stream: { publish: (topic: string) => { published.push(topic) } },
      store: { settings: () => SettingsSchema.parse({}) } } }
  }

  it('records a report and answers with the stored record', async () => {
    const { runtime, queued, published } = host()
    const { call } = serve(runtime)
    const answer = await call('POST', 'worker/failure', { ticket: 't1', session: 'worker-t1', kind: 'crash',
      detail: 'the wrapper saw worker-t1 die', exitCode: 137 })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ recorded: true, failure: { kind: 'crash', source: 'api', ticketId: 't1',
      sessionId: 'worker-t1', exitCode: 137, detail: 'the wrapper saw worker-t1 die' } })
    // The Router was told, and the panel was asked to re-read the ticket list.
    expect(queued).toHaveLength(1)
    expect(published).toEqual(['tickets'])
  })

  it('answers a repeat inside the window without failing or double-reporting', async () => {
    const { runtime, queued } = host()
    const { call } = serve(runtime)
    const body = { ticket: 't1', session: 'worker-t1', kind: 'crash', detail: 'died' }
    expect((await call('POST', 'worker/failure', body)).body).toMatchObject({ recorded: true })
    expect((await call('POST', 'worker/failure', body)).body).toEqual({ recorded: false, duplicate: true })
    expect(queued).toHaveLength(1)
  })

  it('requires the same-origin request header, as every other write does', async () => {
    const { runtime, queued } = host()
    const { call } = serve(runtime)
    const without = await call('POST', 'worker/failure', { detail: 'x' }, { 'x-orchestrator-request': undefined })
    expect(without).toMatchObject({ status: 403 })
    // A foreign origin is refused even with the header.
    const foreign = await call('POST', 'worker/failure', { detail: 'x' }, { origin: 'http://evil.test' })
    expect(foreign).toMatchObject({ status: 403 })
    // The host name has to be this listener's.
    const wrongHost = await call('POST', 'worker/failure', { detail: 'x' }, { host: '127.0.0.1:9999' })
    expect(wrongHost).toMatchObject({ status: 403 })
    expect(queued).toHaveLength(0)
  })

  it('refuses a body without a detail or with an unknown kind', async () => {
    const { runtime, queued } = host()
    const { call } = serve(runtime)
    expect((await call('POST', 'worker/failure', { ticket: 't1' })).status).toBe(400)
    expect((await call('POST', 'worker/failure', { detail: '   ' })).status).toBe(400)
    expect((await call('POST', 'worker/failure', { detail: 'x', kind: 'exploded' })).status).toBe(400)
    // The schema is strict: a field nobody reads is a caller's mistake, not something to ignore.
    expect((await call('POST', 'worker/failure', { detail: 'x', severity: 'high' })).status).toBe(400)
    expect((await call('POST', 'worker/failure', { detail: 'x'.repeat(4001) })).status).toBe(400)
    expect(queued).toHaveLength(0)
  })

  it('accepts a report that names neither a ticket nor a session', async () => {
    const { runtime } = host()
    const { call } = serve(runtime)
    const answer = await call('POST', 'worker/failure', { detail: 'a supervisor saw the whole host die' })
    expect(answer.body).toMatchObject({ recorded: true, failure: { kind: 'crash', source: 'api' } })
    expect((answer.body.failure as FailureRecord)).not.toHaveProperty('ticketId')
  })
})

describe('GET worker/failures', () => {
  it('answers newest first, narrowed by ticket or kind', async () => {
    let clock = 0
    const { failures } = log(() => (clock += FAILURE_DEDUPE_MS + 1))
    failures.record({ kind: 'crash', source: 'session', detail: 'first', ticketId: 't1' })
    failures.record({ kind: 'timeout', source: 'executor', detail: 'second', ticketId: 't1' })
    failures.record({ kind: 'crash', source: 'api', detail: 'third', ticketId: 't2' })
    const { call } = serve({ failures, store: { settings: () => SettingsSchema.parse({}) } })
    expect(await call('GET', 'worker/failures')).toMatchObject({ status: 200, body: { total: 3 } })
    const all = (await call('GET', 'worker/failures')).body.items as FailureRecord[]
    expect(all.map(record => record.detail)).toEqual(['third', 'second', 'first'])
    const one = (await call('GET', 'worker/failures?ticket=t1')).body.items as FailureRecord[]
    expect(one.map(record => record.detail)).toEqual(['second', 'first'])
    const kind = (await call('GET', 'worker/failures?kind=crash')).body.items as FailureRecord[]
    expect(kind.map(record => record.detail)).toEqual(['third', 'first'])
    // `limit` narrows the page but `total` still counts what the filter matched.
    expect(await call('GET', 'worker/failures?limit=1')).toMatchObject({ body: { total: 3 } })
    expect(((await call('GET', 'worker/failures?limit=1')).body.items as FailureRecord[])).toHaveLength(1)
  })

  it('answers an empty list on a host that never recorded one', async () => {
    const { call } = serve({ failures: log().failures, store: { settings: () => SettingsSchema.parse({}) } })
    expect(await call('GET', 'worker/failures')).toEqual({ status: 200, body: { items: [], total: 0 } })
  })
})

describe('the failure log key', () => {
  it('is the one the store keeps, so a restart reads what earlier runs recorded', () => {
    const { store, failures } = log()
    failures.record({ kind: 'crash', source: 'session', detail: 'before a restart', ticketId: 't1' })
    expect(store.get(KV.runtime.failures)).toHaveLength(1)
  })
})
