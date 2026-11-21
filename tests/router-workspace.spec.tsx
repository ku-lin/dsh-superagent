// @vitest-environment jsdom
/**
 * The virtual Router workspace group's hiding rule: every row the group renders must disappear from the workspace list
 * the shell renders, and nothing may disappear when hiding could cost the person a conversation.
 *
 * The rule is a plugin-owned `<style>` element, so these cases read its text rather than a screenshot: the same string
 * a browser would apply. Two facts about membership are pinned here as well: the group lists the router's own
 * conversations only, and a worker row — which is never listed, and which the person wants in its own Workspace — is
 * never named by the rule.
 *
 * Six conditions gate it — the group is mounted, the host read succeeded, the list is not empty, the operator's switch is
 * on, the group is unfolded, and the group is on screen — and any one of them failing must leave the native list
 * untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountRouterWorkspace, readSuppressNative, setSuppressNative } from '../src/client/router-workspace.ts'
import type { T } from '../src/client/text.ts'

const ROUTER = 'session-r1'
const WORKER = 'worker-t-1'
const SUPPRESS = 'dsh-superagent/router-workspace/suppress-native.v2'
const LEGACY = 'dsh-superagent/router-workspace/suppress-native'

const t = ((key: string) => key) as unknown as T

/** One host answer: the rows the group lists, with the fields the real endpoint returns. */
function rows(sessionIds: readonly string[]): unknown {
  return { masterId: ROUTER, items: sessionIds.map((sessionId, index) => ({ sessionId,
    ...sessionId === ROUTER ? { title: 'Router（常驻）' } : { title: `worker-${index} · 修一` },
    cwd: 'S:\\deepseek_harness', updatedAt: 1_000 + index, running: index % 2 === 1, agentAvailable: true })) }
}

/**
 * The shell's workspace list: a wrapper whose children are the native rows, exactly as the real browser renders them.
 * Both rows are there — the router's own, and a worker's, which belongs to this Workspace and must keep its row.
 */
function anchor(): HTMLElement {
  document.body.innerHTML = `<div data-slot="sidebar.workspaces"><div class="list">
    <div data-row-key="session:${ROUTER}"></div><div data-row-key="session:${WORKER}"></div></div></div>`
  return document.querySelector('.list') as HTMLElement
}

/** The plugin-owned rule element, which outlives renders and is removed on dispose. */
const rule = (): HTMLStyleElement | null =>
  document.querySelector('style[data-plugin-css="dsh-superagent/router-workspace-migrated"]')

const group = (): HTMLElement | null => document.querySelector('[data-router-workspace]')

/** Let the mount's first poll settle: fetch plus the awaited JSON read. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * jsdom has no layout engine: every element measures zero, which this module reads as "nothing is rendered there, so
 * hide nothing". A case therefore gives elements a box — inside the viewport by default, far below it when asked — which
 * is what a mounted, on-screen group measures in a browser.
 */
function layout(top = 100): void {
  const width = 240, height = 30
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    ({ x: 0, y: top, width, height, top, bottom: top + height, left: 0, right: width, toJSON: () => ({}) }) as DOMRect)
}

/** Wait for the scroll handler's next-frame pass, which a real browser runs before the next paint. */
const afterFrame = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40))

const serve = (body: unknown, status = 200): void => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })))
}

