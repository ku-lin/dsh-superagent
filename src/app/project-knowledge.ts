/** Durable project snapshots and read-before-write receipts. No model-generated project attribution. */
import { createHash, randomUUID } from 'node:crypto'
import type { Store } from './store.ts'

export interface KnowledgeSnapshot {
  projectId: string
  revision: number
  summary: string
  updatedAt: string
}
export interface KnowledgeReceipt { id: string; routerId: string; projectId: string; revision: number }
/** One archived span of original conversation text, identified by its project, Session, and stable source range. */
export interface ContextArchive {
  projectId: string
  sessionId: string
  /** Stable event sequence or immutable export identity; retries must reuse it. */
  sourceId: string
  raw: string
}
/** A rejected knowledge operation: stale or consumed receipt, changed project state, or a mismatched binding. */
export class KnowledgeConflict extends Error {}

/** Uses the existing Store transaction boundary so archives and latest-state writes commit together. */
export class ProjectKnowledge {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS project_knowledge (
        project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, summary TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_context_archive (
        project_id TEXT NOT NULL, session_id TEXT NOT NULL, source_id TEXT NOT NULL,
        sha256 TEXT NOT NULL, raw TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, session_id, source_id));
      CREATE TABLE IF NOT EXISTS router_project_binding (
        router_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_knowledge_receipt (
        id TEXT PRIMARY KEY, router_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS project_knowledge_version (
        project_id TEXT NOT NULL, revision INTEGER NOT NULL, summary TEXT NOT NULL, source_id TEXT NOT NULL,
        router_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, revision));
    `)
  }
  /** Binding is explicit and immutable: changing projects requires a new Router identity. */
  bind(routerId: string, projectId: string): void {
    this.requireId(routerId); this.requireId(projectId)
    this.store.atomic(() => {
      const previous = this.store.db.prepare('SELECT project_id FROM router_project_binding WHERE router_id=?').get(routerId)
      if (previous && previous.project_id !== projectId) throw new KnowledgeConflict('Router is already bound to another project')
      this.store.db.prepare('INSERT OR IGNORE INTO router_project_binding VALUES (?,?)').run(routerId, projectId)
    })
  }
  snapshot(projectId: string): KnowledgeSnapshot {
    this.requireId(projectId)
    const row = this.store.db.prepare('SELECT * FROM project_knowledge WHERE project_id=?').get(projectId)
    return { projectId, revision: Number(row?.revision ?? 0), summary: String(row?.summary ?? ''), updatedAt: String(row?.updated_at ?? '') }
  }
  /** Returns the snapshot together with the exact revision receipt required for an operation. */
  read(routerId: string): { snapshot: KnowledgeSnapshot; receipt: KnowledgeReceipt } {
    return this.store.atomic(() => {
      const projectId = this.projectOf(routerId)
      const snapshot = this.snapshot(projectId)
      const receipt = { id: randomUUID(), routerId, projectId, revision: snapshot.revision }
      this.store.db.prepare('INSERT INTO project_knowledge_receipt(id,router_id,project_id,revision) VALUES (?,?,?,?)')
        .run(receipt.id, routerId, projectId, snapshot.revision)
      return { snapshot, receipt }
    })
  }
  /** Check and consume once in the same transaction as the caller's synchronous durable operation. */
  operate<T>(receipt: KnowledgeReceipt, operation: () => T): T {
    // Reject native async functions before they can start effects. Non-native thenables are also rejected below;
    // production callers must pass synchronous durable mutations, never start external I/O here.
    if (operation.constructor.name === 'AsyncFunction') throw new Error('Knowledge operations must commit synchronously; enqueue external effects inside the transaction')
    return this.store.atomic(() => {
      const row = this.store.db.prepare('SELECT * FROM project_knowledge_receipt WHERE id=?').get(receipt.id)
      if (!row || row.consumed !== 0 || row.router_id !== receipt.routerId || row.project_id !== receipt.projectId
        || row.revision !== receipt.revision || this.projectOf(receipt.routerId) !== receipt.projectId)
        throw new KnowledgeConflict('Invalid or consumed project read receipt')
      if (this.snapshot(receipt.projectId).revision !== receipt.revision) throw new KnowledgeConflict('Project information changed; read it again before operating')
      this.store.db.prepare('UPDATE project_knowledge_receipt SET consumed=1 WHERE id=?').run(receipt.id)
      const result = operation()
      if (result !== null && typeof result === 'object' && 'then' in result) throw new Error('Knowledge operations must commit synchronously; enqueue external effects inside the transaction')
      return result
    })
  }
  /** All source bytes are retained, independent of the editable latest-state summary. */
  checkpoint(receipt: KnowledgeReceipt, archives: readonly ContextArchive[], summary: string): KnowledgeSnapshot {
    if (!summary.trim()) throw new Error('A nonempty project state summary is required')
    return this.operate(receipt, () => {
      for (const archive of archives) {
        if (archive.projectId !== receipt.projectId) throw new KnowledgeConflict('Archive project does not match the explicit Router binding')
        this.requireId(archive.sessionId); this.requireId(archive.sourceId)
        const digest = createHash('sha256').update(archive.raw).digest('hex')
        const old = this.store.db.prepare('SELECT sha256 FROM project_context_archive WHERE project_id=? AND session_id=? AND source_id=?')
          .get(archive.projectId, archive.sessionId, archive.sourceId)
        if (old && old.sha256 !== digest) throw new KnowledgeConflict('Source identity already contains different context')
        this.store.db.prepare('INSERT OR IGNORE INTO project_context_archive VALUES (?,?,?,?,?,?)')
          .run(archive.projectId, archive.sessionId, archive.sourceId, digest, JSON.stringify(archive.raw), new Date().toISOString())
      }
      const next = { projectId: receipt.projectId, revision: receipt.revision + 1, summary, updatedAt: new Date().toISOString() }
      this.store.db.prepare(`INSERT INTO project_knowledge VALUES (?,?,?,?) ON CONFLICT(project_id)
        DO UPDATE SET revision=excluded.revision, summary=excluded.summary, updated_at=excluded.updated_at`)
        .run(next.projectId, next.revision, summary, next.updatedAt)
      // Every version is kept. Overwriting only the latest row lost the state summary of a real 18 MB archive when two
      // later refreshes archived an empty probe conversation, and that history is what makes a summary traceable.
      this.store.db.prepare('INSERT OR IGNORE INTO project_knowledge_version VALUES (?,?,?,?,?,?)')
        .run(next.projectId, next.revision, summary, archives[0]?.sourceId ?? '', receipt.routerId, next.updatedAt)
      return next
    })
  }
  archives(projectId: string): ContextArchive[] {
    return this.store.db.prepare('SELECT * FROM project_context_archive WHERE project_id=? ORDER BY session_id,source_id').all(projectId)
      .map(row => ({ projectId, sessionId: String(row.session_id), sourceId: String(row.source_id), raw: JSON.parse(String(row.raw)) as string }))
  }
  /**
   * Every state summary this project ever committed, newest first.
   *
   * Each entry names the archive it was derived from, so a reader can go from a summary back to the exact conversation
   * text it describes. The current row in `project_knowledge` is only the newest of these.
   */
  versions(projectId: string): { revision: number; summary: string; sourceId: string; routerId: string; createdAt: string }[] {
    this.requireId(projectId)
    return this.store.db.prepare('SELECT * FROM project_knowledge_version WHERE project_id=? ORDER BY revision DESC').all(projectId)
      .map(row => ({ revision: Number(row.revision), summary: String(row.summary), sourceId: String(row.source_id),
        routerId: String(row.router_id), createdAt: String(row.created_at) }))
  }
  private projectOf(routerId: string): string {
    const row = this.store.db.prepare('SELECT project_id FROM router_project_binding WHERE router_id=?').get(routerId)
    if (!row) throw new KnowledgeConflict('Router has no explicit project binding')
    return String(row.project_id)
  }
  private requireId(value: string): void { if (!value.trim()) throw new Error('An explicit nonempty identity is required') }
}
