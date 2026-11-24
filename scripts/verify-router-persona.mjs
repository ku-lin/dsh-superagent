// Exercise the actual installed prompt renderer, without a model call or host restart.
//
// Two things are checked, because the original failure had two halves: a deployment suffix that referenced an
// unregistered variable, and no offline way to notice it before a person hit the error in a real Session.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [profile, renderer, ...presetFiles] = process.argv.slice(2)
if (!profile || !renderer) {
  throw Error('Usage: node scripts/verify-router-persona.mjs <profile-patch.yml> <dsh-system-prompt/lib/index.js> [bundle-patch.yml...]')
}
const { renderPrompt } = await import(pathToFileURL(resolve(renderer)).href)

/** One assembly as the host builds it: only `provider` and `model` are registered here, which is what made `cwd` fail. */
const assembly = text => ({ sections: [{ name: 'deployment:persona-suffix', text }],
  variables: { provider: 'test', model: 'test' }, contexts: [], tools: [] })
const renders = text => {
  try { return { ok: true, text: renderPrompt(assembly(text)) } } catch (error) { return { ok: false, error: error.message } }
}

// 1. The failure itself must still reproduce, or this check would pass on a renderer that stopped validating.
const original = renders('Your working directory is {{cwd}}.')
if (original.ok || !/unknown prompt variable/.test(original.error)) throw Error('Original cwd failure did not reproduce')

// 2. The deployed profile must render with only those two variables.
const profileSource = readFileSync(profile, 'utf8')
const suffix = profileSource.match(/^    personaSuffix: (.+)$/m)?.[1]
if (!suffix) throw Error('Expected a scalar personaSuffix in the supplied deployment profile')
const deployed = renders(suffix)
if (!deployed.ok) throw Error(`Deployment personaSuffix still fails to render: ${deployed.error}`)

// 3. Every Router preset this plugin ships must render too. The preset's own prompt sections are literal (interpolate:
//    false in the plugin), so the check is that no preset carries a `{{...}}` reference that the host would refuse.
const checked = []
for (const file of presetFiles) {
  const source = readFileSync(file, 'utf8')
  // A row's `config:` may be a block or one-line JSON; read both without a YAML dependency.
  const oneLine = [...source.matchAll(/^\s*config:\s*(\{.*\})\s*$/gm)].map(match => match[1])
  for (const json of oneLine) {
    let config
    try { config = JSON.parse(json) } catch { continue }
    if (config?.id !== 'dsh-superagent-router' && config?.id !== 'dsh-superagent-worker') continue
    const unregistered = [...JSON.stringify(config).matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)]
      .map(match => match[1]).filter(name => name !== 'provider' && name !== 'model')
    if (unregistered.length > 0) throw Error(`${config.id} references unregistered prompt variables: ${unregistered.join(', ')}`)
    checked.push(config.id)
  }
}

console.log('PASS: original cwd failure reproduced; deployment suffix renders with provider/model only'
  + `; preset(s) free of unregistered variables: ${checked.length > 0 ? checked.join(', ') : '(none supplied)'}`)
