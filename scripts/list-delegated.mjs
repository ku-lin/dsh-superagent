/**
 * Inventory the leftover delegated Sessions, without deleting anything.
 *
 * The cleanup entry in the panel lists these one by one; this reports the same set from the durable logs so a person can
 * decide before any of them is removed. Nothing here writes, archives or deletes: it reads each Session header and
 * groups by parent, so "who spawned these, and how much is there" is answerable at a glance.
 *
 * Usage: node scripts/list-delegated.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'sessions'))
if (root === undefined) throw Error('Pass the sessions directory, or set DSH_HOME to the deployment that holds it.')

/** Read only the first frame: a Session log's header is its first event. */
function headerOf(dir) {
  let names
  try { names = readdirSync(dir) } catch { return undefined }
  const file = names.find(name => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
  if (file === undefined) return undefined
  const path = join(dir, file)
  const raw = readFileSync(path)
  const starts = []
  for (let i = 0; i < raw.length - 4; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
  }
  if (starts.length === 0) return undefined
  try {
    const text = zstdDecompressSync(raw.subarray(starts[0], starts[1] ?? raw.length)).toString('utf8')
    const line = text.split('\n').find(entry => entry.trim().startsWith('{'))
    if (line === undefined) return undefined
    const header = JSON.parse(line)
    return { ...header, bytes: statSync(path).size }
  } catch { return undefined }
}

const delegated = []
for (const bucket of readdirSync(root)) {
  const bucketDir = join(root, bucket)
  let entries
  try { entries = readdirSync(bucketDir, { withFileTypes: true }) } catch { continue }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(bucketDir, entry.name)
    const header = headerOf(dir)
    if (header?.origin !== 'subagent') continue
    delegated.push({ id: String(header.id ?? entry.name), parent: header.parentSession ?? null,
      depth: header.delegationDepth ?? null, bytes: header.bytes, createdAt: header.createdAt ?? 0 })
  }
}

delegated.sort((left, right) => right.createdAt - left.createdAt)
const byParent = new Map()
for (const item of delegated) byParent.set(item.parent ?? '(none)', (byParent.get(item.parent ?? '(none)') ?? 0) + 1)

console.log(`origin=subagent Sessions: ${delegated.length}`)
console.log('by parent Session:')
for (const [parent, count] of [...byParent].sort((left, right) => right[1] - left[1])) console.log(`  ${parent}: ${count}`)
const totalBytes = delegated.reduce((sum, item) => sum + item.bytes, 0)
console.log(`total on disk: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`)
console.log('newest 15 (id, parent, size KiB, created):')
for (const item of delegated.slice(0, 15)) {
  const when = item.createdAt ? new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?'
  console.log(`  ${item.id}  parent=${(item.parent ?? '-').slice(0, 20)}  ${Math.round(item.bytes / 1024)}K  ${when}`)
}
console.log('\nNothing was deleted. Removing one requires its own confirmation (DELETE sessions/:id?confirm=true).')
