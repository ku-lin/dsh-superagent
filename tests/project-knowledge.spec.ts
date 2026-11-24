import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ProjectKnowledge } from '../src/app/project-knowledge.ts'
const dirs: string[] = []
const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function open() {
 const dir = mkdtempSync(join(tmpdir(), 'router-knowledge-')); dirs.push(dir)
 const path = join(dir, 'state.sqlite'); const store = new Store(path); stores.push(store)
 return { path, store, knowledge: new ProjectKnowledge(store) }
}
it('isolates projects, preserves raw context across reopen, and deduplicates source imports', () => {
 const { path, store, knowledge: k } = open()
 k.bind('r1', 'p1'); k.bind('r2', 'p2'); k.bind('r3', 'p1')
 const raw = 'user: 原始上下文\nassistant: 保留全部字符\u0000end'
 const archive = { projectId: 'p1', sessionId: 'old', sourceId: 'seq-1-90', raw }
 k.checkpoint(k.read('r1').receipt, [archive], '目标：修复；下一步：验证')
 k.checkpoint(k.read('r3').receipt, [archive], '目标：修复；下一步：验收')
 expect(k.archives('p1')).toEqual([archive]); expect(k.archives('p2')).toEqual([])
 expect(k.read('r2').snapshot.revision).toBe(0)
 store.close(); stores.splice(stores.indexOf(store), 1)
 const reopened = new Store(path); stores.push(reopened)
 const next = new ProjectKnowledge(reopened)
 expect(next.archives('p1')[0]?.raw).toBe(raw)
 expect(next.read('r1').snapshot.revision).toBe(2)
 expect(() => next.bind('r1', 'p2')).toThrow('another project')
})
it('rejects stale, forged and reused read receipts before committing operations', () => {
 const { knowledge: k } = open(); k.bind('a', 'p'); k.bind('b', 'p')
 const stale = k.read('a').receipt
 k.checkpoint(k.read('b').receipt, [], 'new state')
 let executed = false
 expect(() => k.operate(stale, () => { executed = true })).toThrow('changed')
 expect(executed).toBe(false)
 const receipt = k.read('a').receipt
 expect(() => k.operate({ ...receipt, routerId: 'b' }, () => {})).toThrow('Invalid')
 k.operate(receipt, () => {})
 expect(() => k.operate(receipt, () => {})).toThrow('consumed')
})
it('rolls back partial archives and receipt consumption on a failed checkpoint', () => {
 const { knowledge: k } = open(); k.bind('a', 'p')
 const receipt = k.read('a').receipt
 const good = { projectId: 'p', sessionId: 's', sourceId: '1', raw: 'complete' }
 expect(() => k.checkpoint(receipt, [good, { ...good, sourceId: '2', projectId: 'other' }], 'state')).toThrow('binding')
 expect(k.archives('p')).toEqual([]); expect(k.snapshot('p').revision).toBe(0)
 k.checkpoint(receipt, [good], 'state')
 const next = k.read('a').receipt
 expect(() => k.checkpoint(next, [{ ...good, raw: 'silently replaced' }], 'bad')).toThrow('different context')
 expect(k.archives('p')).toEqual([good]); expect(k.snapshot('p').revision).toBe(1)
})
it('refuses async callbacks rather than claiming an external operation was atomic', () => {
 const { knowledge: k } = open(); k.bind('a', 'p'); const receipt = k.read('a').receipt
 expect(() => k.operate(receipt, () => Promise.resolve())).toThrow('synchronously')
 expect(() => k.operate(receipt, () => {})).not.toThrow()
})
it('keeps every state summary version and names the archive each came from', () => {
 const { knowledge: k } = open(); k.bind('a', 'p')
 k.checkpoint(k.read('a').receipt, [{ projectId: 'p', sessionId: 'big', sourceId: 'sha256:big', raw: 'the real conversation' }], '目标：修复溢出')
 k.checkpoint(k.read('a').receipt, [{ projectId: 'p', sessionId: 'probe1', sourceId: 'sha256:p1', raw: 'x' }], 'probe state 1')
 k.checkpoint(k.read('a').receipt, [{ projectId: 'p', sessionId: 'probe2', sourceId: 'sha256:p2', raw: 'y' }], 'probe state 2')
 // The live snapshot is the newest, but the summary of the real archive is still readable and traceable.
 expect(k.snapshot('p').summary).toBe('probe state 2')
 const versions = k.versions('p')
 expect(versions.map(v => v.revision)).toEqual([3, 2, 1])
 expect(versions[2]).toMatchObject({ revision: 1, summary: '目标：修复溢出', sourceId: 'sha256:big', routerId: 'a' })
 // Provenance points at text that is actually still archived byte-exactly.
 expect(k.archives('p').find(a => a.sourceId === versions[2]!.sourceId)!.raw).toBe('the real conversation')
})
