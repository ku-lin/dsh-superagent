/**
 * Report the identity fields of one Session log header.
 *
 * The header is the first event of the log and the only authority for "is this an ordinary conversation or something
 * a parent spawned": `origin`, `parentSession` and `delegationDepth` are what AC1 pins. Printed as JSON so a caller can
 * assert on fields instead of reading prose.
 *
 * Usage: node scripts/session-header.mjs <session-dir> [<session-dir>...]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The first frame of a Session log holds the header; later frames hold events. */
function headerOf(dir) {
  const file = readdirSync(dir).find(name => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
  if (file === undefined) return { dir, error: 'no session log' }
  const raw = readFileSync(join(dir, file))
  // Inflate frame by frame: a log is concatenated Zstd frames, and one `decompressSync` stops after the first.
  const starts = []
  for (let i = 0; i < raw.length - 4; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
  }
  for (let k = 0; k < Math.min(starts.length, 1); k++) {
    try {
      const text = zstdDecompressSync(raw.subarray(starts[k], starts[k + 1] ?? raw.length)).toString('utf8')
      const line = text.split('\n').find(entry => entry.trim().startsWith('{'))
      if (line === undefined) continue
      const parsed = JSON.parse(line)
      const out = { dir }
      for (const key of ['id', 'origin', 'parentSession', 'delegationDepth', 'agentPreset', 'cwd', 'createdAt']) {
        // Absent is reported as null rather than omitted, so "no parent" is an assertable fact.
        out[key] = parsed[key] ?? null
      }
      return out
    } catch { /* fall through to the error below */ }
  }
  return { dir, error: 'header not decoded' }
}

for (const dir of process.argv.slice(2)) console.log(JSON.stringify(headerOf(dir)))
