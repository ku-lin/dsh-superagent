// @vitest-environment jsdom
/**
 * The panel learns about changes from the live channel, not from a timer.
 *
 * These cases pin the two facts the change is for: the task rail makes **no** request once it has its answer (there is
 * no thirty-second poll left to fire), and a dropped stream shows 「已断开」 with a manual refresh instead of quietly
 * polling. They also cover the 异常 list, which is where a recorded failure becomes visible to a person.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, find, mount, settle, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import type { FailureRecord } from '../src/app/failures.ts'

/** The stream the panel opens; each case decides whether it answers, and with what frames. */
interface Stream {
  /** Frames written to the open body, in order. */
  readonly written: string[]
  /** Write one SSE frame from the test, as the host would. */
  push(frame: string): void
  /** End the stream, as a restart or a dropped connection does. */
  drop(): void
  /** How many streams the panel opened. */
  readonly opened: number
}
let stream: Stream | undefined

/**
 * Answer `/orchestrator/api/stream` with a body the test writes to, and every other route through the fake server.
 *
 * The fixture installs its own `fetch` in `beforeEach`, so this wraps whatever is current rather than replacing it:
 * the stream request is answered here and every other request reaches the fake management API unchanged. A real
 * `ReadableStream` is what a response carries, so the panel's own frame parser runs rather than a stub of it.
 */
function serveStream(): void {
  const written: string[] = []
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  let opened = 0
  const encode = new TextEncoder()
  const inner = globalThis.fetch as (url: string, init?: RequestInit) => Promise<Response>
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).includes('/orchestrator/api/stream')) return inner(url, init)
    opened++
    const body = new ReadableStream<Uint8Array>({ start(next) { controllers.push(next) } })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }))
  stream = { written,
    push: frame => { written.push(frame); controllers.forEach(controller => controller.enqueue(encode.encode(frame))) },
    drop: () => { for (const controller of controllers.splice(0)) controller.close() },
    get opened() { return opened } }
}

/** Let the stream's reader deliver what was enqueued. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Open the panel on the Router page (the default route), where the rail and the failure list live. */
async function open(): Promise<void> {
  await mount()
  await settle()
  await flush()
}

// The fixture's own `beforeEach` installs the fake management API; this wraps that fetch, so it runs first here.
usePanel()
beforeEach(() => { stream = undefined; serveStream() })
afterEach(() => { stream?.drop() })

describe('the task rail is event-driven', () => {
  it('reads the board once, and does not poll afterwards', async () => {
    await open()
    const reads = () => server.requests.filter(request => request.path.startsWith('tasks')).length
    expect(reads()).toBe(1)
    // The thirty-second poll is gone: waiting past the old interval adds no request.
    expect(reads()).toBe(1)
  })

  it('refetches when the host announces a board change, and only then', async () => {
    await open()
    const reads = () => server.requests.filter(request => request.path.startsWith('tasks')).length
    await act(async () => { stream!.push('event: hello\ndata: {"revisions":{"tasks":0}}\n\n') })
    await flush(); await settle()
    const baseline = reads()
    // One announcement, one refetch.
    await act(async () => { stream!.push('event: change\ndata: {"topic":"tasks","revision":1,"at":"2026-11-21T00:00:00Z"}\n\n') })
    await flush(); await settle()
    expect(reads()).toBe(baseline + 1)
    // The same revision announced twice is one change.
    await act(async () => { stream!.push('event: change\ndata: {"topic":"tasks","revision":1,"at":"2026-11-21T00:00:00Z"}\n\n') })
    await flush(); await settle()
    expect(reads()).toBe(baseline + 1)
  })

  it('says 已断开 and offers a manual refresh when the stream drops, without falling back to polling', async () => {
    await open()
    expect(text()).not.toContain(zh.tasksOffline)
    await act(async () => { stream!.drop() })
    await flush(); await settle()
    expect(text()).toContain(zh.tasksOffline)
    // The refresh button appears only while disconnected; pressing it reads the board again.
    const before = server.requests.filter(request => request.path.startsWith('tasks')).length
    await click(find(zh.tasksRefresh))
    await settle()
    expect(server.requests.filter(request => request.path.startsWith('tasks')).length).toBe(before + 1)

  })
})

describe('the 异常 list', () => {
  /** One recorded failure, as `GET worker/failures` answers it. */
  const record = (fields: Partial<FailureRecord> = {}): FailureRecord => ({ id: 'f1', at: new Date().toISOString(),
    kind: 'crash', source: 'session', detail: 'worker-t1 was disposed while assignment a1 was running',
    ticketId: 't1', sessionId: 'worker-t1', ...fields })

  it('shows what was recorded, with its kind, its target and its exit code', async () => {
    server.failures = [record({ kind: 'exit', source: 'executor', detail: 'the prepare command failed: exit code: 3', exitCode: 3 })]
    await open()
    expect(text()).toContain(zh.failuresTitle)
    expect(text()).toContain(zh['failureKind.exit'])
    expect(text()).toContain(zh.failuresExit.replace('{code}', '3'))
    expect(text()).toContain('the prepare command failed: exit code: 3')
    expect(all('.dt-failures-row')).toHaveLength(1)
    expect(all('.dt-failures-row')[0]!.getAttribute('data-kind')).toBe('exit')
  })

  it('says so when nothing was recorded', async () => {
    await open()
    expect(text()).toContain(zh.failuresEmpty)
    expect(all('.dt-failures-row')).toHaveLength(0)
  })

  it('leads with a pushed record before the refetch answers', async () => {
    await open()
    const pushed = record({ id: 'f-pushed', detail: 'a supervisor reported this' })
    await act(async () => { stream!.push(`event: change\ndata: ${JSON.stringify({ topic: 'failures', revision: 1,
      at: new Date().toISOString(), failure: pushed })}\n\n`) })
    await flush(); await settle()
    // The fixture's log is empty, so the pushed record is what the row shows.
    expect(text()).toContain('a supervisor reported this')
  })
})
