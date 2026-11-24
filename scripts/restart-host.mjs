/**
 * Restart the DSH web host so the profile re-reads its plugin patch files.
 *
 * A bundle's `cordis.patch.yml` (which declares agent presets) is read when the profile composes, not by the
 * plugin hot-reload path, so a preset rename needs a real process restart.
 *
 * Runs as one background job: stop the old process, then start the replacement and wait until it answers.
 * Usage: node scripts/restart-host.mjs <pid> [--port <port>] [--dry-run]
 *
 * The deployment is named by DSH_ROOT (the checkout that holds node_modules) and DSH_HOME (its data directory), so
 * this never assumes one machine's layout. The replacement inherits this process's environment plus those two.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const dryRun = process.argv.includes('--dry-run')
const portAt = process.argv.indexOf('--port')
const PORT = portAt === -1 ? 3080 : Number(process.argv[portAt + 1])
const ROOT = process.env.DSH_ROOT
const HOME = process.env.DSH_HOME
if (ROOT === undefined || HOME === undefined) {
  throw Error('Set DSH_ROOT to the DSH checkout and DSH_HOME to its data directory.')
}
const BIN = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const alive = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) })
    return response.status > 0
  } catch { return false }
}

const oldPid = Number(process.env.DSH_OLD_PID ?? process.argv.find(arg => /^\d+$/.test(arg)) ?? 0)
if (!oldPid) {
  console.error('Pass the pid to stop: node scripts/restart-host.mjs <pid> [--port <port>]')
  process.exitCode = 1
  process.exit()
}
console.log(`stopping pid ${oldPid}`)
if (!dryRun) {
  try { process.kill(oldPid) } catch (error) { console.log(`kill failed (it may already be gone): ${error.message}`) }
  for (let attempt = 0; attempt < 20 && await alive(); attempt++) await delay(1000)
  console.log(await alive() ? 'the old host still answers the port' : 'the old host released the port')
}

const child = spawn(process.execPath, [BIN, 'web'], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, DSH_HOME: HOME },
})
child.unref()
console.log(`${dryRun ? 'dry run: would spawn' : 'spawned'} replacement pid ${child.pid}`)
if (dryRun) process.exit()

for (let attempt = 0; attempt < 60; attempt++) {
  await delay(2000)
  if (child.exitCode !== null) { console.log(`replacement exited with code ${child.exitCode}`); process.exitCode = 1; break }
  if (await alive()) { console.log(`the replacement serves ${PORT}`); break }
  if (attempt === 59) { console.log('the replacement did not answer within 120s'); process.exitCode = 1 }
}
