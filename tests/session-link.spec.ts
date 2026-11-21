/**
 * The two pieces a Router message needs to point at the worker it is about: the conversation's title, and a link that
 * opens it.
 *
 * The title is what DSH lists and what the link shows, so it is clipped to the same byte budget the host keeps (80 bytes
 * for the whole title, 56 for the ticket's own words) and never in the middle of a code point: a CJK title is the case
 * that made the host's own cut unreadable. The link is Markdown, because the transcript renders Markdown: DSH hands
 * `http(s)` links to the browser and leaves every other scheme to this bundle's client, which intercepts the click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_HASH_PREFIX, SESSION_LINK_PREFIX, sessionIdOfHref, sessionLink } from '../src/app/session-link.ts'
import { loadSessionTitles } from '../src/client/session-links.ts'
import { clipUtf8, workerTitle } from '../src/executor/dsh.ts'

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')

describe('clipUtf8', () => {
  it('leaves text within the budget untouched', () => {
    expect(clipUtf8('short title', 56)).toBe('short title')
  })

  it('cuts on a code point, never through one', () => {
    // Each of these characters is three bytes: a byte-boundary cut would leave a lone surrogate or a replacement mark.
    const text = '预览联调验证'
    const clipped = clipUtf8(text, 7)
    expect(bytes(clipped)).toBeLessThanOrEqual(7)
    expect(text.startsWith(clipped)).toBe(true)
    expect(clipped).toBe('预览')
    expect(clipped).not.toContain('\uFFFD')
  })

  it('drops the trailing space a cut can leave', () => {
    expect(clipUtf8('abc def', 4)).toBe('abc')
  })
})

describe('workerTitle', () => {
  const ticket = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', title: '预览联调：验证 worker 会话命名与跳转链接' }

  it('names the conversation after the ticket, with the short id a person recognizes', () => {
    expect(workerTitle(ticket)).toBe('worker-a1b2c3d4 · 预览联调：验证 worker 会话命名与跳转链接')
  })

  it('keeps a long title inside the bytes DSH stores, with the prefix intact', () => {
    const long = { ...ticket, title: '这一行标题很长'.repeat(20) }
    const title = workerTitle(long)
    expect(bytes(title)).toBeLessThanOrEqual(80)
    expect(title.startsWith('worker-a1b2c3d4 · ')).toBe(true)
    expect(title).not.toContain('\uFFFD')
  })

  it('names a ticket with no title at all by its id alone', () => {
    expect(workerTitle({ ...ticket, title: '' })).toBe('worker-a1b2c3d4 · ')
  })
})

describe('sessionLink', () => {
  it('builds the Markdown link the client knows how to open', () => {
    expect(sessionLink('worker-1', 'worker-a1b2c3d4 · Fix the list'))
      .toBe('[worker-a1b2c3d4 · Fix the list](dsh://session/worker-1)')
  })

  it('never lets the label end the link early', () => {
    expect(sessionLink('worker-1', 'a [b] c')).toBe('[a b c](dsh://session/worker-1)')
  })

  it('falls back to the bare label when there is no conversation to open', () => {
    expect(sessionLink('', 'worker-a1b2c3d4 · Fix the list')).toBe('worker-a1b2c3d4 · Fix the list')
  })
})

describe('loadSessionTitles', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /** The two reads the linkifier makes, answered from one stub keyed by path. */
  const serve = (answers: Record<string, unknown>): void => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://127.0.0.1').pathname.split('/').at(-1)!
      return path in answers ? Response.json(answers[path]) : Response.json({ error: 'unavailable' }, { status: 503 })
    }))
  }

  it('reads a worker title from the projection seat the host fills, so the transcript can link to it', async () => {
    // Measured shape on this machine: `dsh-sessions` carries no `title` field, only `projections.values.title`.
    serve({
      'router-sessions': { masterId: 'session-r', items: [{ sessionId: 'session-r', title: 'Router（常驻）' }] },
      'dsh-sessions': { items: [
        { sessionId: 'worker-3e7503559090ac72f7c4d26f95654fee',
          projections: { values: { title: 'worker-3e750355 · 可视化验证：常驻 worker' } } },
        // Not a worker: matching it would turn ordinary prose into a link.
        { sessionId: 'session-plain', projections: { values: { title: 'Fix the parser' } } },
      ] },
    })
    expect(await loadSessionTitles()).toEqual([
      { sessionId: 'session-r', title: 'Router（常驻）' },
      { sessionId: 'worker-3e7503559090ac72f7c4d26f95654fee', title: 'worker-3e750355 · 可视化验证：常驻 worker' },
    ])
  })

  it('keeps the worker titles when the Router group read fails, and the other way round', async () => {
    serve({ 'dsh-sessions': { items: [{ sessionId: 'worker-a7ef0ab4', title: 'worker-a7ef0ab4 · 演示' }] } })
    expect((await loadSessionTitles()).map(row => row.sessionId)).toEqual(['worker-a7ef0ab4'])
    serve({ 'router-sessions': { masterId: 'session-r', items: [{ sessionId: 'session-r', title: 'Router（常驻）' }] } })
    expect((await loadSessionTitles()).map(row => row.sessionId)).toEqual(['session-r'])
  })
})

describe('sessionIdOfHref', () => {
  it('reads the scheme this bundle writes', () => {
    expect(sessionIdOfHref(`${SESSION_LINK_PREFIX}worker-a1b2c3d4`)).toBe('worker-a1b2c3d4')
    expect(sessionIdOfHref(`${SESSION_LINK_PREFIX}session-0d566971`)).toBe('session-0d566971')
  })

  it('reads the hash spelling too, for a host that drops an unknown scheme', () => {
    expect(sessionIdOfHref(`${SESSION_HASH_PREFIX}worker-a1b2c3d4`)).toBe('worker-a1b2c3d4')
  })

  it('ignores every other link', () => {
    for (const href of ['https://example.com', '/settings', '#session', 'dsh://ticket/1', 'mailto:a@b.c', ''])
      expect(sessionIdOfHref(href)).toBeUndefined()
  })
})