let stop: (() => void) | undefined
beforeEach(() => {
  window.localStorage.clear()
  stop = undefined
})
afterEach(() => {
  stop?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('the group hides the rows it renders', () => {
  it('hides the router conversation it lists, and never a worker\'s own row', async () => {
    layout()
    anchor()
    // A host older than this bundle still answers with a worker row; the rule must not name it even then.
    serve(rows([ROUTER, WORKER]))
    const open = vi.fn()
    stop = mountRouterWorkspace({ openSession: open, t: () => t })
    await settle()

    expect(rule()?.textContent?.trim().split('\n')).toEqual([
      `[data-slot="sidebar.workspaces"] [data-row-key="session:${ROUTER}"]{display:none!important}`,
    ])
    // The worker keeps the row in its own Workspace: the rule never names it, even though the group lists it here.
    expect(rule()?.textContent).not.toContain(WORKER)
    // The group renders what the host answered, with running/idle state and clickable rows.
    const rendered = [...group()!.querySelectorAll<HTMLElement>('.dsr-row')]
    expect(rendered.map(row => row.dataset.sessionId)).toEqual([ROUTER, WORKER])
    expect(rendered[0]!.classList.contains('dsr-running')).toBe(false)
    expect(rendered[1]!.classList.contains('dsr-running')).toBe(true)
    expect(rendered[0]!.dataset.status).toBe('idle')
    expect(rendered[1]!.dataset.status).toBe('running')
    expect(rendered[1]!.getAttribute('aria-label')).toContain('workerStatusRunning')
    rendered[1]!.click()
    expect(open).toHaveBeenCalledWith(WORKER)
  })

  it('hides the Router row the group lists when the host answers with it alone', async () => {
    layout()
    anchor()
    serve(rows([ROUTER]))
    const open = vi.fn()
    stop = mountRouterWorkspace({ openSession: open, t: () => t })
    await settle()

    expect(rule()?.textContent?.trim().split('\n')).toEqual([
      `[data-slot="sidebar.workspaces"] [data-row-key="session:${ROUTER}"]{display:none!important}`,
    ])
    expect(rule()?.textContent).not.toContain(WORKER)
    const rendered = [...group()!.querySelectorAll<HTMLElement>('.dsr-row')]
    expect(rendered.map(row => row.dataset.sessionId)).toEqual([ROUTER])
    rendered[0]!.click()
    expect(open).toHaveBeenCalledWith(ROUTER)
  })

  it('hides nothing while the group is folded, so a folded group cannot cost anyone a conversation', async () => {
    layout()
    anchor()
    serve(rows([ROUTER]))
    stop = mountRouterWorkspace({ openSession: vi.fn(), t: () => t })
    await settle()
    expect(rule()?.textContent).toContain(`session:${ROUTER}`)

    group()!.querySelector<HTMLButtonElement>('.dsr-head')!.click()
    expect(rule()?.textContent).toBe('')
    // Unfolding puts the rule back: the group is still on screen and still lists that conversation.
    group()!.querySelector<HTMLButtonElement>('.dsr-head')!.click()
    expect(rule()?.textContent).toContain(`session:${ROUTER}`)
  })

  it('hides nothing while the group is scrolled out of sight, and hides again once it is back', async () => {
    layout(5_000)
    anchor()
    serve(rows([ROUTER]))
    stop = mountRouterWorkspace({ openSession: vi.fn(), t: () => t })
    await settle()
    // The group is pinned to the end of a populated list: until the person scrolls to it, its row stays where it was.
    expect(rule()?.textContent).toBe('')

    vi.restoreAllMocks()
    layout(100)
    window.dispatchEvent(new Event('scroll'))
    await afterFrame()
    expect(rule()?.textContent).toContain(`session:${ROUTER}`)
  })

  it('writes nothing when the host read fails, and says why with a way back', async () => {
    layout()
    anchor()
    serve({ error: 'unavailable' }, 503)
    stop = mountRouterWorkspace({ openSession: vi.fn(), t: () => t })
    await settle()
    expect(rule()?.textContent).toBe('')
    expect(group()!.querySelector('.dsr-note')?.textContent).toContain('routerWorkspaceDegraded')
    // The degraded escape hatch is page-only: it must not pin the operator's switch off for later loads.
    expect(readSuppressNative()).toBe(true)
    group()!.querySelector<HTMLButtonElement>('.dsr-restore')!.click()
    expect(rule()?.textContent).toBe('')
    expect(readSuppressNative()).toBe(true)
  })

  it('writes nothing while the list is empty', async () => {
    layout()
    anchor()
    serve(rows([]))
    stop = mountRouterWorkspace({ openSession: vi.fn(), t: () => t })
    await settle()
    expect(rule()?.textContent).toBe('')
    expect(group()!.querySelector('.dsr-note')?.textContent).toBe('routerWorkspaceEmpty')
  })

  it('writes nothing when the group could not mount, so no row is ever hidden without its replacement', async () => {
    layout()
    document.body.innerHTML = '<div class="nothing"></div>'
    serve(rows([ROUTER]))
    stop = mountRouterWorkspace({ openSession: vi.fn(), t: () => t })
    await settle()
    expect(rule()?.textContent ?? '').toBe('')
  })

  it('turns hiding off and back on again through the exported switch', async () => {
    layout()
    anchor()
    serve(rows([ROUTER]))
    stop = mountRouterWorkspace({ openSession: vi.fn(), t: () => t })
    await settle()
    expect(rule()?.textContent).not.toBe('')

    setSuppressNative(false)
    expect(window.localStorage.getItem(SUPPRESS)).toBe('0')
    expect(rule()?.textContent).toBe('')
    // An off switch that is on by itself is exactly the reported "duplicate came back" state: the group says so and
    // offers one click back.
    const note = group()!.querySelector('.dsr-note')!
    expect(note.textContent).toContain('routerWorkspaceShown')
    note.querySelector<HTMLButtonElement>('.dsr-restore')!.click()
    expect(readSuppressNative()).toBe(true)
    expect(rule()?.textContent).toContain(`session:${ROUTER}`)
  })

  it('ignores the legacy off value the failure path used to leave behind', async () => {
    // Before the versioned key, a single failed read could write `'0'` and every later load silently showed every
    // duplicate row; the old key is not read at all now.
    window.localStorage.setItem(LEGACY, '0')
    layout()
    anchor()
    serve(rows([ROUTER]))
    stop = mountRouterWorkspace({ openSession: vi.fn(), t: () => t })
    await settle()
    expect(rule()?.textContent).toContain(`session:${ROUTER}`)
  })
})
