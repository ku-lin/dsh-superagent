/**
 * Claims end to end: an assessment declares paths, the accept records them on the Mandate, and the
 * hook gets a chance to refuse one outside the project root before any worker exists.
 *
 * The reason this needs its own test rather than trusting the unit tests in `claims.spec.ts`: those
 * prove the path arithmetic, and this proves the declaration actually travels from the assessment
 * through `policy.assessmentOutcome` into `Mandate` — the part where a field can silently go missing
 * because every layer takes it as optional.
 */
import { describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories } from '../src/core/index.ts'
import type { Assessor, Candidate, EngineOptions, Executor, OutboundMessage, Policy, Trigger } from '../src/core/index.ts'
import { assessmentOutcome, type Assessment, type Settings } from '../src/policy.ts'

const member = { source: 'chat', id: 'alice' }

const trigger = (id: string): Trigger => ({
  id,
  source: 'chat',
  threads: [{ source: 'chat', id: 't1' }],
  actor: member,
  human: true,
  at: `2026-11-23T00:00:0${id}Z`,
  text: `message ${id}`,
  channel: { source: 'chat', thread: 't1', address: { message: id } },
  meta: {},
})

/** The smallest engine that can accept one explicit request, with an optional claims hook. */
function harness(resolveClaims?: EngineOptions['resolveClaims']) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) }, release: () => {} }
  const outbox: OutboundMessage[] = []
  const policy: Policy = {
    version: 'v1',
    paused: false,
    evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true,
    admitsInferred: () => true,
  }
  const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }
  const engine = new Engine({
    repo,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor,
    executor,
    outbox: { send: message => { outbox.push(message) }, status: () => undefined, withdraw: () => {} },
    now: () => '2026-11-23T00:00:00.000Z',
    ...(resolveClaims ? { resolveClaims } : {}),
  })
  const accept = (outcome: Parameters<typeof engine.decide>[1]) => {
    engine.receive(trigger('1'))
    engine.evaluateDue()
    const candidate = requests.at(-1)!
    return engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId } as never)
  }
  return { repo, engine, accept }
}

describe('claims on the Mandate', () => {
  it('records the declared paths when the accept names them', () => {
    const h = harness()
    const decision = h.accept({ kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', claims: ['src/panel/'] })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.mandate.claims).toEqual(['src/panel/'])
  })

  it('leaves the claim absent rather than empty when nothing was declared', () => {
    // `claims: []` and "no claims" would read the same at the write site, so they must not be stored
    // the same way: an empty array looks like a decision, and there was none.
    const h = harness()
    const decision = h.accept({ kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.mandate.claims).toBeUndefined()
  })

  it('passes the declaration through the resolve hook so a host can normalise it', () => {
    const seen: string[][] = []
    const h = harness((claims, ticket) => {
      seen.push([...claims])
      expect(ticket.title).toBe('Fix')
      return claims.map(claim => `/project/${claim.replace(/\/$/, '')}`)
    })
    const decision = h.accept({ kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', claims: ['src/panel/'] })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(seen).toEqual([['src/panel/']])
    expect(ticket.mandate.claims).toEqual(['/project/src/panel'])
  })

  it('records nothing when the hook resolves the declaration away', () => {
    const h = harness(() => [])
    const decision = h.accept({ kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', claims: ['src/'] })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.mandate.claims).toBeUndefined()
  })

  it('propagates a refusal from the hook before any ticket is created', () => {
    // Refusing here is the point: a path outside the project root must not reach a worker at all.
    const h = harness(() => { throw new Error('a claim must stay inside the project root') })
    expect(() => h.accept({ kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', claims: ['../elsewhere'] }))
      .toThrow(/inside the project root/)
    expect([...h.repo.tickets.list?.() ?? []].length).toBe(0)
  })

  it('keeps scope and claims separate: scope is the receiving scope, not a path set', () => {
    const h = harness()
    const decision = h.accept({ kind: 'accept', title: 'Fix', scope: 'feishu scope text', reason: 'requested', claims: ['docs/a.md'] })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.mandate.scope).toBe('feishu scope text')
    expect(ticket.mandate.claims).toEqual(['docs/a.md'])
  })
})

describe('assessmentOutcome carries claims', () => {
  const settings = {
    policy: { version: 'v1', rules: [{ id: 'r1', name: 'R', enabled: true, instruction: 'do it' }] },
    eval: { mode: 'auto' },
  } as unknown as Pick<Settings, 'policy' | 'eval'>

  const assessment = (over: Partial<Assessment> = {}): Assessment => ({
    decision: 'accept',
    rule_assessments: [{ rule_id: 'r1', matched: true, reason: 'asked' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'do it' },
    title: 'Fix',
    scope: 'small',
    reason: 'requested',
    intent_evidence: 'please fix',
    ...over,
  })

  it('passes the declared claims through', () => {
    const outcome = assessmentOutcome(assessment({ claims: ['src/a.ts'] }), settings, 'explicit')
    expect(outcome).toMatchObject({ kind: 'accept', claims: ['src/a.ts'] })
  })

  it('omits the field when the assessment declared none', () => {
    const outcome = assessmentOutcome(assessment(), settings, 'explicit')
    expect(outcome).toMatchObject({ kind: 'accept' })
    expect('claims' in outcome).toBe(false)
  })

  it('drops an empty list rather than passing it on', () => {
    // An empty array would reach the Mandate as a claim of nothing, which reads like a decision.
    const outcome = assessmentOutcome(assessment({ claims: [] }), settings, 'explicit')
    expect('claims' in outcome).toBe(false)
  })
})
