/**
 * Durability acceptance: read the archive and history through the LIVE host, then prove the same rows survive a
 * restart by reading them again afterwards.
 *
 * Two modes. `--snapshot` records what the host reports now into a JSON file; `--compare` reads the file and checks the
 * host still reports the same identities, generations, summaries and archived byte counts. Byte counts are compared
 * from SQLite because the archive route does not return the text itself.
 *
 * Usage (DSH_HOME names the deployment; --base overrides the default host):
 *   node scripts/accept-router-durability.mjs --snapshot <file>
 *   node scripts/accept-router-durability.mjs --compare  <file>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const value = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1] }
const snapshotPath = value('snapshot') ?? value('compare')
const compare = args.includes('--compare')
const base = value('base') ?? 'http://127.0.0.1:3080/orchestrator/api'
const headers = { 'x-orchestrator-request': '1' }
// The database this reads is the deployment's own; naming it here keeps the script from aiming at another machine's.
const home = process.env.DSH_HOME
if (home === undefined) throw Error('Set DSH_HOME to the deployment whose state directory holds orchestrator.sqlite.')
const DB = join(home, 'state', 'superagent', 'orchestrator.sqlite')

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

async function observe() {
  const list = await (await fetch(`${base}/managed-routers`, { headers })).json()
  const routers = []
  for (const { identity } of list.items) {
    const url = `${base}/managed-routers/${encodeURIComponent(identity.routerId)}/knowledge?sessionId=${encodeURIComponent(identity.sessionId)}`
    const body = await (await fetch(url, { headers })).json()
    routers.push({ identity, revision: body?.snapshot?.revision, summaryLength: body?.snapshot?.summary?.length ?? 0,
      versions: (body?.versions ?? []).map(v => ({ revision: v.revision, sourceId: v.sourceId })) })
  }
  const db = new DatabaseSync(DB, { readOnly: true })
  const archives = db.prepare('SELECT project_id, session_id, source_id, sha256, length(raw) AS chars FROM project_context_archive ORDER BY project_id, session_id, source_id').all()
  const knowledge = db.prepare('SELECT project_id, revision, summary FROM project_knowledge ORDER BY project_id').all()
  db.close()
  return { routers, archives, knowledge }
}

const now = await observe()

if (!compare) {
  writeFileSync(snapshotPath, JSON.stringify(now, null, 2))
  console.log(`snapshot written: ${now.routers.length} router(s), ${now.archives.length} archive(s)`)
  console.log(`total archived characters: ${now.archives.reduce((sum, a) => sum + Number(a.chars), 0).toLocaleString()}`)
  process.exit(0)
}

const before = JSON.parse(readFileSync(snapshotPath, 'utf8'))
check('the same Routers are still bound after the restart', now.routers.length === before.routers.length,
  `${before.routers.length} → ${now.routers.length}`)
for (const old of before.routers) {
  const current = now.routers.find(r => r.identity.routerId === old.identity.routerId)
  check(`${old.identity.routerId} kept its binding and generation`,
    current !== undefined && current.identity.projectId === old.identity.projectId
      && current.identity.sessionId === old.identity.sessionId && current.identity.generation === old.identity.generation,
    current === undefined ? 'missing' : `gen ${current.identity.generation}`)
  // The summary the next conversation reads is still there, character for character.
  check(`${old.identity.routerId} kept the same state summary`,
    current !== undefined && current.revision === old.revision && current.summaryLength === old.summaryLength,
    current === undefined ? 'missing' : `rev ${current.revision}, ${current.summaryLength} chars`)
  check(`${old.identity.routerId} kept its whole summary history`,
    current !== undefined && JSON.stringify(current.versions) === JSON.stringify(old.versions),
    current === undefined ? 'missing' : `${current.versions.length} version(s)`)
}
// The archived text itself is the thing that must never be lost: compare every row by content address and size.
check('every archived conversation survived the restart byte-for-byte',
  JSON.stringify(now.archives) === JSON.stringify(before.archives),
  `${now.archives.length} archive row(s), ${now.archives.reduce((sum, a) => sum + Number(a.chars), 0).toLocaleString()} characters`)
check('the latest-knowledge rows are unchanged', JSON.stringify(now.knowledge) === JSON.stringify(before.knowledge),
  `${now.knowledge.length} row(s)`)

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
