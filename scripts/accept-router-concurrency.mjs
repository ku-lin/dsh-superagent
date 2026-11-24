/**
 * Concurrency acceptance against a LIVE host: several callers race to refresh the same Router.
 *
 * The requirement is that concurrent refreshes cannot both archive and both switch, and cannot lose or duplicate an
 * archive. This fires the requests in parallel and then reads the durable state back, rather than trusting the answers.
 *
 * Usage: node scripts/accept-router-concurrency.mjs [parallel]
 */
const base = process.env.DSH_SUPERAGENT_URL === undefined
  ? 'http://127.0.0.1:3080/orchestrator/api'
  : `${process.env.DSH_SUPERAGENT_URL.replace(/\/$/, '')}/orchestrator/api`
const headers = { 'x-orchestrator-request': '1' }
const parallel = Number(process.argv[2] ?? 4)

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

async function call(method, path, body) {
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: { ...headers, ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  let parsed
  try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed }
}

const before = (await call('GET', 'managed-routers')).body.items.map(item => item.identity)
const target = before.find(item => item.routerId === 'router-primary')
if (!target) { console.error('router-primary is not bound'); process.exit(2) }
console.log(`target: ${target.routerId} gen=${target.generation} session=${target.sessionId}, racing ${parallel} callers`)

// Every caller states the SAME generation it believes it holds: exactly one may win, the rest must be refused.
const attempts = await Promise.all(Array.from({ length: parallel }, () =>
  call('POST', `managed-routers/${encodeURIComponent(target.routerId)}/refresh`,
    { sessionId: target.sessionId, generation: target.generation })))
const wins = attempts.filter(a => a.status === 200)
const refused = attempts.filter(a => a.status === 409)
const other = attempts.filter(a => a.status !== 200 && a.status !== 409)
check('exactly one concurrent refresh commits', wins.length === 1, `${wins.length} × 200, ${refused.length} × 409, ${other.length} other${other.length ? ` (${JSON.stringify(other[0].body)})` : ''}`)
check('every loser is refused with a conflict, not a server error', other.length === 0, other.length ? JSON.stringify(other[0].body) : 'no 5xx')

const after = (await call('GET', 'managed-routers')).body.items.map(item => item.identity).find(item => item.routerId === target.routerId)
check('the generation advanced exactly once for the whole race', after.generation === target.generation + 1,
  `${target.generation} → ${after.generation}`)
check('the Router points at the winner\'s Session', wins.length === 1 && after.sessionId === wins[0].body.identity.sessionId,
  wins.length === 1 ? `${after.sessionId}` : 'no single winner')

// A second race on the now-stale generation must be refused entirely: nothing to archive, nothing to switch.
const stale = await Promise.all(Array.from({ length: parallel }, () =>
  call('POST', `managed-routers/${encodeURIComponent(target.routerId)}/refresh`,
    { sessionId: target.sessionId, generation: target.generation })))
check('a race on a stale generation commits nothing', stale.every(a => a.status === 409),
  stale.map(a => a.status).join(','))
const stillThere = (await call('GET', 'managed-routers')).body.items.map(item => item.identity).find(item => item.routerId === target.routerId)
check('the generation did not move on the stale race', stillThere.generation === after.generation, `${stillThere.generation}`)

// One archive per source identity: a race must not duplicate the archived text.
const knowledge = await call('GET', `managed-routers/${encodeURIComponent(target.routerId)}/knowledge?sessionId=${encodeURIComponent(after.sessionId)}`)
const versions = knowledge.body?.versions ?? []
const sources = versions.map(v => v.sourceId)
check('no two versions name the same archive', new Set(sources).size === sources.length, `${versions.length} version(s)`)
check('the history is readable after the race', knowledge.status === 200, `HTTP ${knowledge.status}`)

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
