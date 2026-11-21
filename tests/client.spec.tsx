// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { apply } from '../src/client/index.tsx'
import { readSuppressNative } from '../src/client/router-workspace.ts'
import { zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = (key: keyof typeof zh) => zh[key] ?? key
function fixture(listed: string[]) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const stops: (() => void)[] = []
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { const stop = effect(); if (typeof stop === 'function') stops.push(stop as () => void) },
    layout: { selectPanel: vi.fn() },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    // Omit config form service so Deployment renders read-only.
    get: () => undefined,
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, main: entry('main'), settings: entry('settings.section'), dispose: () => { stops.forEach(stop => stop()) } }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const serve = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
afterEach(() => { vi.unstubAllGlobals() })

it('registers Superagent in Settings, keeps the main console and removes Router rail and footer entries', () => {
  const { entries, dictionaries, main, settings, dispose } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'settings.section', 'plugins.row.config'])
  expect(entries[2]!.options).toMatchObject({ key: 'dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(settings.options).toMatchObject({ id: 'dsh-superagent', order: 36, locale: 'dshSuperagent' })
  expect(settings.options.label?.()).toBe('Superagent')
  dispose()
})

it('keeps Settings controls and closes Settings before opening the management console or locating the group', async () => {
  serve()
  window.localStorage.clear()
  const { ctx, settings, dispose } = fixture([])
  const close = vi.fn()
  const view = await render(settings, { t, close })
  const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(checkbox.checked).toBe(true)
  await act(async () => { checkbox.click() })
  expect(readSuppressNative()).toBe(false)
  await act(async () => { checkbox.click() })
  expect(readSuppressNative()).toBe(true)
  const consoleButton = [...view.container.querySelectorAll('button')].find(button => button.textContent === zh.superagentOpenConsole)!
  await act(async () => { consoleButton.click() })
  expect(close).toHaveBeenCalledOnce()
  expect(ctx.layout.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-superagent')
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(ctx.layout.selectPanel.mock.invocationCallOrder[0]!)
  const locate = [...view.container.querySelectorAll('button')].find(button => button.textContent === zh.routerWorkspaceEntry)!
  await act(async () => { locate.click() })
  expect(close).toHaveBeenCalledTimes(2)
  view.dispose()
  dispose()
})

it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main } = fixture(['master'])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('opens the Router Session directly when the catalog omits it', async () => {
  serve()
  const { ctx, main } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})

it('drives the Router switch and deletes a worker conversation, never offering the Router itself', async () => {
  const calls: { path: string; method: string; body?: unknown }[] = []
  const running = { paused: false, reason: '', at: '', by: 'panel' as const }
  const stopped = { paused: true, reason: 'deploy window', at: '2026-09-23T00:00:00Z', by: 'panel' as const }
  let current: typeof running | typeof stopped = running
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const target = new URL(url, 'http://127.0.0.1')
    const path = target.pathname.replace('/orchestrator/api/', '')
    // The query is recorded with the path: `confirm=true` is what the host requires of a deletion, so it must be visible.
    calls.push({ path: path + target.search, method: init?.method ?? 'GET',
      ...init?.body ? { body: JSON.parse(init.body) as unknown } : {} })
    if (path === 'router-sessions') return Response.json({ masterId: 'master', items: [
      { sessionId: 'master', title: 'Router', updatedAt: 1_000, running: false, agentAvailable: true },
      { sessionId: 'worker-t1', title: 'worker-t1', updatedAt: 2_000, running: false, agentAvailable: true }] })
    if (path === 'state') return Response.json({ masterId: 'master', router: current })
    if (path === 'router/stop') { current = stopped; return Response.json(current) }
    if (path === 'router/start') { current = running; return Response.json(current) }
    if (path.startsWith('sessions/')) return Response.json({ sessionId: 'worker-t1', kind: 'worker', archived: true,
      detached: [], projections: 'absent', log: { state: 'removed', path: '/sessions/worker-t1' } })
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }))
  const { settings, dispose } = fixture([])
  const view = await render(settings, { t, close: vi.fn(), openSession: vi.fn(), openPanel: vi.fn() })
  const button = (label: string) => [...view.container.querySelectorAll('button')]
    .find(item => item.textContent?.includes(label)) as HTMLButtonElement | undefined
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
  // Running: the state line says so, a reason field and a stop button are offered, and only the worker row carries a
  // delete button — the Router's own conversation cannot delete itself and never offers one.
  expect(view.container.textContent).toContain(t('routerRunning'))
  expect(view.container.querySelectorAll('.dsr-delete')).toHaveLength(1)
  await act(async () => { button(t('routerStop'))!.click() })
  await settle()
  expect(calls.find(call => call.path === 'router/stop')).toMatchObject({ method: 'POST', body: { reason: '' } })
  // Stopped: the start button replaces the stop one, and the line carries the reason and time the host recorded.
  expect(view.container.textContent).toContain(t('routerStopped'))
  expect(view.container.textContent).toContain('deploy window')
  expect(button(t('routerStop'))).toBeUndefined()
  await act(async () => { button(t('routerStart'))!.click() })
  await settle()
  expect(calls.find(call => call.path === 'router/start')).toMatchObject({ method: 'POST' })
  // A deletion asks through the browser's own confirmation and then sends the `confirm` the host requires.
  const confirmed = vi.fn(() => true)
  vi.stubGlobal('confirm', confirmed)
  await act(async () => { (view.container.querySelector('.dsr-delete') as HTMLButtonElement).click() })
  await settle()
  expect(confirmed).toHaveBeenCalled()
  expect(calls.find(call => call.path.startsWith('sessions/'))).toMatchObject({ method: 'DELETE' })
  expect(calls.find(call => call.path.startsWith('sessions/'))?.path).toBe('sessions/worker-t1?confirm=true')
  // The deleted row leaves the list without another host read.
  expect(view.container.querySelectorAll('.dsr-delete')).toHaveLength(0)
  view.dispose(); dispose()
})

it('words a refused Router control write in place, keeping the page usable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'router-sessions') return Response.json({ masterId: 'master', items: [] })
    if (path === 'state') return Response.json({ masterId: 'master', router: { paused: true, reason: 'x', at: '2026-09-23T00:00:00Z',
      by: 'tool' } })
    if (path === 'router/start' && init?.method === 'POST') return Response.json({ error: 'The Router is already running',
      code: 'alreadyRunning' }, { status: 409 })
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }))
  const { settings, dispose } = fixture([])
  const view = await render(settings, { t, close: vi.fn(), openSession: vi.fn(), openPanel: vi.fn() })
  const start = [...view.container.querySelectorAll('button')].find(item => item.textContent?.includes(t('routerStart')))!
  await act(async () => { start.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  // The host's own sentence is shown, and the switch still offers its buttons.
  expect(view.container.textContent).toContain('The Router is already running')
  expect([...view.container.querySelectorAll('button')].some(item => item.textContent?.includes(t('routerStart')))).toBe(true)
  view.dispose(); dispose()
})
