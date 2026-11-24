import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ProjectKnowledge } from '../src/app/project-knowledge.ts'
import { RouterRegistry } from '../src/app/router-registry.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(run => run()))

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'router-gate-'))
  const store = new Store(join(dir, 'state.sqlite'))
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const knowledge = new ProjectKnowledge(store)
  const routers = new RouterRegistry(store, knowledge)
  routers.register('r-a', 'project-a', 'session-a1')
  routers.register('r-b', 'project-b', 'session-b1')
  /** Exactly the predicate Runtime passes to Sessions: is this Session some Router's current generation? */
  const allowed = (sessionId: string): boolean => routers.list().some(identity => identity.sessionId === sessionId)
  const bound = (sessionId: string): { projectId: string; summary: string } | undefined => {
    const found = routers.list().find(identity => identity.sessionId === sessionId)
    return found === undefined ? undefined : { projectId: found.projectId, summary: knowledge.snapshot(found.projectId).summary }
  }
  return { knowledge, routers, allowed, bound }
}

it('decorates a project Router with its own project and summary, and none for an unrelated Session', () => {
  const { knowledge, routers, bound } = open()
  expect(bound('session-a1')).toEqual({ projectId: 'project-a', summary: '' })
  expect(bound('session-b1')).toEqual({ projectId: 'project-b', summary: '' })
  expect(bound('session-someone-else')).toBeUndefined()
  // The summary a Router is told is the durable one, never another project's.
  routers.commit(routers.prepare('r-a', 'session-a1', 1).id,
    [{ projectId: 'project-a', sessionId: 'session-a1', sourceId: 's:1', raw: 'a text' }], '项目 A 状态', routers.preparations()[0]!.nextSessionId)
  expect(bound(routers.get('r-a')!.sessionId)?.summary).toBe('项目 A 状态')
  expect(bound('session-b1')?.summary).toBe('')
  expect(knowledge.archives('project-b')).toEqual([])
})

it('strips authority from the superseded Session the moment a refresh commits', () => {
  const { routers, allowed } = open()
  expect(allowed('session-a1')).toBe(true)
  const prep = routers.prepare('r-a', 'session-a1', 1)
  const next = routers.commit(prep.id,
    [{ projectId: 'project-a', sessionId: 'session-a1', sourceId: 's:1', raw: 'archived' }], '状态', prep.nextSessionId)
  // The tool guard reads this at execution time, so a live Agent kept from before the refresh loses its tools.
  expect(allowed('session-a1')).toBe(false)
  expect(allowed(next.sessionId)).toBe(true)
  // The other Router is untouched: a refresh never revokes a different project's Router.
  expect(allowed('session-b1')).toBe(true)
})
