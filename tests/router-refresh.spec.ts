import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ProjectKnowledge } from '../src/app/project-knowledge.ts'
import { RouterRegistry } from '../src/app/router-registry.ts'
import { RouterRefresh, type RefreshHost } from '../src/app/router-refresh.ts'
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(f => f()))
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'router-refresh-')); const store=new Store(join(dir,'state.sqlite'))
 cleanup.push(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const knowledge=new ProjectKnowledge(store); const registry=new RouterRegistry(store,knowledge)
 registry.register('r','p','old')
 const release=vi.fn()
 const host: RefreshHost={hold:vi.fn(async()=>release),export:vi.fn(async()=>({sourceId:'prefix:99',raw:'all events',complete:true})),
 create:vi.fn(async()=>{}),verify:vi.fn(async()=>true),summarize:vi.fn(async()=>'latest project state')}
 return {knowledge,registry,host,release,refresh:new RouterRefresh(registry,host)}
}
it('publishes the new Session only after export, summary and verification',async()=>{
 const f=fixture()
 f.host.verify=vi.fn(async()=>{expect(f.registry.get('r')?.sessionId).toBe('old');return true})
 const next=await f.refresh.refresh('r','old',1)
 expect(next.generation).toBe(2);expect(next.sessionId).not.toBe('old')
 expect(f.knowledge.archives('p')[0]?.raw).toBe('all events');expect(f.release).toHaveBeenCalledOnce()
})
it.each(['export','summarize','create','verify'] as const)('preserves old context and pointer when %s fails',async stage=>{
 const f=fixture()
 if(stage==='verify')f.host.verify=vi.fn(async()=>false)
 else f.host[stage]=vi.fn(async()=>{throw new Error('failure')}) as never
 await expect(f.refresh.refresh('r','old',1)).rejects.toThrow()
 expect(f.registry.get('r')?.sessionId).toBe('old');expect(f.knowledge.archives('p')).toEqual([])
 expect(f.registry.preparations()).toEqual([]);expect(f.release).toHaveBeenCalledOnce()
})
it('rejects a projected or partial export before creating a replacement',async()=>{
 const f=fixture();f.host.export=vi.fn(async()=>({sourceId:'partial',raw:'only visible messages',complete:false}))
 await expect(f.refresh.refresh('r','old',1)).rejects.toThrow('Complete')
 expect(f.host.create).not.toHaveBeenCalled();expect(f.registry.get('r')?.generation).toBe(1)
})
