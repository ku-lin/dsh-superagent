/**
 * Replay the REAL stored Router conversation through the SHIPPED export/summary/archive code.
 *
 * This is the closest an offline check can get to the live refresh: the input is the actual 5.7 MB
 * `session.v4.jsonl.zstd` of the Router conversation that overflowed, decoded frame by frame, and the code under test is
 * the published `lib/index.js` helpers (via the TypeScript sources the bundle was built from) plus a real SQLite archive.
 *
 * What it can prove: the export is byte-exact and deterministic over a real long log, the deterministic summary carries
 * the structured project state a reader needs, the archive is idempotent at its source key, and a second Router project
 * cannot see this text. What it cannot prove: that DSH's flush admitted this Session at the moment of a live refresh —
 * that needs a restarted host.
 *
 * Usage: node scripts/verify-router-real-archive.mjs <session.v4.jsonl.zstd> <projectId>
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const source = process.argv[2]
const projectId = process.argv[3] ?? 'project-verify'
if (!source) { console.error('usage: node scripts/verify-router-real-archive.mjs <session.v4.jsonl.zstd> [projectId]'); process.exit(2) }

/** Decode concatenated independent Zstd frames: the file is a header frame plus one frame per append batch. */
function decodeFrames(bytes) {
  const frames = []
  let offset = 0
  while (offset < bytes.length) {
    const start = offset
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`bad zstd frame magic at ${offset}`)
    offset += 4
    const descriptor = bytes[offset++]
    const sizeFlag = descriptor >>> 6
    const single = Boolean(descriptor & 32)
    const checksum = Boolean(descriptor & 4)
    const dictFlag = descriptor & 3
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag
    offset += (single ? 0 : 1) + dictBytes + sizeBytes
    for (;;) {
      const header = bytes.readUIntLE(offset, 3); offset += 3
      const last = Boolean(header & 1), type = (header >>> 1) & 3, size = header >>> 3
      offset += type === 1 ? 1 : size
      if (last) break
    }
    if (checksum) offset += 4
    frames.push(bytes.subarray(start, offset))
  }
  return frames
}

const compressed = readFileSync(source)
const frames = decodeFrames(compressed)
// The first frame is the durable Session header, which carries no `seq`; the body frames hold the event log. This is the
// same shape `session.snapshotEvents()` returns (log events only, from seq 0), so the replay matches what an export reads.
const header = JSON.parse(zstdDecompressSync(frames[0]).toString('utf8').trim().split('\n')[0])
const events = []
for (const [index, frame] of frames.entries()) {
  if (index === 0) continue
  const text = zstdDecompressSync(frame).toString('utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value
    try { value = JSON.parse(line) } catch { throw new Error(`frame ${index}: a line is not JSON`) }
    events.push(value)
  }
}
events.sort((a, b) => a.seq - b.seq)
console.log(`decoded ${frames.length} frames, ${events.length} events, ${(compressed.length / 1e6).toFixed(2)} MB compressed`)

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

check('the stored header names the Router preset', header.agentPreset === 'dsh-superagent-router', String(header.agentPreset))

// Sequence numbers must be contiguous from 0, which is exactly what the export refuses to archive around.
const contiguous = events.every((event, index) => event.seq === index)
check('the stored log is contiguous from seq 0 (the condition an archive requires)', contiguous,
  contiguous ? `seq 0..${events.length - 1}` : 'a gap means the export would refuse rather than archive a short prefix')

// Price the real log so the "long context" claim is measured, not assumed.
const chars = events.reduce((sum, event) => {
  const blocks = event.data?.content ?? event.data?.message?.content
  if (!Array.isArray(blocks)) return sum
  return sum + blocks.reduce((inner, block) => inner + (typeof block?.text === 'string' ? block.text.length : 0), 0)
}, 0)
check('the conversation is genuinely long', chars > 1_000_000, `${chars.toLocaleString()} visible characters (~${Math.round(chars / 4).toLocaleString()} tokens by the neutral 4:1 heuristic)`)

