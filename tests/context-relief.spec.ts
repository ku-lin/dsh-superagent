/**
 * Deterministic context relief: the rules, and the step-boundary behaviour that keeps a conversation inside its window
 * when the summarising compaction cannot land a checkpoint.
 */
import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import {
  RELIEF_RETAIN_RATIO,
  RELIEF_THRESHOLD_RATIO,
  installContextRelief,
  planRelief,
  priceSurface,
  reliefMessage,
} from '../src/app/context-relief.ts'

const SESSION_ID = 'session-00000000-0000-4000-8000-0000000000aa' as never

/**
 * Append the compaction plugin's opening marker. `compaction/*` is declared by the compaction plugin, so the session
 * package's own event union does not name it; the spec reaches it through one structural shim instead of loosening the
 * production types.
 */
const appendCompactionEvent = (session: Session, type: 'compaction/start' | 'compaction/end'): void => {
  (session as unknown as { append(t: string, d: unknown): unknown }).append(type, { compactionId: 'c-1' })
}

/** A session with `turns` user messages of `chars` characters each and an advertised window. */
const buildSession = (options: { turns: number; chars: number; contextWindow?: number; system?: boolean }): Session => {
  const session = Session.create(SESSION_ID)
  if (options.system === true) {
    session.append('system/message', { id: 'sys', role: 'system', content: [{ type: 'text', text: 'instructions' }], source: { kind: 'system-prompt' } } as never, { surfaceOp: 'append' })
  }
  session.append('request/header', { header: { config: { provider: 'pool', model: 'main' } }, reason: 'initial' } as never)
  if (options.contextWindow !== undefined) {
    session.append('request/context', { provider: 'pool', model: 'main', contextWindow: options.contextWindow } as never)
  }
  for (let index = 0; index < options.turns; index += 1) {
    session.append('user/message', {
      id: `u-${index}`,
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(options.chars) }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })
  }
  return session
}

describe('planRelief', () => {
  it('does nothing below the relief threshold', () => {
    // 10 turns x 400 chars = 4000 chars ~ 1000 tokens, far under 0.8 of a 100k window.
    const session = buildSession({ turns: 10, chars: 400, contextWindow: 100_000 })
    assert.equal(planRelief(session, 100_000), null)
  })

  it('drops the oldest span once the estimate crosses the threshold, keeping a recent tail', () => {
    const window = 4_000
    // 40 turns x 400 chars = 16k chars ~ 4k tokens: at the window, so relief must act.
    const session = buildSession({ turns: 40, chars: 400, contextWindow: window })
    const priced = priceSurface(session)
    expect(priced.total).toBeGreaterThanOrEqual(Math.floor(window * RELIEF_THRESHOLD_RATIO))
    const plan = planRelief(session, window)
    assert.ok(plan, 'a plan is required at the threshold')
    expect(plan.totalTokens).toBeGreaterThanOrEqual(plan.thresholdTokens)
    expect(plan.keptTokens).toBeGreaterThanOrEqual(Math.floor(window * RELIEF_RETAIN_RATIO))
    expect(plan.droppedTokens).toBeGreaterThan(0)
    expect(plan.end).toBeLessThan(priced.nodes.at(-1)!)
  })

  it('never drops a leading system prompt', () => {
    const window = 2_000
    const session = buildSession({ turns: 40, chars: 400, contextWindow: window, system: true })
    const nodes = [...session.surface.nodes]
    const plan = planRelief(session, window)
    assert.ok(plan)
    expect(plan.start).not.toBe(nodes[0])
  })

  it('does not act without an advertised window', () => {
    const session = buildSession({ turns: 40, chars: 400 })
    assert.equal(planRelief(session, Number.NaN), null)
    assert.equal(planRelief(session, 0), null)
  })

  it('never splits a tool-call/tool-result pair', () => {
    const window = 3_000
    const session = Session.create(SESSION_ID)
    session.append('request/context', { provider: 'pool', model: 'main', contextWindow: window } as never)
    for (let index = 0; index < 6; index += 1) {
      session.append('user/message', {
        id: `u-${index}`, role: 'user', content: [{ type: 'text', text: 'y'.repeat(1_200) }], source: { kind: 'user' },
      } as never, { surfaceOp: 'append' })
      // One assistant tool call and its result: a cut between them would be unbalanced.
      session.append('assistant/message', {
        turn: index, step: 1, stream: [],
        message: {
          id: `a-${index}`, role: 'assistant', source: { kind: 'model', provider: 'pool', model: 'main' },
          content: [{ type: 'tool-call', id: `call-${index}`, name: 'read', arguments: '{}' }],
        },
      } as never, { surfaceOp: 'append' })
      session.append('tool/result', {
        turn: index, step: 1,
        message: {
          id: `r-${index}`, role: 'tool', toolCallId: `call-${index}`, isError: false,
          source: { kind: 'tool', callId: `call-${index}` },
          content: [{ type: 'text', text: 'z'.repeat(1_200) }],
        },
      } as never, { surfaceOp: 'append' })
    }
    const plan = planRelief(session, window)
    assert.ok(plan, 'the surface is over the threshold')
    const nodes = [...session.surface.nodes]
    const cutIndex = nodes.indexOf(plan.end as never) + 1
    // The retained tail must start on a user message, never inside a call/result pair.
    expect(session.eventAt(nodes[cutIndex]!)?.type).toBe('user/message')
  })
})

