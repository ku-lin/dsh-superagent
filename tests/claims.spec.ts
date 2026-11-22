/**
 * Claims only earn their keep if a collision is refused *before* the write, so most of these cases are
 * about the refusal being right rather than about the happy path.
 *
 * The two "soft" boundaries are asserted too: a sibling directory that merely shares a prefix must
 * not be treated as claimed, and a claim on a parent directory must cover its children. Getting either
 * backwards turns the mechanism into a false-positive machine or a no-op.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONFLICT_HINT,
  claimHit,
  conflictsWith,
  denyText,
  displayPath,
  fsConflict,
  normalizeClaims,
  overlaps,
  under,
  type Claim,
} from '../src/core/claims.ts'

const root = path.resolve('/project')
const state = path.join(root, '.dsh-superagent')

const claim = (task: string, owner: string, paths: string[]): Claim => ({
  task,
  owner,
  paths: paths.map(p => path.resolve(root, p)),
  at: '2026-11-23T00:00:00+08:00',
})

describe('under', () => {
  it('accepts the directory itself and its children', () => {
    expect(under(path.join(root, 'src'), path.join(root, 'src'))).toBe(true)
    expect(under(path.join(root, 'src/a.ts'), path.join(root, 'src'))).toBe(true)
  })

  it('rejects a sibling that shares a prefix', () => {
    // The bug this guards: a string prefix check would call `src-old` inside `src`.
    expect(under(path.join(root, 'src-old/a.ts'), path.join(root, 'src'))).toBe(false)
  })

  it('rejects a parent', () => {
    expect(under(root, path.join(root, 'src'))).toBe(false)
  })
})

describe('overlaps', () => {
  it('is symmetric and treats a parent/child pair as overlapping', () => {
    expect(overlaps(path.join(root, 'src'), path.join(root, 'src/a.ts'))).toBe(true)
    expect(overlaps(path.join(root, 'src/a.ts'), path.join(root, 'src'))).toBe(true)
  })

  it('keeps two files in the same directory disjoint', () => {
    expect(overlaps(path.join(root, 'src/a.ts'), path.join(root, 'src/b.ts'))).toBe(false)
  })
})

describe('normalizeClaims', () => {
  it('resolves relative paths against the root and deduplicates', () => {
    expect(normalizeClaims(['src/', 'src', 'src/a.ts'], root, state)).toEqual([
      path.join(root, 'src'),
      path.join(root, 'src/a.ts'),
    ])
  })

  it('accepts a delimited string as well as a list', () => {
    expect(normalizeClaims('src, docs/a.md', root, state)).toHaveLength(2)
  })

  it('refuses the whole project root', () => {
    // Claiming everything would block every other worker, which is the same as having no claims.
    expect(() => normalizeClaims(['.'], root, state)).toThrow(/whole project root/)
    expect(() => normalizeClaims([root], root, state)).toThrow(/whole project root/)
  })

  it('refuses a path outside the root', () => {
    expect(() => normalizeClaims(['../elsewhere'], root, state)).toThrow(/inside the project root/)
  })

  it('refuses the state directory but allows its out/ directory', () => {
    expect(() => normalizeClaims(['.dsh-superagent'], root, state)).toThrow(/plugin's own state/)
    expect(normalizeClaims(['.dsh-superagent/out'], root, state)).toEqual([path.join(state, 'out')])
  })

  it('refuses more than twenty paths, and nothing for an absent argument', () => {
    const many = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`)
    expect(() => normalizeClaims(many, root, state)).toThrow(/at most 20/)
    expect(normalizeClaims(undefined, root, state)).toEqual([])
    expect(normalizeClaims(null, root, state)).toEqual([])
  })

  it('refuses a non-path entry instead of coercing it', () => {
    expect(() => normalizeClaims([42], root, state)).toThrow(/path string/)
    expect(() => normalizeClaims({ a: 1 }, root, state)).toThrow(/must be a list/)
  })
})

describe('conflictsWith', () => {
  const active = [claim('T-1', 'worker-1', ['src/panel'])]

  it('reports an overlap with another owner', () => {
    const found = conflictsWith([path.join(root, 'src/panel/x.ts')], 'worker-2', 'T-2', active)
    expect(found).toHaveLength(1)
    expect(found[0]?.claim.task).toBe('T-1')
  })

  it('never conflicts with itself: same owner, or same task', () => {
    const target = [path.join(root, 'src/panel/x.ts')]
    expect(conflictsWith(target, 'worker-1', 'T-2', active)).toHaveLength(0)
    expect(conflictsWith(target, 'worker-2', 'T-1', active)).toHaveLength(0)
  })

  it('ignores a disjoint path', () => {
    expect(conflictsWith([path.join(root, 'docs/a.md')], 'worker-2', 'T-2', active)).toHaveLength(0)
  })
})

describe('claimHit', () => {
  const active = [claim('T-1', 'worker-1', ['src/panel', 'docs/a.md'])]

  it('finds the covering claim for a file being written', () => {
    const hit = claimHit(path.join(root, 'src/panel/x.ts'), 'worker-2', active)
    expect(hit?.claim.task).toBe('T-1')
    expect(hit?.path).toBe(path.join(root, 'src/panel'))
  })

  it('does not stop a worker writing inside its own claim', () => {
    expect(claimHit(path.join(root, 'src/panel/x.ts'), 'worker-1', active)).toBeUndefined()
  })

  it('returns nothing for an unclaimed file', () => {
    expect(claimHit(path.join(root, 'README.md'), 'worker-2', active)).toBeUndefined()
  })
})

describe('denyText', () => {
  it('names the ticket, the owner and the covered path, and closes the shell loophole', () => {
    const hit = { claim: claim('T-1', 'worker-1', ['src/panel']), path: path.join(root, 'src/panel') }
    const text = denyText(path.join(root, 'src/panel/x.ts'), hit, root)
    expect(text).toContain('src/panel/x.ts')
    expect(text).toContain('T-1')
    expect(text).toContain('worker-1')
    expect(text).toMatch(/do not route around this with bash/)
    expect(text).toMatch(/Report that you are blocked/)
  })
})

describe('displayPath', () => {
  it('shortens a path inside the root and leaves an outside path alone', () => {
    // Always `/`, never `\`: a Windows separator inside prose reads as an escape to whatever parses
    // the message next, and an agent re-typing the path should not have to guess.
    expect(displayPath(root, path.join(root, 'src/a.ts'))).toBe('src/a.ts')
    const outside = path.resolve('/other/a.ts')
    expect(displayPath(root, outside)).toBe(outside.replace(/\\/g, '/'))
  })
})

describe('fsConflict', () => {
  it('separates a lost race from a missing read', () => {
    // They need different advice: retrying a stale write clobbers the other edit.
    expect(fsConflict('Error: FS_STALE_VERSION: file changed since it was read')).toBe('stale')
    expect(fsConflict('FS_NOT_OBSERVED: read the file first')).toBe('unread')
    expect(fsConflict('something unrelated')).toBeUndefined()
  })

  it('gives each kind its own hint', () => {
    expect(CONFLICT_HINT.stale).toMatch(/changed after you read it/)
    expect(CONFLICT_HINT.unread).toMatch(/requires a read before a write/)
    expect(CONFLICT_HINT.stale).not.toBe(CONFLICT_HINT.unread)
  })
})
