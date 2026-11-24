// @vitest-environment jsdom
/**
 * The Router page is the only place a Router can be replaced or deleted.
 *
 * The conversations themselves are listed natively by the sidebar, in the group their own Workspace draws, so this page
 * carries every control write over them: archive-and-refresh a bound project Router, and delete a conversation that is
 * no longer the live generation. Losing either action would leave a Router that can never be replaced and a dead
 * generation that can never be removed, with no other surface in the product that offers them.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterWorkspacePanel } from '../src/client/router-panel.tsx'
import { zh } from '../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = ((key: keyof typeof zh) => zh[key] ?? key) as never

/** One host answer per endpoint, so a case states only what it is about. */
function serve(answers: { sessions?: unknown[]; managed?: unknown[] }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'router-sessions') return Response.json({ masterId: 'session-live', items: answers.sessions ?? [] })
    if (path === 'state') return Response.json({ router: { paused: false }, masterId: 'session-live' })
    if (path === 'managed-routers') {
      // The endpoint wraps each row in `identity`, and the client unwraps it; a bare row here would exercise a shape
      // the host never sends.
      const rows = (answers.managed ?? []).map(identity => ({ identity }))
      return Response.json({ items: rows, total: rows.length })
    }
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }))
}

/** Render the page and let its first poll settle. */
async function render(): Promise<HTMLElement> {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<RouterWorkspacePanel t={t} close={() => {}} openSession={() => {}} openPanel={() => {}} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return container
}

const button = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(item => (item.textContent ?? '').trim() === label) as HTMLButtonElement | undefined

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('the Router page controls', () => {
  /**
   * Archive-and-refresh is the only way a bound project Router is ever replaced. A managed Router page that does not
   * offer it leaves every project on its first generation forever.
   */
  it('offers archive-and-refresh for the live generation of a bound project Router', async () => {
    serve({ sessions: [{ sessionId: 'session-live', title: 'Router', updatedAt: 1_000, running: false, agentAvailable: true, atHome: true }],
      managed: [{ routerId: 'router-primary', projectId: 'project-1', sessionId: 'session-live', generation: 6 }] })
    const container = await render()
    expect(button(container, zh.routerRefresh)).toBeDefined()
  })

  /**
   * The live generation cannot delete itself: the host refuses, and offering the button would invite a person to try.
   * Any other Router conversation is deletable, which is how a replaced generation is cleaned up.
   */
  it('offers delete for a replaced Router, and not for the live generation', async () => {
    serve({ sessions: [
      { sessionId: 'session-live', title: 'Router', updatedAt: 2_000, running: false, agentAvailable: true, atHome: false },
      { sessionId: 'session-old', title: 'Router (old)', updatedAt: 1_000, running: false, agentAvailable: false, atHome: false },
    ] })
    const container = await render()
    // One delete button, on the non-live row: the live generation offers none.
    expect([...container.querySelectorAll('button.dsr-page-delete')]).toHaveLength(1)
    expect(button(container, zh.routerDelete)).toBeDefined()
  })

  /** A conversation on the page still opens: the page is a second door to the same Sessions. */
  it('opens a listed conversation', async () => {
    const openSession = vi.fn()
    serve({ sessions: [{ sessionId: 'session-abc', title: 'Router', updatedAt: 1_000, running: false, agentAvailable: true, atHome: true }] })
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<RouterWorkspacePanel t={t} close={() => {}} openSession={openSession} openPanel={() => {}} />) })
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => { container.querySelector<HTMLButtonElement>('.dsr-row-open')!.click() })
    expect(openSession).toHaveBeenCalledWith('session-abc')
  })

  /**
   * The page used to carry the switch that hid a duplicate native row, because the Router was listed both in the
   * virtual group and in the project Workspace. The Router has its own Workspace now, so there is no duplicate to hide
   * and no switch to offer: a leftover checkbox would be a control with nothing behind it.
   */
  it('no longer offers a visibility switch for a duplicate row', async () => {
    serve({})
    const container = await render()
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  })
})
