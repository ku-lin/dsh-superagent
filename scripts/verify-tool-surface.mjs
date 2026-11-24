/**
 * Read the tool surface a REAL DSH host hands to each Session, instead of asking a model what it thinks it has.
 *
 * A model's self-report is not evidence: in this deployment the Router answered "no such tool" and then produced a
 * contradicting table for the same question. `ctx.tools.wireSchemas(scope)` is the set the host actually assembles, so it
 * is the fact worth reading.
 *
 * This writes a throwaway plugin that dumps that set to a file, and prints the file to add to the profile's patch list.
 * Usage: node scripts/verify-tool-surface.mjs --home <DSH_HOME> --out <report.json>
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const out = arg('out')
if (!out) throw new Error('Usage: node scripts/verify-tool-surface.mjs --out <report.json>')

const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-surface-'))
const plugin = join(dir, 'index.mjs')
const target = JSON.stringify(out)
writeFileSync(plugin, `
import { writeFileSync } from 'node:fs'
export const name = 'verify-tool-surface'
export const inject = ['tools', 'agents', 'sessionProjections']
export function apply(ctx) {
  const write = () => {
    const rows = []
    for (const [, agent] of ctx.agents) {
      let names
      try { names = ctx.tools.wireSchemas(agent.ctx).schemas.map(schema => schema.name).sort() }
      catch (error) { names = ['<unreadable: ' + String(error && error.message) + '>'] }
      const preset = ctx.sessionProjections?.stateOf?.(agent.session, 'agentPreset') ?? agent.session.header.agentPreset ?? null
      rows.push({ sessionId: agent.id, preset, tools: names })
    }
    try { writeFileSync(${target}, JSON.stringify(rows, null, 1)) } catch {}
  }
  // After every turn: the surface a Session was really offered when it answered.
  ctx.on('agent/status', ({ status }) => { if (status === 'idle') write() })
  write()
}
`, 'utf8')
console.log(JSON.stringify({ plugin, out }))
