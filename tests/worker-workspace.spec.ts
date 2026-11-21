/**
 * Worker conversations live where their work does: a worker Session is created inside the Workspace for its ticket's
 * directory, named by `workspaceId` alone so DSH takes the directory from `workspace.path`. That is exactly what a
 * person gets by opening that directory and starting a conversation there, which is what makes the worker visible in
 * the sidebar, openable, and resumable. A Workspace still runs one worker at a time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { WorkspaceParking, workerTitle, workspaceKeyOf } from '../src/executor/dsh.ts'
import { waitUntil } from './fixtures/async.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Path comparison that ignores the case and separator spelling Windows accepts for one directory. */
const samePlace = (left: string, right: string): boolean => {
  const shape = (value: string): string => {
    const absolute = resolve(value).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return shape(left) === shape(right)
}

describe('workspaceKeyOf', () => {
  it('compares one directory through its separators and case', () => {
    const left = process.platform === 'win32' ? 'C:\\Work\\Repo' : '/work/repo'
    const right = process.platform === 'win32' ? 'c:/work/repo/' : '/work/repo/'
    expect(workspaceKeyOf(left)).toBe(workspaceKeyOf(right))
  })

  it('distinguishes two directories, which is what lets different Workspaces run in parallel', () => {
    expect(workspaceKeyOf('/work/one')).not.toBe(workspaceKeyOf('/work/two'))
  })

  it('reports no lease for a ticket without a directory', () => {
    expect(workspaceKeyOf(undefined)).toBe('')
    expect(workspaceKeyOf('   ')).toBe('')
  })
})

describe('WorkspaceParking', () => {
  it('holds a second launch in the same Workspace until that Workspace frees', () => {
    const parking = new WorkspaceParking()
    const key = workspaceKeyOf('/work/one')
    parking.park(key, 'ticket-a', 'assignment-a')
    parking.park(key, 'ticket-b', 'assignment-b')
    // A busy Workspace hands out nothing.
    expect(parking.next(key, () => true)).toBeUndefined()
    expect(parking.peek(key).map(item => item.ticketId)).toEqual(['ticket-a', 'ticket-b'])
    // Once it frees, the oldest launch goes first and the rest stay queued.
    expect(parking.next(key, () => false)).toMatchObject({ ticketId: 'ticket-a' })
    expect(parking.peek(key).map(item => item.ticketId)).toEqual(['ticket-b'])
    expect(parking.next(key, () => true)).toBeUndefined()
  })

  it('never makes one Workspace wait on another', () => {
    const parking = new WorkspaceParking()
    const busyKey = workspaceKeyOf('/work/one')
    const freeKey = workspaceKeyOf('/work/two')
    parking.park(busyKey, 'ticket-a', 'assignment-a')
    parking.park(freeKey, 'ticket-b', 'assignment-b')
    const busy = (key: string) => key === busyKey
    expect(parking.next(busyKey, () => busy(busyKey))).toBeUndefined()
    expect(parking.next(freeKey, () => busy(freeKey))).toMatchObject({ ticketId: 'ticket-b' })
  })

  it('replaces a parked ticket\'s older assignment instead of queueing the ticket twice', () => {
    const parking = new WorkspaceParking()
    const key = workspaceKeyOf('/work/one')
    parking.park(key, 'ticket-a', 'assignment-1')
    parking.park(key, 'ticket-a', 'assignment-2')
    expect(parking.peek(key)).toEqual([{ ticketId: 'ticket-a', assignmentId: 'assignment-2' }])
  })
})

describe('a worker Session joins its Workspace', () => {
  it('creates the Session with workspaceId only, in the Workspace for the ticket directory', async () => {
    h.controller.create.mockClear()
    h.workspaceRegistry.create.mockClear()
    const accepted = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const directory = accepted.ticket.execution?.directory ?? ''
    const sessionId = accepted.sessionId
    await waitUntil(() => h.controller.create.mock.calls.some(([request]) => request.sessionId === sessionId))

    /** One create request as it reached the host, including the fields DSH validates. */
    type Created = { sessionId: string; workspaceId: string; cwd?: string; agentPreset?: string }
    const request = h.controller.create.mock.calls.map(([created]) => created as unknown as Created)
      .find(created => created.sessionId === sessionId)!
    // The Workspace names the directory; the create must not also name a cwd — DSH rejects both together.
    expect(request).not.toHaveProperty('cwd')
    expect(request).toMatchObject({ agentPreset: 'dsh-superagent-worker' })

    // No Workspace exists for that directory yet, so one is registered exactly as opening it would register it.
    expect(h.workspaceRegistry.create).toHaveBeenCalledTimes(1)
    const [registered] = h.workspaceRegistry.create.mock.calls[0]!
    expect(samePlace(registered, directory)).toBe(true)
    // And the Session joins that Workspace, which is what puts it in the sidebar's sessionIds.
    expect(samePlace(String(request.workspaceId), registered)).toBe(true)
  })

  it('names the worker after its ticket before the first message, so the list never shows it untitled', async () => {
    const accepted = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const sessionId = accepted.sessionId
    const title = workerTitle(accepted.ticket)
    expect(title.startsWith(`worker-${accepted.ticket.id.slice(0, 8)} · `)).toBe(true)

    // The title is committed as `session/title`, which is what the Session list reads; `create` takes no title at all.
    const renames = h.controller.rename.mock.calls as unknown as [{ sessionId: string; title: string }][]
    await waitUntil(() => renames.some(([request]) => request.sessionId === sessionId))
    const index = renames.findIndex(([request]) => request.sessionId === sessionId)
    expect(renames[index]![0]).toMatchObject({ sessionId, title })

    // And it lands before the assignment reaches the worker: a row that is listed while the Session is composed is
    // already named, instead of appearing as 未命名 until something later renames it.
    const renamedAt = h.controller.rename.mock.invocationCallOrder[index]!
    const firstPrompt = h.deliveries.mock.calls.findIndex(([delivery]) => delivery.sessionId === sessionId)
    expect(firstPrompt).toBeGreaterThanOrEqual(0)
    expect(renamedAt).toBeLessThan(h.deliveries.mock.invocationCallOrder[firstPrompt]!)
  })
})
