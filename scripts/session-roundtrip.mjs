/**
 * Prove one worker Session had a real round trip with its Router.
 *
 * AC3 asks for evidence, not assertion: the assignment must arrive as an inbound user message and the worker must answer
 * it with an assistant message, in that order, in the same log. This prints that sequence and counts the exchanges.
 *
 * Usage: node scripts/session-roundtrip.mjs <session-dir>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
const file = readdirSync(dir).find(name => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
if (file === undefined) { console.error('no session log'); process.exit(1) }
const raw = readFileSync(join(dir, file))

// Concatenated frames: inflate each, or only the header is recovered.
const starts = []
for (let i = 0; i < raw.length - 4; i++) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
}
let text = ''
for (let k = 0; k < starts.length; k++) {
  try { text += zstdDecompressSync(raw.subarray(starts[k], starts[k + 1] ?? raw.length)).toString('utf8') } catch { /* skip a bad frame */ }
}

const blocks = message => {
  const content = message?.content ?? message?.message?.content
  if (Array.isArray(content)) return content.map(block => block.text).filter(Boolean).join(' ')
  return typeof content === 'string' ? content : ''
}

/** Injected scaffolding the host appends every turn; it is not a human talking and not the worker answering. */
const injected = value => /^(<system-reminder>|Current runtime context|Current working directory|Time sampled|# 项目级记忆)/.test(value.trim())

const sequence = []
for (const line of text.split('\n')) {
  if (!line.trim().startsWith('{')) continue
  let event
  try { event = JSON.parse(line) } catch { continue }
  const data = event.data ?? event
  if (event.type === 'user/message') {
    const said = blocks(data).trim()
    if (said !== '' && !injected(said)) sequence.push({ dir: 'IN ', text: said.replace(/\s+/g, ' ') })
  } else if (event.type === 'assistant/message') {
    const said = blocks(data).trim()
    if (said !== '') sequence.push({ dir: 'OUT', text: said.replace(/\s+/g, ' ') })
  }
}

console.log(`${sequence.length} conversational message(s), in order:`)
for (const entry of sequence.slice(0, 3)) console.log(`  ${entry.dir} ${entry.text.slice(0, 150)}`)
if (sequence.length > 4) console.log('  ...')
for (const entry of sequence.slice(-2)) console.log(`  ${entry.dir} ${entry.text.slice(0, 150)}`)

// The contract: an inbound assignment followed by an outbound answer.
const firstIn = sequence.findIndex(entry => entry.dir === 'IN ')
const answered = firstIn !== -1 && sequence.slice(firstIn + 1).some(entry => entry.dir === 'OUT')
console.log(`round trip: ${firstIn === -1 ? 'NO inbound message' : answered ? 'IN -> OUT proven' : 'inbound found, no answer'}`)
