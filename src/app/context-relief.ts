/**
 * Deterministic context relief for the Router conversation.
 *
 * Compaction summarises through the model. When the summariser route is unavailable (an upstream 503, a timeout, a
 * first-token stall) the summary never lands, so the conversation keeps growing until the routed model itself refuses
 * the request and pi-ai reports `context overflow`. This module is the fallback that needs no model: on each admitted
 * step it prices the live surface, and once the estimate crosses a fixed share of the window it drops the oldest span
 * (keeping a fixed recent tail) through one surface replacement.
 *
 * Rules are pure code. No prompt, no completion, no provider call: the decision is a token estimate and two fixed
 * shares. Cuts land only on a tool-pairing balanced boundary, so a step's tool-call/result pair is never split.
 */
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Share of the routed window above which relief runs.
 *
 * Deliberately ABOVE the summarising policy's own threshold (0.65 in the deployment profile): the model-backed
 * compaction must always get the first chance, so a healthy summariser keeps producing real checkpoints and relief
 * never runs. Reaching this share means compaction has already failed to bring the estimate down — the summariser is
 * unavailable — which is exactly when losing old context beats refusing the request.
 */
export const RELIEF_THRESHOLD_RATIO = 0.8

/** Share of the routed window kept verbatim as the recent tail. */
export const RELIEF_RETAIN_RATIO = 0.2

/** Says plainly that content was dropped without a model, so nobody mistakes it for a summary. */
export const RELIEF_PREAMBLE = 'This conversation grew past the model context window while its automatic summariser was unavailable. '
  + 'The oldest part was dropped without a model, so it is not summarised and decisions recorded there are lost. '
  + 'Continue from the recent turns that follow.'

/** Source marker for the replacement node; distinct from a summarised checkpoint on purpose. */
export interface ReliefSource {
  readonly kind: 'context-relief'
  readonly droppedSeqs: number
  readonly droppedTokens: number
}

/** Rough neutral price for one message's model-visible text, used when no meter estimator is supplied. */
const estimateChars = (blocks: readonly ContentBlock[]): number => {
  let chars = 0
  for (const block of blocks) {
    if (block.type === 'text') chars += block.text.length
    else if (block.type === 'tool-call') chars += block.arguments.length
  }
  return chars
}

/** Price one surface event; log-only events cost nothing. */
const priceEvent = (event: { type?: string; data?: unknown }, estimate?: (message: UserMessage) => number): number => {
  const data = event.data as { content?: readonly ContentBlock[]; message?: { content?: readonly ContentBlock[] } } | undefined
  const blocks = data?.content ?? data?.message?.content
  if (blocks === undefined || blocks.length === 0) return 0
  const chars = estimateChars(blocks)
  const heuristic = Math.max(1, Math.ceil(chars / 4))
  const measured = estimate === undefined ? 0 : estimate({ content: blocks } as UserMessage)
  return Math.max(heuristic, measured)
}

/**
 * Work out which token counts a request will carry, without asking a model.
 * @param session - session whose current surface is priced.
 * @param estimate - optional per-message estimator from the token meter.
 * @returns the positional nodes with their prices, and the total.
 */
export function priceSurface(session: Session, estimate?: (message: UserMessage) => number): { nodes: SessionSeq[]; tokens: number[]; total: number } {
  const nodes = [...session.surface.nodes]
  const tokens = nodes.map(seq => priceEvent(session.eventAt(seq) as never, estimate))
  return { nodes, tokens, total: tokens.reduce((sum, value) => sum + value, 0) }
}

/** Whether the cut immediately before `index` leaves no tool-call/result pair open. */
const balancedBefore = (session: Session, nodes: readonly SessionSeq[], index: number): boolean => {
  let open = 0
  for (let position = 0; position < index; position += 1) {
    const event = session.eventAt(nodes[position]!)
    if (event?.type === 'assistant/message') {
      const content = (event.data as { message: { content: readonly ContentBlock[] } }).message.content
      open += content.filter(block => block.type === 'tool-call').length
    } else if (event?.type === 'tool/result') {
      open -= 1
    }
  }
  return open === 0
}

/** The span relief would drop, plus the accounting that justified it. */
export interface ReliefPlan {
  readonly start: number
  readonly end: number
  readonly totalTokens: number
  readonly thresholdTokens: number
  readonly droppedTokens: number
  readonly keptTokens: number
}

/**
 * Decide whether to drop history, and exactly which span.
 *
 * `null` covers every case where relief must not act: no window, nothing to drop, below the threshold, or no balanced
 * boundary available. Staying silent is deliberate — a wrong cut would lose live context for no benefit.
 *
 * @param session - session whose live surface is inspected.
 * @param contextWindow - routed window in tokens.
 * @param estimate - optional per-message estimator from the token meter.
 * @returns the plan, or null when nothing should be dropped.
 */
