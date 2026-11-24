/**
 * One-time backfill: record the summary that the pre-history schema left only in the latest row.
 *
 * The earlier code overwrote `project_knowledge` on every checkpoint, so summaries of archives taken before this fix
 * survive only as that single newest row. This writes that row into `project_knowledge_version` so the history view is
 * honest about what it actually has — it never invents a summary for a revision whose text was lost, and it says so.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

// The state directory is whatever DSH_HOME names here, so the script runs against any deployment. Refusing when it is
// unset is deliberate: a default would aim this write at the wrong machine's database.
const home = process.env.DSH_HOME
if (!home) throw Error('Set DSH_HOME to the deployment whose state directory holds orchestrator.sqlite.')
const db = new DatabaseSync(join(home, 'state', 'superagent', 'orchestrator.sqlite'))
db.exec(`CREATE TABLE IF NOT EXISTS project_knowledge_version (
  project_id TEXT NOT NULL, revision INTEGER NOT NULL, summary TEXT NOT NULL, source_id TEXT NOT NULL,
  router_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, revision))`)
for (const row of db.prepare('SELECT project_id, revision, summary, updated_at FROM project_knowledge').all()) {
  const archive = db.prepare('SELECT source_id FROM project_context_archive WHERE project_id=? ORDER BY created_at DESC LIMIT 1')
    .get(row.project_id)
  const router = db.prepare('SELECT router_id FROM router_project_binding WHERE project_id=? LIMIT 1').get(row.project_id)
  db.prepare('INSERT OR IGNORE INTO project_knowledge_version VALUES (?,?,?,?,?,?)')
    .run(row.project_id, row.revision, row.summary, String(archive?.source_id ?? ''), String(router?.router_id ?? ''), row.updated_at)
  console.log(`backfilled ${row.project_id} rev ${row.revision}`)
}
const rows = db.prepare('SELECT project_id, revision, created_at FROM project_knowledge_version ORDER BY project_id, revision DESC').all()
console.log('version rows now:', rows.length)
for (const row of rows) console.log(`  ${row.project_id} rev ${row.revision} ${row.created_at}`)
console.log('\nNOTE: revisions before the recorded one are gone — the old schema kept only the newest summary.')
db.close()
