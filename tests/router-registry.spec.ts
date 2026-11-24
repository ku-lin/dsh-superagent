import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ProjectKnowledge } from '../src/app/project-knowledge.ts'
import { RouterRegistry } from '../src/app/router-registry.ts'
const dirs: string[] = []; const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function open() {
 const dir = mkdtempSync(join(tmpdir(), 'router-registry-')); dirs.push(dir)
 const path = join(dir, 'state.sqlite'); const store = new Store(path); stores.push(store)
 const knowledge = new ProjectKnowledge(store); const registry = new RouterRegistry(store, knowledge)
 registry.register('r1', 'p1', 's1'); registry.register('r2', 'p2', 's2')
 return { path, store, knowledge, registry }
}
it('archives before switching, retains old provenance, isolates Routers, and invalidates stale actors', () => {
 const { registry: r, knowledge: k } = open(); const old = r.read('r1', 's1')
 const prep = r.prepare('r1', 's1', 1)
 expect(() => r.prepare('r1', 's1', 1)).toThrow('already preparing')
 expect(() => r.operate(old, 's1', () => {})).toThrow('held')
 expect(r.read('r2', 's2').identity.generation).toBe(1)
 const archive = { projectId: 'p1', sessionId: 's1', sourceId: 'events:1-9', raw: 'all original events' }
 expect(() => r.commit(prep.id, [archive], 'latest state', 'unverified')).toThrow('verified')
 expect(r.get('r1')?.sessionId).toBe('s1'); expect(k.archives('p1')).toEqual([])
 const next = r.commit(prep.id, [archive], 'latest state', prep.nextSessionId)
 expect(next.generation).toBe(2); expect(k.archives('p1')).toEqual([archive]); expect(k.archives('p2')).toEqual([])
 expect(r.commit(prep.id, [archive], 'latest state', prep.nextSessionId)).toEqual(next)
 expect(() => r.operate(old, 's1', () => {})).toThrow('active')
 expect(() => r.read('r1', 's1')).toThrow('active')
 expect(r.read('r1', next.sessionId).summary).toBe('latest state')
})
it('rolls back pointer and archive together on failure and allows abort without deleting history', () => {
 const { registry: r, knowledge: k } = open(); const prep = r.prepare('r1', 's1', 1)
 const wrong = { projectId: 'p2', sessionId: 's1', sourceId: 'all', raw: 'context' }
 expect(() => r.commit(prep.id, [wrong], 'state', prep.nextSessionId)).toThrow('binding')
 expect(r.get('r1')?.generation).toBe(1); expect(k.snapshot('p1').revision).toBe(0)
 r.abort(prep.id); expect(r.read('r1', 's1').identity.sessionId).toBe('s1')
 expect(() => r.commit(prep.id, [wrong], 'state', prep.nextSessionId)).toThrow('verified')
})
it('protects the live, staged and unarchived Sessions, and releases an archived one a refresh replaced', () => {
 const { registry: r, knowledge: k } = open()
 const prep = r.prepare('r1', 's1', 1)
 // Live generation, staged replacement and a history-only Session with no archive all stay protected.
 expect(r.protectsSession('s1')).toBe(true)
 expect(r.protectsSession(prep.nextSessionId)).toBe(true)
 expect(r.protectsSession('s2')).toBe(true)
 expect(r.successorOf('s1')).toBeUndefined()
 // Committing the archive is what releases the old generation.
 const next = r.commit(prep.id, [{ projectId: 'p1', sessionId: 's1', sourceId: 'events:1-9', raw: 'archived text' }], 'state', prep.nextSessionId)
 expect(r.successorOf('s1')).toMatchObject({ sessionId: next.sessionId, generation: 2 })
 expect(r.protectsSession('s1')).toBe(false)
 expect(r.protectsSession(next.sessionId)).toBe(true)
 // Another Router's Sessions are unaffected by this release.
 expect(r.protectsSession('s2')).toBe(true)
 expect(k.archives('p1')).toHaveLength(1)
})

it('releases an archived Session only when its own project still holds the text', () => {
 const { registry: r } = open()
 const prep = r.prepare('r1', 's1', 1)
 // An archive recorded against another project is not proof that this Router's text survived.
 r.commit(prep.id, [{ projectId: 'p1', sessionId: 's1', sourceId: 'events:1-9', raw: 'archived text' }], 'state', prep.nextSessionId)
 expect(r.successorOf('s1')).toBeDefined()
 expect(r.successorOf('s2')).toBeUndefined()
 expect(r.successorOf('never-seen')).toBeUndefined()
})

it('recovers prepared refresh across restart and rejects a changed project snapshot', () => {
 const { path, store, registry: r, knowledge: k } = open()
 const prep = r.prepare('r1', 's1', 1)
 k.bind('other', 'p1'); k.checkpoint(k.read('other').receipt, [], 'concurrent update')
 store.close(); stores.splice(stores.indexOf(store), 1)
 const reopened = new Store(path); stores.push(reopened)
 const next = new RouterRegistry(reopened, new ProjectKnowledge(reopened))
 expect(next.preparations()).toEqual([prep])
 expect(() => next.commit(prep.id, [{ projectId: 'p1', sessionId: 's1', sourceId: 'all', raw: 'context' }], 'stale', prep.nextSessionId)).toThrow('changed')
 expect(next.get('r1')?.sessionId).toBe('s1')
})
