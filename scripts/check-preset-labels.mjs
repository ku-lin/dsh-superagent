/**
 * Check that both patch files parse and carry the intended mode-picker labels.
 *
 * Two files declare the superagent presets: the plugin bundle's `cordis.patch.yml` (the Executor preset) and the
 * profile's `cordis.patch.yml` (a full-row override of the Router preset, added for the compaction policy). The
 * profile override wins, so a rename applied only to the bundle leaves the picker unchanged — which this prints.
 *
 * Usage: node scripts/check-preset-labels.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

// Both files are addressed relative to this script, so the check runs from any checkout without naming this machine.
const repo = resolve(import.meta.dirname, '..')
const require = createRequire(join(repo, 'package.json'))
let YAML
try {
  YAML = require('yaml')
} catch {
  // `yaml` is not a declared dependency of this repository, only a transitive one, so it may not be resolvable from a
  // clean install. Saying so beats a check that quietly reads nothing.
  throw Error('This check needs the `yaml` package; install it (pnpm add -D yaml) or run it in a tree that has it.')
}
const jsTag = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }

const bundle = join(repo, 'cordis.patch.yml')
// The profile's own patch overrides the bundle's preset row, so both have to be read; the deployment names it.
const profile = process.env.DSH_PROFILE_DIR === undefined
  ? undefined
  : join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml')

/**
 * Walk the parsed tree for every agent-preset row, so a nested or overridden declaration is never missed.
 *
 * A row either declares the preset plugin outright (`name: '@deepseek-ai/dsh-agent-preset'` plus a full `config`) or
 * overrides one already declared elsewhere by `id` with a `config` only. Both shapes decide what the picker shows,
 * and the override is applied last, so both are collected here.
 */
const presets = (node, found = []) => {
  if (Array.isArray(node)) { for (const item of node) presets(item, found); return found }
  if (node && typeof node === 'object') {
    const config = node.config
    const declares = node.name === '@deepseek-ai/dsh-agent-preset'
    const overrides = typeof node.id === 'string' && node.id.endsWith('-preset')
    if ((declares || overrides) && config && typeof config === 'object' && typeof config.id === 'string') {
      found.push({ id: config.id, name: config.name, description: config.description, order: config.order,
        via: declares ? 'declaration' : `override of ${node.id}` })
    }
    for (const value of Object.values(node)) presets(value, found)
  }
  return found
}

const read = path => presets(YAML.parse(readFileSync(path, 'utf8'), jsTag))
const checks = []
for (const [label, path] of [['bundle', bundle], ['profile', profile]]) {
  if (path === undefined) {
    console.log(`${label}: SKIP (set DSH_PROFILE_DIR to the profile whose cordis.patch.yml overrides the presets)`)
    continue
  }
  try {
    const rows = read(path)
    console.log(`${label}: ${rows.length} preset row(s)`)
    for (const row of rows) console.log(`  ${row.id.padEnd(26)} name=${JSON.stringify(row.name)} order=${row.order} (${row.via})`)
    checks.push([`${label} patch parses`, true])
  } catch (error) {
    console.log(`${label}: PARSE FAILED ${error.message.split('\n')[0]}`)
    checks.push([`${label} patch parses`, false])
  }
}

// The bundle's own rows are always checkable; the profile override only when a profile was named.
const workerRow = read(bundle).find(row => row.id === 'dsh-superagent-worker')
checks.push(['the Executor preset no longer shows as a person-facing mode', workerRow?.name === 'superagent 内部·勿选'])
checks.push(['the Executor preset sorts last', (workerRow?.order ?? 0) >= 10000])

// The profile override is the one the picker reads for the Router preset, so it must carry the new copy.
if (profile !== undefined) {
  const routerRow = read(profile).find(row => row.id === 'dsh-superagent-router')
  checks.push(['the profile override names the Router preset "Router"', routerRow?.name === 'Router'])
  checks.push(['the profile override describes it as "调度会话"', routerRow?.description === '调度会话'])
  checks.push(['the profile override keeps the 0.65 compaction threshold',
    readFileSync(profile, 'utf8').includes('"thresholdRatio":0.65')])
}

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed++
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
if (failed) process.exitCode = 1
