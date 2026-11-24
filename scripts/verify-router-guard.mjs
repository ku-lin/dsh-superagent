/**
 * Prove the Router's delegation guard at EXECUTION time, not by asking a model what tools it thinks it has.
 *
 * A model's self-report is worthless here: in this deployment the Router answered "no such tool" and then produced a
 * contradicting table for the same question. And `wireSchemas` only shows the global tool surface, so it cannot prove the
 * guard either. `ctx.tools.guardReason(exec)` is the exact call the tool dispatcher makes before executing, so it is the
 * refusal that would actually be handed back to the model.
 *
 * Writes a throwaway probe plugin and prints the overlay to boot with. Usage:
 *   node scripts/verify-router-guard.mjs --home <DSH_HOME> [--port 3093]
 *
 * Expect for a Router Session: the five delegation names each answer with the one refusal text that names
 * orchestrator_worker_create / orchestrator_worker_message / orchestrator_route, while the plugin's own dispatch tools
 * answer `null` (not refused) — a guard that also blocked them would disable the Router entirely.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The preset this guard is about; kept beside the script so `--check` cannot silently look for the wrong one. */
const ROUTER_PRESET = 'dsh-superagent-router'

const args = process.argv.slice(2)
/** Value of `--name value`; a flag given on its own has no following value and reads as `undefined`. */
const arg = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
/** A switch is present or it is not: `--check` takes no value, so it must be tested by presence, never by `arg()`. */
const flag = name => args.includes(`--${name}`)
const home = arg('home')
const port = arg('port') ?? '3093'
if (!home) throw new Error('Usage: node scripts/verify-router-guard.mjs --home <DSH_HOME> [--port 3093] [--check]')
if (!existsSync(home)) throw new Error(`The DSH_HOME does not exist: ${home}`)

const probeDir = join(home, 'probe')
const report = join(home, 'guard-evidence.json').replace(/\\/g, '/')
const probe = join(probeDir, 'index.mjs').replace(/\\/g, '/')
const check = flag('check')

// Writing the probe is setup, not inspection. `--check` must leave the host's files exactly as they are: rewriting a probe
// the running host already loaded would make an inspection look like a change.
if (!check) {
  mkdirSync(probeDir, { recursive: true })

writeFileSync(join(probeDir, 'index.mjs'), `import { writeFileSync } from 'node:fs'
export const name = 'verify-router-guard'
export const inject = ['tools', 'agents']
export function apply(ctx) {
  const DELEGATION = ['subagent', 'subagent_fork', 'workflow', 'delegate', 'spawn_teammate']
  const DISPATCH = ['orchestrator_worker_create', 'orchestrator_worker_message', 'orchestrator_route']
  const probe = () => {
    const rows = []
    let agents = []
    try { agents = ctx.agents.list ? ctx.agents.list() : [] } catch { agents = [] }
    for (const agent of agents) {
      const preset = agent.session?.header?.agentPreset ?? null
      const verdicts = {}
      for (const name of [...DELEGATION, ...DISPATCH, 'bash', 'pwsh', 'write', 'edit']) {
        try {
          const exec = { name, arguments: {}, agent, ctx: agent.ctx }
          const reason = typeof ctx.tools.guardReason === 'function'
            ? ctx.tools.guardReason(exec)
            : ctx.tools.view(agent.ctx)?.guardReason?.(exec)
          verdicts[name] = reason ?? null
        } catch (error) { verdicts[name] = '<threw: ' + String(error && error.message) + '>' }
      }
      rows.push({ sessionId: agent.id, preset, verdicts })
    }
    try { writeFileSync('${report}', JSON.stringify(rows, null, 1)) } catch {}
  }
  ctx.on('agent/status', ({ status }) => { if (status === 'idle') probe() })
  probe()
}
`, 'utf8')

writeFileSync(join(home, 'overlay.yml'), [
  '- insert:',
  '    - id: verify-router-guard',
  `      name: '${probe}'`,
  '',
].join('\n'), 'utf8')
}

// A report with no Router row proves nothing, and an empty array is the easiest thing to mistake for a pass. The probe
// only sees Agents that already exist, so this states the precondition and how to meet it instead of printing `[]`.
if (check) {
  if (!existsSync(report)) throw new Error(`No report at ${report}: the host has not run the probe yet`)
  const rows = JSON.parse(readFileSync(report, 'utf8'))
  // The report is written by a probe inside another process; a truncated or reshaped file must be reported, not crash here
  // with `rows.filter is not a function` and leave the caller guessing what went wrong.
  if (!Array.isArray(rows))
    throw new Error(`The report at ${report} is not an array of Sessions: the probe did not finish writing it`)
  const router = rows.filter(row => row.preset === ROUTER_PRESET)
  if (rows.length === 0)
    throw new Error(`The report is empty: no Session existed when the probe ran. Open or create a Router conversation on the host (POST /orchestrator/api/router/start, or pick the Router preset in the UI), let it reach idle, then re-check.`)
  if (router.length === 0)
    throw new Error(`The report has ${rows.length} Session(s) but none runs ${ROUTER_PRESET}: presets seen: ${[...new Set(rows.map(row => row.preset))].join(', ')}`)
  const DELEGATION = ['subagent', 'subagent_fork', 'workflow', 'delegate', 'spawn_teammate']
  const DISPATCH = ['orchestrator_worker_create', 'orchestrator_worker_message', 'orchestrator_route']
  const failures = []
  for (const row of router) {
    for (const name of DELEGATION) {
      const verdict = row.verdicts?.[name]
      if (typeof verdict !== 'string' || !verdict.includes('orchestrator_worker_create'))
        failures.push(`${row.sessionId} ${name}: expected the dispatch refusal, got ${JSON.stringify(verdict)}`)
    }
    // A guard that also refused the Router's own dispatch tools would leave it unable to route at all. `undefined` means
    // the probe could not ask, which is not the same as "not refused" and must not pass.
    for (const name of DISPATCH) {
      const verdict = row.verdicts?.[name]
      if (verdict !== null)
        failures.push(`${row.sessionId} ${name}: must not be refused, got ${JSON.stringify(verdict)}`)
    }
  }
  if (failures.length > 0) { console.error(failures.join('\n')); process.exitCode = 1 }
  else console.log(JSON.stringify({ ok: true, routers: router.length,
    delegation: DELEGATION.map(name => ({ name, refused: typeof router[0].verdicts[name] === 'string' })),
    dispatchUnblocked: DISPATCH.map(name => ({ name, refused: router[0].verdicts[name] !== null })) }, null, 1))
}

if (!check) console.log(JSON.stringify({ probe, overlay: join(home, 'overlay.yml'), port, report }))
