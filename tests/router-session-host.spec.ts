import { expect, it, vi } from 'vitest'
import { RouterSessionHost, RouterRefreshRefused, archiveFacts, parseExport, sourceIdentity } from '../src/app/router-session-host.ts'
import { ROUTER_PRESET } from '../src/app/router-sessions.ts'

const event = (seq: number, type: string, data?: unknown) => ({ seq, type, time: 1_000 + seq, ...data === undefined ? {} : { data } })
const history = [
  event(0, 'session', { agentPreset: ROUTER_PRESET }),
  event(1, 'user/message', { content: [{ type: 'text', text: '修复 Router 溢出' }] }),
  event(2, 'tool/call', { name: 'read', callId: 'c1' }),
  event(3, 'tool/result', { callId: 'c1' }),
  event(4, 'assistant/message', { content: [{ type: 'text', text: '已归档' }] }),
  event(5, 'turn/end', { rule: 'completed' }),
]

/** A host whose every DSH call is explicit, so a divergence is a test failure rather than a silent pass. */
function host(overrides: Partial<ConstructorParameters<typeof RouterSessionHost>[0]> = {}) {
  const agent = {
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    session: { header: { agentPreset: ROUTER_PRESET, cwd: 'S:/project' }, snapshotEvents: () => history },
    runMaintenance: vi.fn(async (task: (signal: AbortSignal) => Promise<void>) => { await task(new AbortController().signal) }),
  }
  const options = {
    sessions: {
      resolveAgent: vi.fn(async () => ({ agent })),
      liveAgent: vi.fn(() => agent),
      inspect: vi.fn(async () => ({ events: history })),
      create: vi.fn(async (request: { sessionId: string }) => ({ sessionId: request.sessionId, agentPreset: ROUTER_PRESET })),
    },
    flush: vi.fn(async () => true),
    persistence: { flush: vi.fn(async () => {}), stat: vi.fn(async () => ({ header: { agentPreset: ROUTER_PRESET, cwd: 'S:/project' } })) },
    workspace: vi.fn(async () => ({ id: 'workspace-1' })),
    ...overrides,
  }
  return { agent, options, host: new RouterSessionHost(options as never) }
}

it('archives the complete flushed log with a deterministic, content-addressed identity', async () => {
  const { host: h, options } = host()
  const exported = await h.export('session-1')
  expect(exported.complete).toBe(true)
  expect(exported.raw.split('\n')).toHaveLength(history.length)
  expect(parseExport(exported.raw)).toEqual(history)
  // A re-export of the same log produces the same identity, so a retried refresh stays idempotent at the archive key.
  expect((await h.export('session-1')).sourceId).toBe(exported.sourceId)
  expect(exported.sourceId).toBe(sourceIdentity(history, exported.raw))
  // Each export takes exactly one durability barrier: two exports, two flushes (never zero, never a hidden extra).
  expect(options.flush).toHaveBeenCalledTimes(2)
})

it('refuses an export whose flush did not land instead of archiving a short prefix', async () => {
  const { host: h } = host({ flush: vi.fn(async () => false) } as never)
  const exported = await h.export('session-1')
  expect(exported.complete).toBe(false)
  expect(exported.raw).toBe('')
})

it('refuses when storage lags the live log', async () => {
  const { host: h } = host({ sessions: {
    resolveAgent: vi.fn(async () => ({ agent: undefined })),
    liveAgent: vi.fn(() => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      session: { header: { agentPreset: ROUTER_PRESET }, snapshotEvents: () => history },
      runMaintenance: vi.fn() })),
    inspect: vi.fn(async () => ({ events: history.slice(0, 3) })),
    create: vi.fn(),
  } } as never)
  expect((await h.export('session-1')).complete).toBe(false)
})

it('holds admission only for an idle, drained Session and releases exactly once', async () => {
  const { host: h } = host()
  const release = await h.hold('session-1')
  await expect(h.hold('session-1')).rejects.toBeInstanceOf(RouterRefreshRefused)
  release(); release()
})

it.each([
  ['a running Session', { status: 'running', inbox: { nextTurn: [], nextStep: [] } }],
  ['queued input', { status: 'idle', inbox: { nextTurn: [{}], nextStep: [] } }],
])('refuses a hold on %s', async (_label, plane) => {
  const { host: h } = host({ sessions: {
    resolveAgent: vi.fn(async () => ({ agent: { ...plane, session: { header: { agentPreset: ROUTER_PRESET }, snapshotEvents: () => history }, runMaintenance: vi.fn() } })),
    liveAgent: vi.fn(), inspect: vi.fn(), create: vi.fn(),
  } } as never)
  await expect(h.hold('session-1')).rejects.toMatchObject({ code: 'sessionBusy' })
})

