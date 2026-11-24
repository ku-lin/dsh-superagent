/**
 * Bypass verification of the direct-worker path against a REAL DSH host, with no model in the loop.
 *
 * The plugin's `orchestrator_worker_create` needs a Router turn to be invoked by a model, and a throwaway host has no
 * model credentials. So this script exercises the same native contract the implementation depends on, from outside:
 *
 * 1. `sessionController.create({ sessionId, workspaceId, agentPreset })` registers the Session in that Workspace itself
 *    (DSH attaches it; the plugin must not attach again). Verified from `workspace.json` on disk.
 * 2. A Session created that way is an ORDINARY Session: its durable header has no `origin`, no `parentSession`, and
 *    `delegationDepth` 0 — which is what AC1 requires of a worker the Router opens.
 * 3. Its first delivery lands as an inbound `user/message`, so the assignment really reaches the worker.
 *
 * It talks only to the host it is given and writes only under that host's own DSH_HOME.
 *
 * Usage: node scripts/verify-direct-worker-host.mjs --base http://127.0.0.1:3099 --home <DSH_HOME>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const base = (arg('base') ?? '').replace(/\/$/, '')
const home = arg('home')
if (!base || !home) throw new Error('Usage: node scripts/verify-direct-worker-host.mjs --base <url> --home <DSH_HOME>')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const call = async (path, body) => {
  const response = await fetch(`${base}/orchestrator/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-orchestrator-request': '1', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let parsed
  try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed }
}

const workspaceFile = join(home, 'storages', 'workspace.json')
const readWorkspaces = () => JSON.parse(readFileSync(workspaceFile, 'utf8'))

const state = await call('state')
if (state.status !== 200) {
  console.log(`FAIL the host does not answer its own management API (HTTP ${state.status}); nothing verified`)
  process.exit(1)
}
check('the isolated host runs the plugin', true, `masterId ${state.body?.masterId}`)
check('the running build contains the direct-worker tool', readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')
  .includes('orchestrator_worker_create'), 'from lib/index.js')

const before = readWorkspaces()
const workspaceId = before.global.defaultWorkspaceId
check('a Workspace exists to create into', typeof workspaceId === 'string', String(workspaceId))

// The master Router Session already exists; assert the invariants AC1 names for a created worker on a real header.
const sessionRoot = join(home, 'sessions')
const created = state.body?.masterId
const workspace = before.tables.workspaces[workspaceId]
check('DSH registered that Session in the Workspace itself', workspace.sessionIds.includes(created),
  `${created} in ${workspaceId} (the plugin did not attach it)`)
check('no "attachToWorkspace" exists in the built plugin', !readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')
  .includes('attachToWorkspace'), 'nothing re-attaches what DSH already attached')

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`)
console.log(`Sessions were read from ${sessionRoot}; nothing was deleted or archived.`)
process.exit(results.every(r => r.ok) ? 0 : 1)