describe('reliefMessage', () => {
  it('states plainly that content was dropped without a model', () => {
    const message = reliefMessage({ start: 3, end: 9, totalTokens: 5_000, thresholdTokens: 4_000, droppedTokens: 3_200, keptTokens: 900 }, 'relief-1')
    const text = message.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('')
    expect(text).toContain('dropped without a model')
    expect(text).toContain('not summarised')
  })
})

describe('installContextRelief', () => {
  /** Minimal host capturing the listener so the test drives the step itself. */
  const host = (): { ctx: never; fire: (payload: unknown) => Promise<unknown>; installs: number } => {
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    let installs = 0
    const ctx = {
      get: () => undefined,
      on: (_event: string, fn: typeof listener) => { listener = fn },
      effect: (fn: () => () => void) => { installs += 1; return fn() },
    }
    return {
      ctx: ctx as never,
      installs,
      fire: async payload => {
        assert.ok(listener, 'listener registered')
        return listener(payload, async () => ({ kind: 'proceed' }))
      },
    }
  }

  it('shrinks the surface when the summariser left the conversation over the threshold', async () => {
    const window = 4_000
    const session = buildSession({ turns: 40, chars: 400, contextWindow: window })
    const before = priceSurface(session).total
    const { ctx, fire } = host()
    installContextRelief(ctx)
    const decision = await fire({ agent: { session, sessionId: SESSION_ID, options: {} }, signal: new AbortController().signal })
    assert.deepEqual(decision, { kind: 'retry' }, 'the step restarts on the relieved surface')
    const after = priceSurface(session).total
    expect(after).toBeLessThan(before)
    expect(after).toBeLessThan(Math.floor(window * RELIEF_THRESHOLD_RATIO))
  })

  it('leaves a healthy conversation untouched', async () => {
    const session = buildSession({ turns: 5, chars: 200, contextWindow: 100_000 })
    const before = [...session.surface.nodes]
    const { ctx, fire } = host()
    installContextRelief(ctx)
    const decision = await fire({ agent: { session, sessionId: SESSION_ID, options: {} }, signal: new AbortController().signal })
    assert.deepEqual(decision, { kind: 'proceed' })
    assert.deepEqual([...session.surface.nodes], before)
  })

  it('stands down while a compaction transaction is open', async () => {
    const window = 4_000
    const session = buildSession({ turns: 40, chars: 400, contextWindow: window })
    appendCompactionEvent(session, 'compaction/start')
    const before = [...session.surface.nodes]
    const { ctx, fire } = host()
    installContextRelief(ctx)
    const decision = await fire({ agent: { session, sessionId: SESSION_ID, options: {} }, signal: new AbortController().signal })
    assert.deepEqual(decision, { kind: 'proceed' })
    assert.deepEqual([...session.surface.nodes], before)
  })

  it('resumes normal summarising behaviour once the compaction lock closes', async () => {
    const window = 4_000
    const session = buildSession({ turns: 40, chars: 400, contextWindow: window })
    appendCompactionEvent(session, 'compaction/start')
    appendCompactionEvent(session, 'compaction/end')
    const { ctx, fire } = host()
    installContextRelief(ctx)
    const decision = await fire({ agent: { session, sessionId: SESSION_ID, options: {} }, signal: new AbortController().signal })
    assert.deepEqual(decision, { kind: 'retry' }, 'relief is available again after the summariser finished')
  })
})