export function planRelief(session: Session, contextWindow: number, estimate?: (message: UserMessage) => number): ReliefPlan | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null
  const priced = priceSurface(session, estimate)
  if (priced.nodes.length === 0) return null
  const thresholdTokens = Math.floor(contextWindow * RELIEF_THRESHOLD_RATIO)
  if (priced.total < thresholdTokens) return null
  // A leading system prompt stays: the model needs its instructions to answer at all.
  const firstIdx = session.eventAt(priced.nodes[0]!)?.type === 'system/message' ? 1 : 0
  const retainTokens = Math.floor(contextWindow * RELIEF_RETAIN_RATIO)
  let keepFrom = priced.nodes.length
  let kept = 0
  for (let index = priced.nodes.length - 1; index >= 0; index -= 1) {
    kept += priced.tokens[index]!
    keepFrom = index
    if (kept >= retainTokens) break
  }
  // Walk the cut back to the nearest balanced boundary; never split a step's tool pair.
  let cut = keepFrom
  while (cut > firstIdx && !balancedBefore(session, priced.nodes, cut)) cut -= 1
  if (cut <= firstIdx) return null
  const droppedTokens = priced.tokens.slice(firstIdx, cut).reduce((sum, value) => sum + value, 0)
  return {
    start: priced.nodes[firstIdx]!,
    end: priced.nodes[cut - 1]!,
    totalTokens: priced.total,
    thresholdTokens,
    droppedTokens,
    keptTokens: priced.tokens.slice(cut).reduce((sum, value) => sum + value, 0),
  }
}

/** Build the single replacement message that carries the relief notice. */
export function reliefMessage(plan: ReliefPlan, messageId: string): UserMessage {
  return {
    id: messageId as never,
    role: 'user',
    content: [{ type: 'text', text: `${RELIEF_PREAMBLE}\n\n(dropped ${plan.start}..${plan.end}: ~${plan.droppedTokens} estimated tokens; ~${plan.keptTokens} kept)` }],
    source: { kind: 'context-relief', droppedSeqs: plan.end - plan.start + 1, droppedTokens: plan.droppedTokens } as never,
  }
}

/** Structural view of the pieces relief needs; keeps this module free of runner imports. */
export interface ReliefHost {
  readonly ctx: {
    get(name: string): unknown
    on(event: string, listener: (payload: { agent: ReliefAgent; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>): void
  }
}

interface ReliefAgent {
  readonly sessionId: string
  readonly session: Session
  readonly options: { readonly provider?: string; readonly model?: string }
}

/** Advertised window of the routed request, as the session log recorded it. */
const routedWindow = (session: Session): number | undefined => {
  const context = (session as unknown as { requestContext(): { contextWindow?: number } | undefined }).requestContext()
  const window = context?.contextWindow
  return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined
}

/**
 * Whether a compaction transaction is currently open on this session.
 *
 * Relief must never race the summarising engine: compaction holds a durable lock between `compaction/start` and
 * `compaction/end`, and replacing the surface underneath it would make its prepared range invalid (and vice versa).
 * Only an unmatched `compaction/start` counts; a closed pair means the engine is free.
 */
const compactionInFlight = (session: Session): boolean => {
  // `compaction/*` is declared by the compaction plugin, not by the session package, so the log union has to be read
  // structurally here rather than through the narrowed event type.
  const events = session.snapshotEvents() as readonly { type: string }[]
  let open = false
  for (const event of events) {
    if (event.type === 'compaction/start') open = true
    else if (event.type === 'compaction/end') open = false
  }
  return open
}

/**
 * Install deterministic relief on one agent's step boundary.
 *
 * Runs after `next()`, so it observes the surface the step is about to send, and does nothing while the ordinary
 * summarising compaction is healthy or in flight — it only acts once the estimate has already crossed the relief
 * threshold, which is the state a failing summariser leaves behind.
 *
 * @param ctx - plugin context whose event bus carries `agent/pre-step`.
 * @param estimate - per-message estimator; falls back to the plugin's own character heuristic.
 * @returns a disposer that stops relieving.
 */
export function installContextRelief(ctx: ReliefHost['ctx'], estimate?: (message: UserMessage) => number): () => void {
  const listener = async (payload: { agent: ReliefAgent; signal: AbortSignal }, next: () => Promise<unknown>): Promise<unknown> => {
    const decision = await next()
    try {
      if (payload.signal.aborted) return decision
      const session = payload.agent.session
      if (compactionInFlight(session)) return decision
      const window = routedWindow(session)
      if (window === undefined) return decision
      const plan = planRelief(session, window, estimate)
      if (plan === null) return decision
      const replacement = reliefMessage(plan, `relief-${String(session.surface.replaceGeneration)}-${String(plan.end)}`)
      session.append('user/message', replacement, {
        surfaceOp: { op: 'replace', startSeq: plan.start as never, endSeq: plan.end as never },
        sourceEventSeqs: [...session.surface.nodes.filter(seq => seq >= plan.start && seq <= plan.end)] as never,
      })
      return { kind: 'retry' }
    } catch {
      // Relief is a safety net: when it cannot act, the step proceeds unchanged and the request reports its own error.
      return decision
    }
  }
  const dispose = (ctx as unknown as { effect(fn: () => () => void, label?: string): () => void })
    .effect(() => {
      const off = (ctx as unknown as { on(event: string, listener: unknown): (() => void) | void }).on('agent/pre-step', listener)
      return typeof off === 'function' ? off : () => {}
    }, 'dsh-superagent: deterministic context relief')
  return dispose
}
