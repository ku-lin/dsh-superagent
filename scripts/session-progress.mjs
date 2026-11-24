/**
 * Report whether one Session log is making real progress or repeating itself.
 *
 * A run that keeps calling tools on the same file makes progress when the operations differ and the file's mutation time
 * moves; a run that re-reads the same slide and re-applies the same op is spinning. Both are visible from the tool calls
 * alone, so this needs no model call and no host contact.
 *
 * Usage: node scripts/session-progress.mjs <session-dir>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
const file = readdirSync(dir).find(name => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
if (file === undefined) { console.error('no session log'); process.exit(1) }
const raw = readFileSync(join(dir, file))

// A Session log is concatenated Zstd frames; one `decompressSync` stops after the first, so walk every frame.
const starts = []
for (let i = 0; i < raw.length - 4; i++) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
}
let text = ''
for (let k = 0; k < starts.length; k++) {
  try { text += zstdDecompressSync(raw.subarray(starts[k], starts[k + 1] ?? raw.length)).toString('utf8') } catch { /* skip a bad frame */ }
}
const events = text.split('\n').filter(line => line.trim().startsWith('{')).map(line => {
  try { return JSON.parse(line) } catch { return undefined }
}).filter(Boolean)

let turn = 0, step = 0
for (const event of events) {
  const data = event.data ?? event
  if (typeof data.turn === 'number') turn = Math.max(turn, data.turn)
  if (data.turn === turn && typeof data.step === 'number') step = Math.max(step, data.step)
}

const calls = []
for (const event of events) {
  if (event.type !== 'tool/call') continue
  const data = event.data ?? event
  if (data.turn !== turn) continue
  const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
  const file = /"file"\s*:\s*"([^"]+)"/.exec(args)?.[1] ?? ''
  const slide = /"slide"\s*:\s*(\d+)/.exec(args)?.[1] ?? ''
  calls.push({ name: data.name, file, slide, args })
}

/** A fingerprint of what was asked for, so a repeating op is recognisable. */
const fingerprint = call => `${call.name}|${call.file}|${call.slide}|${call.args.length}`

console.log(`turns so far: ${turn}, steps in the current turn: ${step}`)
console.log(`tool calls this turn: ${calls.length}`)
console.log(`distinct files: ${[...new Set(calls.map(c => c.file).filter(Boolean))].join(', ') || '(none)'}`)
const names = {}
for (const call of calls) names[call.name] = (names[call.name] ?? 0) + 1
console.log(`by tool: ${Object.entries(names).map(([n, c]) => `${n}×${c}`).join(', ')}`)
// Repeating the same call shape is the signature of a loop that is not advancing.
const prints = calls.map(fingerprint)
const repeats = prints.length - new Set(prints).size
console.log(`repeated call shapes: ${repeats}/${prints.length}`)
console.log('last 10 calls:')
for (const call of calls.slice(-10)) console.log(`  ${call.name} slide=${call.slide || '-'} ${call.file ? call.file.split(/[\\/]/).pop() : ''}`)
