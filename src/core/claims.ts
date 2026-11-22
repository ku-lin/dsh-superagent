/**
 * File claims: what a ticket says it will write, so two workers cannot quietly edit the same file.
 *
 * Borrowed from dsh-master's `claims.ts` (MIT, ZhuFrank/dsh-master-plugin). The idea there is worth
 * copying exactly: a ticket declares the files and directories it intends to touch when it is
 * dispatched, and a member writing into another live ticket's claim is stopped and told whose claim it
 * hit. The claim expires on its own when the ticket finishes or its worker closes — a claim is a
 * statement about work in flight, not a permission grant.
 *
 * Deliberately "soft", same as upstream: a worker that writes from inside `python -c` or a shell
 * script is not caught here. This narrows the common collision; it does not enforce isolation. Saying
 * otherwise would be a promise the mechanism cannot keep.
 *
 * Why this matters here specifically: tickets carry a `scope` string today, but it is a label, not a
 * path set. Nothing stops two workers editing the same file, and the failure surfaces much later as a
 * clobbered edit rather than as a refusal at write time.
 */
import path from 'node:path'

/** One ticket's live claim: the paths it may write, and who is holding it. */
export interface Claim {
  readonly task: string
  readonly owner: string
  readonly paths: readonly string[]
  readonly at: string
  readonly reason?: string | undefined
}

/** True when `file` is `dir` or sits underneath it. Both must already be absolute. */
export function under(file: string, dir: string): boolean {
  const rel = path.relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Two claims overlap when they name the same path, or one contains the other. */
export function overlaps(a: string, b: string): boolean {
  return under(a, b) || under(b, a)
}

/**
 * Turn a dispatch argument into absolute claim paths.
 *
 * A relative path resolves against the project root. The whole root is refused: claiming it would
 * block every other worker, which is the same as having no claims at all. The state directory is
 * refused too, except the products directory inside it, which is where work is meant to land.
 */
export function normalizeClaims(
  raw: unknown,
  root: string,
  stateDir: string,
): string[] {
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，、\n]/)
      : null
  if (!list) throw new Error('claims must be a list of paths, e.g. ["src/panel/", "docs/a.md"]')

  // Both the root and the state directory are normalised before any comparison. Skipping this made
  // the "whole root" check fail against real hosts, where the root arrives as `S:/proj` and
  // `path.resolve` returns `S:\proj`: two spellings of the same directory compare unequal, so
  // `claims: ["."]` was accepted and would have blocked every other worker. It passed in tests only
  // because those used an already-canonical path.
  const normalizedRoot = path.resolve(root)
  const normalizedState = path.resolve(stateDir)

  const out: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') throw new Error('every claim must be a path string')
    const trimmed = entry.trim()
    if (!trimmed) continue
    const absolute = path.resolve(normalizedRoot, trimmed).replace(/[/\\]+$/, '')
    if (!under(absolute, normalizedRoot)) {
      throw new Error(`a claim must stay inside the project root ${root}: ${trimmed}`)
    }
    if (absolute === normalizedRoot) {
      throw new Error('refusing to claim the whole project root — name a directory or file')
    }
    if (under(absolute, normalizedState) && !under(absolute, path.join(normalizedState, 'out'))) {
      throw new Error(`${stateDir} is the plugin's own state; only its out/ directory may be claimed`)
    }
    if (!out.includes(absolute)) out.push(absolute)
  }
  if (out.length > 20) throw new Error('at most 20 claimed paths at a time — claim a parent directory instead')
  return out
}

/**
 * Live claims held by other tickets that the new claim would collide with.
 *
 * A ticket never conflicts with itself, and one worker's own several claims never conflict with each
 * other: both are the same worker asking twice, not two workers racing.
 */
export function conflictsWith(
  paths: readonly string[],
  owner: string,
  task: string,
  active: readonly Claim[],
): Array<{ path: string; claim: Claim; other: string }> {
  const found: Array<{ path: string; claim: Claim; other: string }> = []
  for (const claim of active) {
    if (claim.owner === owner || claim.task === task) continue
    for (const wanted of paths) {
      for (const held of claim.paths) {
        if (overlaps(wanted, held)) found.push({ path: wanted, claim, other: held })
      }
    }
  }
  return found
}

/** The live claim covering a file this caller is about to write, if it belongs to someone else. */
export function claimHit(
  target: string,
  caller: string,
  active: readonly Claim[],
): { claim: Claim; path: string } | undefined {
  for (const claim of active) {
    if (claim.owner === caller) continue
    const held = claim.paths.find(candidate => under(target, candidate))
    if (held) return { claim, path: held }
  }
  return undefined
}

/**
 * Path relative to the root when it is inside it, otherwise unchanged, for readable messages.
 *
 * Separators are normalised to `/` on the way out. The claim is compared with `path.relative`, which
 * yields `\` on Windows — correct for the filesystem, but a message mixing `src\panel` into prose
 * reads as an escape sequence to whoever (or whatever) parses it next, and an agent re-typing the
 * path from the message should not have to guess which separator this host wants.
 */
export function displayPath(root: string, target: string): string {
  const rel = path.relative(root, target)
  const shown = rel && !rel.startsWith('..') ? rel : target
  return shown.replace(/\\/g, '/')
}

/**
 * The refusal a worker sees.
 *
 * It names the ticket and the owner, and it closes the obvious loophole out loud: rewriting the same
 * edit through a shell does not make it allowed. Pointing at `report` is the part that makes this
 * usable — a worker that is merely blocked will retry; one that is told how to escalate will report.
 */
export function denyText(
  target: string,
  hit: { claim: Claim; path: string },
  root: string,
): string {
  return (
    `[claim] ${displayPath(root, target)} is inside ${hit.claim.task}'s claim ` +
    `(held by ${hit.claim.owner}, covering ${displayPath(root, hit.path)}). ` +
    `Do not edit it, and do not route around this with bash or a script. ` +
    `Report that you are blocked and say which file you need and why; the Router will coordinate.`
  )
}

/** Host file-tool conflicts, recognised so the claim hint can be attached instead of a bare error. */
export function fsConflict(text: string): 'stale' | 'unread' | undefined {
  if (/FS_STALE_VERSION|changed since it was read|file no longer exists/.test(text)) return 'stale'
  if (/FS_NOT_OBSERVED|without reading it first|requires reading/.test(text)) return 'unread'
  return undefined
}

/**
 * What to tell a worker whose write lost a race.
 *
 * `stale` and `unread` need different advice: a stale write is a real collision and retrying blindly
 * clobbers the other edit, while an unread write is usually the worker's own missing `read`.
 */
export const CONFLICT_HINT: Record<'stale' | 'unread', string> = {
  stale:
    '[claim] this file changed after you read it, likely by another worker. Your edit was not written. ' +
    'Re-read it, then apply your change to the new content. Do not overwrite it through bash — that ' +
    'discards the other edit. If the file belongs to another claim, report that you are blocked instead.',
  unread:
    '[claim] the host requires a read before a write: read this file first, then edit what you read. ' +
    'The file already exists, so someone may have just created it — confirm you are not replacing their work.',
}
