/** Stable Router identities with atomic archive-before-refresh and stale-generation rejection. */
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import { ProjectKnowledge, KnowledgeConflict, type ContextArchive, type KnowledgeReceipt } from './project-knowledge.ts'
export interface RouterIdentity { routerId: string; projectId: string; sessionId: string; generation: number }
export interface RouterRead { identity: RouterIdentity; receipt: KnowledgeReceipt; summary: string }
export interface RefreshPreparation {
  id: string; identity: RouterIdentity; receipt: KnowledgeReceipt; nextSessionId: string
}
/** External Session creation/flush happens before commit; commit itself never runs external I/O. */
export class RouterRegistry {
  constructor(private readonly store: Store, private readonly knowledge: ProjectKnowledge) {
    store.atomic(() => store.db.exec(`
      CREATE TABLE IF NOT EXISTS managed_router (
        router_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS router_refresh (
        id TEXT PRIMARY KEY, router_id TEXT NOT NULL, generation INTEGER NOT NULL,
        next_session_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, preparation TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS router_one_preparation ON router_refresh(router_id) WHERE state='prepared';
      CREATE TABLE IF NOT EXISTS router_session_history (
        session_id TEXT PRIMARY KEY, router_id TEXT NOT NULL, generation INTEGER NOT NULL, refresh_id TEXT);
    `))
  }
  register(routerId: string, projectId: string, sessionId: string): RouterIdentity {
    if (![routerId, projectId, sessionId].every(x => x.trim())) throw new Error('Router, project and Session identities are required')
    return this.store.atomic(() => {
      const existing = this.get(routerId)
      if (existing) {
        if (existing.projectId !== projectId || existing.sessionId !== sessionId) throw new KnowledgeConflict('Router registration already exists')
        return existing
      }
      if (this.store.db.prepare('SELECT 1 FROM router_session_history WHERE session_id=?').get(sessionId)) throw new KnowledgeConflict('Session belongs to another Router generation')
      this.knowledge.bind(routerId, projectId)
      this.store.db.prepare('INSERT INTO managed_router VALUES (?,?,?,1)').run(routerId, projectId, sessionId)
      this.store.db.prepare('INSERT INTO router_session_history VALUES (?,?,1,NULL)').run(sessionId, routerId)
      return this.get(routerId)!
    })
  }
  get(routerId: string): RouterIdentity | undefined {
    const row = this.store.db.prepare('SELECT * FROM managed_router WHERE router_id=?').get(routerId)
    return row ? { routerId, projectId: String(row.project_id), sessionId: String(row.session_id), generation: Number(row.generation) } : undefined
  }
  list(): RouterIdentity[] {
    return this.store.db.prepare('SELECT router_id FROM managed_router ORDER BY router_id').all().map(x => this.get(String(x.router_id))!)
  }
  /** Resolve the main Router's original Session through its durable generation history. */
  successorOf(sessionId: string): RouterIdentity | undefined {
    const history = this.store.db.prepare('SELECT router_id FROM router_session_history WHERE session_id=?').get(sessionId)
    if (!history) return undefined
    const current = this.get(String(history.router_id))
    if (!current || current.sessionId === sessionId) return undefined
    const archived = this.store.db.prepare('SELECT 1 FROM project_context_archive WHERE project_id=? AND session_id=? LIMIT 1')
      .get(current.projectId, sessionId)
    return archived ? current : undefined
  }

  /** Protect active, staged and historical Sessions whose archive cannot be confirmed. */
  protectsSession(sessionId: string): boolean {
    if (this.store.db.prepare('SELECT 1 FROM managed_router WHERE session_id=?').get(sessionId)) return true
    if (this.store.db.prepare("SELECT 1 FROM router_refresh WHERE next_session_id=? AND state='prepared'").get(sessionId)) return true
    const known = this.store.db.prepare('SELECT 1 FROM router_session_history WHERE session_id=?').get(sessionId)
    return !!known && !this.successorOf(sessionId)
  }

