/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForChildren: vi.fn(waitForChildren), listChildren: async () => [{ id: 'child-1' }], drainChildren: vi.fn(drainChildren) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent } } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('is not quiet when the worker runs again while a look waits on its job', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const quiet = untilQuiet(ctx, agent, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  // Its job ends, and its end wakes the worker, whose own turn is what the next look sees.
  ;(agent as { status: string }).status = 'running'
  jobs.end(id)
  expect(await quiet).toBe(false)
})

// A worker is an ordinary conversation that talks to the Router, not a parent of subagents: a leftover subagent of the
// Session, such as one a person started in a borrowed conversation, must not hold a ticket's turn open.
it('is quiet with its own jobs ended, and never waits on a subagent that would never settle', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(true)
  expect(subagents.waitForChildren).not.toHaveBeenCalled()
})

it('stops waiting for the worker once the host stops', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('does not consult the subagents service on any look', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).not.toHaveBeenCalled()
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})
