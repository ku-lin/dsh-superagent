// @vitest-environment jsdom
/**
 * The Router door in the sidebar foot.
 *
 * The Router's conversations are listed natively by the sidebar, in the group its own Workspace draws. That group sits
 * among every other Workspace, so this foot button is what keeps a permanent conversation one click away. It only
 * navigates: it never lists, hides or moves a row, which is why it cannot disagree with the native group.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterFooterAction } from '../src/client/router-footer.tsx'
import { zh } from '../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = ((key: keyof typeof zh) => zh[key] ?? key) as never

/** One host answer for the Router list, which is where the conversation id comes from. */
function serve(items: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'router-sessions') return Response.json({ masterId: items[0] ? (items[0] as { sessionId: string }).sessionId : '', items })
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }))
}

async function render(props: { wide?: boolean; openSession?: (id: string) => void; openPanel?: () => void } = {}): Promise<HTMLElement> {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<RouterFooterAction t={t} wide={props.wide ?? true}
      openSession={props.openSession ?? (() => {})} openPanel={props.openPanel ?? (() => {})} />)
  })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return container
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('the Router footer action', () => {
  /** The id comes from the host, so a replaced Router (a new Session) never leaves the button pointing at a dead one. */
  it('opens the conversation the host reports as the permanent one', async () => {
    const openSession = vi.fn()
    serve([{ sessionId: 'session-live', title: 'Router', updatedAt: 1_000, running: false, agentAvailable: true, atHome: true }])
    const container = await render({ openSession })
    const button = container.querySelector<HTMLButtonElement>('.dt-footer-router')!
    expect(button).not.toBeNull()
    await act(async () => { button.click() })
    expect(openSession).toHaveBeenCalledWith('session-live')
  })

  /**
   * With no conversation readable there is nothing to open, and a dead button is worse than none: it falls back to the
   * management panel, which is where a Router can be started or inspected.
   */
  it('falls back to the management panel when no conversation resolves', async () => {
    const openPanel = vi.fn()
    serve([])
    const container = await render({ openPanel })
    await act(async () => { container.querySelector<HTMLButtonElement>('.dt-footer-router')!.click() })
    expect(openPanel).toHaveBeenCalledOnce()
  })

  /** Collapsed to the 56px rail there is no room for a label; the icon keeps its accessible name either way. */
  it('drops the text on the collapsed rail but keeps the accessible name', async () => {
    serve([{ sessionId: 'session-live', title: 'Router', updatedAt: 1_000, running: false, agentAvailable: true, atHome: true }])
    const wide = await render({ wide: true })
    expect(wide.querySelector('.dt-footer-router-text')?.textContent).toBe(zh.routerFooterOpen)
    document.body.innerHTML = ''
    const rail = await render({ wide: false })
    expect(rail.querySelector('.dt-footer-router-text')).toBeNull()
    expect(rail.querySelector('.dt-footer-router')?.getAttribute('aria-label')).toBe(zh.routerFooterOpen)
  })
})