it('creates the replacement with a Workspace and the router preset, and verifies a blank one', async () => {
  const { host: h, options } = host({ sessions: {
    resolveAgent: vi.fn(async () => ({ agent: { status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      session: { header: { agentPreset: ROUTER_PRESET }, snapshotEvents: () => [event(0, 'session')] }, runMaintenance: vi.fn() } })),
    liveAgent: vi.fn(), inspect: vi.fn(async () => ({ events: [event(0, 'session')] })),
    create: vi.fn(async (request: { sessionId: string }) => ({ sessionId: request.sessionId, agentPreset: ROUTER_PRESET })),
  } } as never)
  await h.create('session-2', 'p1', 'session-1')
  expect(options.sessions.create).toHaveBeenCalledWith({ sessionId: 'session-2', workspaceId: 'workspace-1', agentPreset: ROUTER_PRESET })
  await expect(h.verify('session-2')).resolves.toBe(true)
})

it('marks a replacement with work in it as unverified, and refuses without a Workspace', async () => {
  const withWork = host({ sessions: {
    resolveAgent: vi.fn(async () => ({ agent: { status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      session: { header: { agentPreset: ROUTER_PRESET }, snapshotEvents: () => history }, runMaintenance: vi.fn() } })),
    liveAgent: vi.fn(), inspect: vi.fn(async () => ({ events: history })), create: vi.fn(),
  } } as never)
  await expect(withWork.host.verify('session-2')).resolves.toBe(false)
  const noWorkspace = host({ workspace: vi.fn(async () => undefined) } as never)
  await expect(noWorkspace.host.create('session-2', 'p1', 'session-1')).rejects.toMatchObject({ code: 'noWorkspace' })
})

it('summarizes from the archived events only, deterministically and without inventing state', async () => {
  const { host: h } = host()
  const exported = await h.export('session-1')
  const summary = await h.summarize('p1', exported)
  expect(await h.summarize('p1', exported)).toBe(summary)
  expect(summary).toContain('p1')
  expect(summary).toContain('修复 Router 溢出')
  const facts = archiveFacts(parseExport(exported.raw))
  expect(facts).toBeTruthy()
})

it('rejects an archive line that is not a sequenced event rather than summarizing part of it', () => {
  expect(() => parseExport('{"type":"user/message"}')).toThrow('sequence number')
  expect(() => parseExport('not json')).toThrow('JSON-lines')
})

it('states every section a continuing conversation needs, and says so when the log holds no evidence', async () => {
  const { host: h } = host()
  const summary = await h.summarize('p1', await h.export('session-1'))
  for (const section of ['Goal:', 'Decisions:', 'Done / undone:', 'Verification:', 'Risks:', 'Next step:', 'Unattributed'])
    expect(summary).toContain(section)
  // The fixture's one instruction is the goal, and it is quoted from the archive rather than invented.
  expect(summary).toMatch(/Goal: \(seq \d+\) 修复 Router 溢出/)
  // Nothing in this log proved anything or failed, so the summary must not pretend otherwise.
  expect(summary).toContain('no verification command appears in this span')
  expect(summary).toContain('none recorded in this span')
})

it('records a decision and a failure from the log instead of staying silent about them', async () => {
  const decided = [
    event(0, 'user/message', { content: [{ type: 'text', text: '决定采用归档先于切换的方案。' }] }),
    event(1, 'tool/call', { name: 'verify_router', callId: 'c1' }),
    event(2, 'tool/result', { callId: 'c1' }),
    event(3, 'turn/end', { reason: { kind: 'error' }, error: { message: 'boom' } }),
  ]
  const { host: h } = host({ sessions: {
    resolveAgent: vi.fn(async () => ({ agent: undefined })),
    liveAgent: vi.fn(() => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      session: { header: { agentPreset: ROUTER_PRESET }, snapshotEvents: () => decided }, runMaintenance: vi.fn() })),
    inspect: vi.fn(async () => ({ events: decided })), create: vi.fn(),
  }, flush: vi.fn(async () => true) } as never)
  const summary = await h.summarize('p1', await h.export('session-1'))
  expect(summary).toContain('归档先于切换')
  expect(summary).toContain('verify_router')
  expect(summary).toMatch(/Risks: 1 failed or errored step/)
})

it('keeps another project\'s content out of this project and lists it as unattributed', async () => {
  const other = 'project-11111111-2222-3333-4444-555555555555'
  const mixed = [
    event(0, 'user/message', { content: [{ type: 'text', text: `也顺手改一下 ${other} 的任务` }] }),
    event(1, 'turn/end', { rule: 'completed' }),
  ]
  const { host: h } = host({ sessions: {
    resolveAgent: vi.fn(async () => ({ agent: undefined })),
    liveAgent: vi.fn(() => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      session: { header: { agentPreset: ROUTER_PRESET }, snapshotEvents: () => mixed }, runMaintenance: vi.fn() })),
    inspect: vi.fn(async () => ({ events: mixed })), create: vi.fn(),
  }, flush: vi.fn(async () => true) } as never)
  const summary = await h.summarize('p1', await h.export('session-1'))
  // It is reported, explicitly marked as not filed into this project.
  expect(summary).toContain(other)
  expect(summary).toContain('never filed into p1')
  // And the summary never claims the other project's work as this project's decision.
  expect(summary).toContain('Decisions: none recorded in this span')
})
