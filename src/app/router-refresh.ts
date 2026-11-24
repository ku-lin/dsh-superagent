/** Session I/O boundary for archive-before-refresh. The host supplies trusted, flushed event exports. */
import { RouterRegistry, type RouterIdentity } from './router-registry.ts'
export interface RouterExport {
  /** Deterministic identity of the complete flushed prefix (not a UI transcript projection). */
  sourceId: string
  raw: string
  complete: boolean
}
export interface RefreshHost {
  /** Atomically admit maintenance only when idle and drained; release reopens admission. */
  hold(sessionId: string): Promise<() => void>
  export(sessionId: string): Promise<RouterExport>
  /** Create without waking; return only after durable creation and preset verification. */
  create(sessionId: string, projectId: string): Promise<void>
  /** Verify the staged Session is blank, resumable, and uses the correct preset. */
  verify(sessionId: string): Promise<boolean>
  summarize(projectId: string, source: RouterExport): Promise<string>
}
/** No history is deleted. A staged unused Session may remain after failure for recovery/inspection. */
export class RouterRefresh {
  constructor(private readonly registry: RouterRegistry, private readonly host: RefreshHost) {}
  async refresh(routerId: string, sessionId: string, generation: number): Promise<RouterIdentity> {
    const release = await this.host.hold(sessionId)
    let preparation: ReturnType<RouterRegistry['prepare']> | undefined
    try {
      preparation = this.registry.prepare(routerId, sessionId, generation)
      const source = await this.host.export(sessionId)
      if (!source.complete || !source.sourceId || !source.raw) throw new Error('Complete flushed context export is required')
      const summary = await this.host.summarize(preparation.identity.projectId, source)
      await this.host.create(preparation.nextSessionId, preparation.identity.projectId)
      if (!await this.host.verify(preparation.nextSessionId)) throw new Error('New Router Session could not be verified')
      return this.registry.commit(preparation.id, [{ projectId: preparation.identity.projectId, sessionId,
        sourceId: source.sourceId, raw: source.raw }], summary, preparation.nextSessionId)
    } catch (error) {
      if (preparation) this.registry.abort(preparation.id)
      throw error
    } finally { release() }
  }
}