  read(routerId: string, sessionId: string): RouterRead {
    return this.store.atomic(() => {
      const identity = this.active(routerId, sessionId)
      if (this.pending(routerId)) throw new KnowledgeConflict('Router refresh is preparing; project operations are held')
      const { receipt, snapshot } = this.knowledge.read(routerId)
      return { identity, receipt, summary: snapshot.summary }
    })
  }
  /** Called with server-derived Session identity, never with a model's claimed actor. */
  operate<T>(read: RouterRead, callerSessionId: string, operation: () => T): T {
    return this.store.atomic(() => {
      this.assertIdentity(read.identity, callerSessionId)
      if (this.pending(read.identity.routerId)) throw new KnowledgeConflict('Router refresh is preparing; project operations are held')
      if (read.receipt.routerId !== read.identity.routerId || read.receipt.projectId !== read.identity.projectId) throw new KnowledgeConflict('Receipt belongs to another Router')
      return this.knowledge.operate(read.receipt, operation)
    })
  }
  /** Host must establish idle + drained inbox before preparing and hold admission until commit/abort. */
  prepare(routerId: string, callerSessionId: string, expectedGeneration: number): RefreshPreparation {
    return this.store.atomic(() => {
      const identity = this.active(routerId, callerSessionId)
      if (identity.generation !== expectedGeneration || this.pending(routerId)) throw new KnowledgeConflict('Router generation changed or refresh is already preparing')
      const { receipt } = this.knowledge.read(routerId)
      const prep = { id: randomUUID(), identity, receipt, nextSessionId: `session-${randomUUID()}` }
      this.store.db.prepare('INSERT INTO router_refresh VALUES (?,?,?,?,?,?)')
        .run(prep.id, routerId, identity.generation, prep.nextSessionId, 'prepared', JSON.stringify(prep))
      return prep
    })
  }
  /** Crash recovery enumerates durable preparations and verifies the staged Session before retrying commit. */
  preparations(): RefreshPreparation[] {
    return this.store.db.prepare("SELECT preparation FROM router_refresh WHERE state='prepared' ORDER BY id").all().map(x => JSON.parse(String(x.preparation)) as RefreshPreparation)
  }
  commit(id: string, archives: readonly ContextArchive[], summary: string, verifiedSessionId: string): RouterIdentity {
    return this.store.atomic(() => {
      const row = this.store.db.prepare('SELECT state,preparation FROM router_refresh WHERE id=?').get(id)
      if (!row) throw new KnowledgeConflict('Unknown refresh preparation')
      const prep = JSON.parse(String(row.preparation)) as RefreshPreparation
      if (row.state === 'committed') {
        const current = this.get(prep.identity.routerId)!
        if (current.sessionId !== prep.nextSessionId) throw new KnowledgeConflict('Refresh already committed and superseded')
        return current
      }
      if (row.state !== 'prepared' || verifiedSessionId !== prep.nextSessionId) throw new KnowledgeConflict('Staged Session is not verified')
      this.assertIdentity(prep.identity, prep.identity.sessionId)
      if (!archives.length || archives.some(x => x.sessionId !== prep.identity.sessionId)) throw new KnowledgeConflict('Complete source Session archive is required before refresh')
      this.knowledge.checkpoint(prep.receipt, archives, summary)
      const next = { ...prep.identity, sessionId: prep.nextSessionId, generation: prep.identity.generation + 1 }
      this.store.db.prepare('UPDATE managed_router SET session_id=?,generation=? WHERE router_id=?').run(next.sessionId, next.generation, next.routerId)
      this.store.db.prepare('INSERT INTO router_session_history VALUES (?,?,?,?)').run(next.sessionId, next.routerId, next.generation, id)
      this.store.db.prepare("UPDATE router_refresh SET state='committed' WHERE id=?").run(id)
      return next
    })
  }
  abort(id: string): void {
    this.store.db.prepare("UPDATE router_refresh SET state='aborted' WHERE id=? AND state='prepared'").run(id)
  }
  private pending(routerId: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM router_refresh WHERE router_id=? AND state='prepared'").get(routerId)
  }
  private active(routerId: string, sessionId: string): RouterIdentity {
    const identity = this.get(routerId)
    if (!identity || identity.sessionId !== sessionId) throw new KnowledgeConflict('Session is not the active Router generation')
    return identity
  }
  private assertIdentity(identity: RouterIdentity, sessionId: string): void {
    const current = this.active(identity.routerId, sessionId)
    if (current.generation !== identity.generation || current.projectId !== identity.projectId) throw new KnowledgeConflict('Router generation changed; read project information again')
  }
}
