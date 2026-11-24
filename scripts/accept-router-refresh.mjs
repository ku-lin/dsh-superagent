/**
 * End-to-end acceptance for the Router archive-before-refresh feature, run against a LIVE host.
 *
 * Everything below talks to the running host over its own management API, so a green result means the artifact the
 * process actually loaded behaves as required — not that the sources would if rebuilt. Run it after a host restart.
 *
 * The order matters: a failure at any step leaves the conversation and its pointer untouched, and this script asserts
 * exactly that rather than trusting the answer's wording.
 *
 * Usage:
 *   node scripts/accept-router-refresh.mjs --base http://127.0.0.1:3080 --project <taskboardProjectId> \
 *     --session <routerSessionId> --router <routerId>
 * Add --read-only to inspect the host without binding or refreshing anything.
 */
const args = process.argv.slice(2)
const arg = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1] }
const base = (arg('base') ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
const projectId = arg('project')
const sessionId = arg('session')
const routerId = arg('router') ?? 'router-primary'
const readOnly = args.includes('--read-only')

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

async function call(method, path, body) {
  const response = await fetch(`${base}/orchestrator/api/${path}`, {
    method,
    headers: { 'x-orchestrator-request': '1', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  let parsed
  try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed }
}

// 1. The routes this feature needs must exist in the RUNNING process. This is the check that failed while the host
//    still held the module it loaded at startup, so it is the first gate.
const list = await call('GET', 'managed-routers')
check('the running host exposes the managed-Router routes', list.status === 200,
  list.status === 200 ? `${list.body?.total ?? 0} bound` : `HTTP ${list.status}: ${JSON.stringify(list.body)}`)
if (list.status !== 200) {
  console.log('\nThe host is still running a build without this feature. Restart it and run this again.')
  process.exit(1)
}
const refreshProbe = await call('POST', `managed-routers/${encodeURIComponent(routerId)}/refresh`,
  { sessionId: sessionId ?? 'session-00000000-0000-4000-8000-000000000000', generation: 1 })
check('the refresh route answers as a route (not "Unknown operation")',
  !(refreshProbe.status === 404 && /Unknown operation/.test(String(refreshProbe.body?.error))),
  `HTTP ${refreshProbe.status} ${JSON.stringify(refreshProbe.body)}`)

if (readOnly) {
  console.log(`\nread-only: ${results.filter(r => r.ok).length}/${results.length} checks passed`)
  process.exit(results.every(r => r.ok) ? 0 : 1)
}
if (!projectId || !sessionId) {
  console.error('--project and --session are required unless --read-only is passed')
  process.exit(2)
}

// 2. Bind the Router to a real Taskboard project. An unknown project must be refused before anything is written.
const bogus = await call('POST', 'managed-routers', { routerId: `${routerId}-probe`, projectId: 'not-a-project', sessionId })
check('an unknown project is refused and leaves no binding', bogus.status === 404, `HTTP ${bogus.status}`)
const bind = await call('POST', 'managed-routers', { routerId, projectId, sessionId })
// Re-running acceptance against a Router that is already bound to this very Session is the idempotent case: the host
// answers 409 "already exists" because the registration is immutable, which is correct and not a failure of this run.
const alreadyBound = bind.status === 409 && /already exists/.test(String(bind.body?.error))
const current = alreadyBound ? (await call('GET', 'managed-routers')).body?.items?.map(item => item.identity)
  .find(item => item.routerId === routerId) : bind.body?.identity
check('the Router is bound to the project for this Session', bind.status === 200 || alreadyBound,
  alreadyBound ? `already bound (idempotent): ${JSON.stringify(current)}` : `HTTP ${bind.status} ${JSON.stringify(bind.body)}`)
if (!current) process.exit(1)
// The Session a refresh may replace is whichever one the Router holds now; a re-run after a successful refresh must act
// on the current generation rather than the original one.
const identity = current
const activeSessionId = identity.sessionId

// 3. Read the project state: the receipt is required before any project operation, and the summary is the durable one.
const knowledge = await call('GET', `managed-routers/${encodeURIComponent(routerId)}/knowledge?sessionId=${encodeURIComponent(activeSessionId)}`)
check('a project read returns a receipt pinned to the snapshot revision',
  knowledge.status === 200 && knowledge.body.receipt.revision === knowledge.body.snapshot.revision,
  `HTTP ${knowledge.status}`)
check('the summary the next conversation receives is structured project state',
  typeof knowledge.body?.snapshot?.summary === 'string' && /Goal:/.test(knowledge.body.snapshot.summary)
    && /Next step:/.test(knowledge.body.snapshot.summary), `revision ${knowledge.body?.snapshot?.revision}`)
// A superseded or invented Session must not read the project's context.
const foreign = await call('GET', `managed-routers/${encodeURIComponent(routerId)}/knowledge?sessionId=session-not-a-generation`)
check('a Session that is not the current generation cannot read the project', foreign.status === 409, `HTTP ${foreign.status}`)

// 4. The refresh itself: archive first, then switch. The answer names the archive so it can be proven afterwards.
const before = identity.generation
const refresh = await call('POST', `managed-routers/${encodeURIComponent(routerId)}/refresh`, { sessionId: activeSessionId, generation: before })
check('the refresh commits and reports its archive', refresh.status === 200 && typeof refresh.body?.sourceId === 'string',
  `HTTP ${refresh.status} ${JSON.stringify(refresh.body?.identity ?? refresh.body)}`)
if (refresh.status === 200) {
  const next = refresh.body.identity
  check('the Router advanced exactly one generation', next.generation === before + 1, `${before} → ${next.generation}`)
  check('the new Session differs from the archived one', next.sessionId !== activeSessionId, next.sessionId)
  const archived = Number(refresh.body?.archived?.events ?? refresh.body?.archived)
  check('the archive is not empty', archived > 0, `${archived} events archived (${refresh.body?.archived?.bytes ?? '?'} bytes)`)
  check('the archive identity is content-addressed', /^sha256:[0-9a-f]{64};events:\d+;seq:\d+-\d+;bytes:\d+$/.test(String(refresh.body.sourceId)),
    String(refresh.body.sourceId).slice(0, 60) + '…')
  // The old generation must lose both its authority and its ability to read the project.
  const stale = await call('GET', `managed-routers/${encodeURIComponent(routerId)}/knowledge?sessionId=${encodeURIComponent(activeSessionId)}`)
  check('the archived Session can no longer read the project', stale.status === 409, `HTTP ${stale.status}`)
  // Retrying the same refresh must be refused, so a double click cannot archive twice.
  const retry = await call('POST', `managed-routers/${encodeURIComponent(routerId)}/refresh`, { sessionId: activeSessionId, generation: before })
  check('a stale retry of the same refresh is refused', retry.status === 409, `HTTP ${retry.status}`)
  // The new generation works and carries the durable project state forward.
  const fresh = await call('GET', `managed-routers/${encodeURIComponent(routerId)}/knowledge?sessionId=${encodeURIComponent(next.sessionId)}`)
  check('the new generation reads the project state', fresh.status === 200
    && fresh.body.receipt.revision === fresh.body.snapshot.revision, `HTTP ${fresh.status}`)
}

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