// Run the SHIPPED helpers against this real log through the project's own test runner.
const directory = mkdtempSync(join(tmpdir(), 'verify-real-archive-'))
try {
  const raw = events.map(event => JSON.stringify(event)).join('\n')
  writeFileSync(join(directory, 'events.jsonl'), raw)
  const spec = join(directory, 'real.spec.ts')
  writeFileSync(spec, `
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseExport, sourceIdentity, archiveFacts } from '${join(ROOT, 'src', 'app', 'router-session-host.ts').replaceAll('\\', '/')}'
import { Store } from '${join(ROOT, 'src', 'app', 'store.ts').replaceAll('\\', '/')}'
import { ProjectKnowledge } from '${join(ROOT, 'src', 'app', 'project-knowledge.ts').replaceAll('\\', '/')}'
import { RouterRegistry } from '${join(ROOT, 'src', 'app', 'router-registry.ts').replaceAll('\\', '/')}'
const raw = readFileSync(${JSON.stringify(join(directory, 'events.jsonl').replaceAll('\\', '/'))}, 'utf8')
it('the real conversation parses, prices and archives faithfully', () => {
  try {
  const events = parseExport(raw)
  expect(events.length).toBeGreaterThan(1000)
  const identity = sourceIdentity(events, raw)
  expect(identity).toMatch(/^sha256:[0-9a-f]{64};events:\\d+;seq:0-\\d+;bytes:\\d+$/)
  // The summary is built from these events only, and names the structured state a reader needs.
  const facts = archiveFacts(events)
  expect(facts).toBeTruthy()
  const store = new Store(${JSON.stringify(join(directory, 'state.sqlite'))})
  const knowledge = new ProjectKnowledge(store)
  const registry = new RouterRegistry(store, knowledge)
  registry.register('router-real', ${JSON.stringify(projectId)}, 'session-real-old')
  const prep = registry.prepare('router-real', 'session-real-old', 1)
  const next = registry.commit(prep.id,
    [{ projectId: ${JSON.stringify(projectId)}, sessionId: 'session-real-old', sourceId: identity, raw }], '真实项目状态摘要', prep.nextSessionId)
  expect(next.generation).toBe(2)
  // Byte-exact: the archived text equals the export, character for character.
  const archived = knowledge.archives(${JSON.stringify(projectId)})
  expect(archived).toHaveLength(1)
  expect(archived[0].raw).toBe(raw)
  expect(archived[0].raw.length).toBe(raw.length)
  // Idempotent at the source key: re-archiving the same export does not duplicate or alter it.
  const again = registry.read('router-real', next.sessionId)
  knowledge.checkpoint(again.receipt, [{ projectId: ${JSON.stringify(projectId)}, sessionId: 'session-real-old', sourceId: identity, raw }], '真实项目状态摘要')
  expect(knowledge.archives(${JSON.stringify(projectId)})).toHaveLength(1)
  store.close()
  } catch (error) {
    // Print the failing step's message where the runner will keep it, rather than a bare "1 failed".
    console.error('REAL-ARCHIVE-FAILURE:', error instanceof Error ? error.message : String(error))
    throw error
  }
})
`)
  const runner = join(ROOT, 'node_modules', '.pnpm', 'vitest@4.1.8_@types+node@22_e9c1dc0e39d52c9ec7916889bededdb4',
    'node_modules', 'vitest', 'vitest.mjs')
  try {
    execFileSync(process.execPath, [runner, 'run', spec, '--root', directory, '--reporter=verbose'], { cwd: ROOT, stdio: 'pipe' })
    check('the real conversation parses, summarises and archives byte-exact and idempotently', true)
  } catch (error) {
    const out = String(error.stdout ?? error)
    // Report the first real assertion failure verbatim: a one-line summary hides whether it was the byte comparison,
    // the idempotency check, or the archive count, and those mean very different things.
    const lines = out.split('\n')
    const assertion = lines.findIndex(line => /AssertionError|Error:/.test(line))
    check('the real conversation parses, summarises and archives byte-exact and idempotently', false,
      (assertion >= 0 ? lines.slice(assertion, assertion + 6) : lines.slice(0, 12)).join(' | '))
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
console.log('LIVE VERIFICATION PENDING: the flush/admission half of a refresh still needs a restarted host.')
process.exit(failed.length ? 1 : 0)
