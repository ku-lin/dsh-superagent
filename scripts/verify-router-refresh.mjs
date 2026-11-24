/**
 * Prove archive-and-refresh end to end on a real host, with a real Taskboard, instead of only in a unit test.
 *
 * Registering a managed Router requires a project that the Taskboard knows (`requireProject`), so a host without a board
 * can never exercise this path. This writes a minimal board with the same schema the plugin reads — `projects` and
 * `tasks` — then walks the real API: register, refresh, and check the three properties the acceptance asks for:
 *
 *   1. the archive completes BEFORE the pointer moves (the response carries the archived byte/event span);
 *   2. the generation number advances;
 *   3. a stale request is refused by name, and the new generation still cannot delete itself.
 *
 * Usage: node scripts/verify-router-refresh.mjs --home <DSH_HOME> --port <port> [--seed-only]
 * The host must already be running with that DSH_HOME on that port.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const flag = name => args.includes(`--${name}`)
const home = arg('home')
const port = arg('port') ?? '3091'
if (!home) throw new Error('Usage: node scripts/verify-router-refresh.mjs --home <DSH_HOME> --port <port>')
if (!existsSync(home)) throw new Error(`The DSH_HOME does not exist: ${home}`)

// This script WRITES a Taskboard and MOVES a live Router's pointer. Pointed at a real deployment it would seed data into
// somebody's board and replace their Router conversation, so it refuses before writing anything. Two conditions:
//   - the port must not be the production one;
//   - the home must not already hold a Taskboard: seeding into an existing board is the one way this could edit real data.
// An isolated home is fresh, so its board is absent by construction; the refusal names the flag that overrides it.
const PRODUCTION_PORTS = new Set(['3080'])
if (PRODUCTION_PORTS.has(String(port)))
  throw new Error(`Refusing to run against the production port ${port}: this script seeds a Taskboard and refreshes a live Router`)
const boardPath = join(home, 'taskboard.sqlite')
if (existsSync(boardPath) && !flag('reuse-board') && !flag('seed-only'))
  throw new Error(`Refusing to seed into an existing Taskboard at ${boardPath}. Use an isolated DSH_HOME, or pass --reuse-board if you are sure it is a throwaway board.`)
// A home that has served real traffic is not a throwaway either, board or not.
const stateDir = join(home, 'state', 'superagent')
if (existsSync(join(stateDir, 'orchestrator.sqlite')) && !flag('seed-only')) {
  const bytes = readFileSync(join(stateDir, 'orchestrator.sqlite'), { flag: 'r' }).length
  if (bytes > 2_000_000)
    throw new Error(`Refusing to refresh a Router in a home that looks lived-in (${bytes} bytes of state). Use a fresh DSH_HOME.`)
}
// Resolve once so every later message names the directory actually used.
const resolvedHome = realpathSync(resolve(home))

const PROJECT_ID = 'proj-router-refresh'
const base = `http://127.0.0.1:${port}/orchestrator/api/`
const headers = { 'x-orchestrator-request': '1', 'content-type': 'application/json' }
const call = async (path, init = {}) => {
  const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(120_000), ...init })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

// 1. Seed a board the plugin will read, in its own default location for this DSH_HOME.
{
  const path = join(resolvedHome, 'taskboard.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`create table if not exists projects (id text primary key, key text not null, name text not null);
create table if not exists tasks (id text primary key, project_id text, identifier text, title text, status text, priority integer, updated_at integer, archived_at integer);`)
  db.prepare('insert or replace into projects (id,key,name) values (?,?,?)').run(PROJECT_ID, 'router-refresh', 'Router refresh probe')
  db.prepare('insert or replace into tasks (id,project_id,identifier,title,status,priority,updated_at,archived_at) values (?,?,?,?,?,?,?,?)')
    .run('t-refresh', PROJECT_ID, 'RR-1', 'Refresh probe task', 'todo', 2, Date.now(), null)
  db.close()
}

if (flag('seed-only')) { console.log(JSON.stringify({ seeded: join(home, 'taskboard.sqlite') })); process.exit(0) }

// 2. The board must be visible before anything can be registered.
const tasks = await call('tasks')
if (!tasks.body?.available || !tasks.body.projects?.some(project => project.id === PROJECT_ID))
  throw new Error(`The Taskboard does not list ${PROJECT_ID}: ${JSON.stringify(tasks.body).slice(0, 200)}`)

const state = await call('state')
const master = state.body.masterId

// 3. Register the live Router as a managed Router for that project.
const registered = await call('managed-routers', { method: 'POST',
  body: JSON.stringify({ routerId: 'router-refresh', projectId: PROJECT_ID, sessionId: master }) })
if (registered.status !== 200)
  throw new Error(`Registering the managed Router was refused: ${registered.status} ${JSON.stringify(registered.body)}`)
const first = registered.body.identity

// 4. Archive and refresh.
const refreshed = await call('managed-routers/router-refresh/refresh', { method: 'POST',
  body: JSON.stringify({ sessionId: first.sessionId, generation: first.generation }) })
if (refreshed.status !== 200)
  throw new Error(`Refresh was refused: ${refreshed.status} ${JSON.stringify(refreshed.body)}`)
const { identity, archived, sourceId } = refreshed.body

const failures = []
if (!(archived?.bytes > 0 && archived?.events > 0))
  failures.push(`the archive reported no span: ${JSON.stringify(archived)}`)
if (!(sourceId && /sha256:[0-9a-f]{64}/.test(sourceId)))
  failures.push(`no content-addressed sourceId: ${JSON.stringify(sourceId)}`)
if (!(identity.generation === first.generation + 1))
  failures.push(`generation did not advance: ${first.generation} -> ${identity?.generation}`)
if (identity.sessionId === first.sessionId)
  failures.push('the pointer still names the archived Session')

// 5. The new generation is protected; the stale one is refused by name.
const del = await call(`sessions/${encodeURIComponent(identity.sessionId)}?confirm=true`, { method: 'DELETE' })
if (del.body?.code !== 'routerSession')
  failures.push(`the new generation was not protected from delete: ${del.status} ${JSON.stringify(del.body)}`)

const stale = await call('managed-routers/router-refresh/refresh', { method: 'POST',
  body: JSON.stringify({ sessionId: first.sessionId, generation: first.generation }) })
if (stale.status !== 409)
  failures.push(`a stale refresh was not refused: ${stale.status} ${JSON.stringify(stale.body)}`)

if (failures.length > 0) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log(JSON.stringify({ ok: true, from: first, to: identity, archived, sourceId }, null, 1))
