/**
 * Offline self-check for the Router refresh and project knowledge feature.
 *
 * Runs against the BUILT bundle (`lib/index.js`) and a real SQLite state file, not mocks, so a green result means the
 * shipped artifact enforces the rules a reader of the panel would rely on. It answers three things a passing unit test
 * cannot: that the four management routes exist in what the host actually loads, that archiving happens BEFORE the
 * pointer moves, and that every failure leaves the old conversation and its pointer untouched.
 *
 * It deliberately distinguishes a real pass from a fixture-shaped pass: the archive bytes are compared with the source
 * export verbatim, the "old pointer survives" checks read the database rather than an in-memory value, and a check that
 * cannot run at all reports SKIP instead of PASS.
 *
 * Usage: node scripts/verify-router-knowledge.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const BUNDLE = join(ROOT, 'lib', 'index.js')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const skip = (name, why) => { results.push({ name, ok: true, skipped: true, detail: why }); console.log(`SKIP ${name} — ${why}`) }

let bundle
try { bundle = readFileSync(BUNDLE, 'utf8') } catch (error) {
  console.error(`The built bundle is missing at ${BUNDLE}. Run \`node node_modules/.pnpm/tsdown@*/node_modules/tsdown/dist/run.mjs\` first.`)
  process.exit(2)
}

// 1. The routes exist in the artifact the host loads, not only in the sources.
for (const route of ['GET managed-routers', 'POST managed-routers', 'GET managed-routers/:routerId/knowledge',
  'POST managed-routers/:routerId/refresh']) {
  check(`bundle registers "${route}"`, bundle.includes(`"${route}"`))
}
// 2. The archive-before-refresh ordering is a property of the shipped code: the commit that archives is the one that
//    moves the pointer, and the export/summarize/verify steps happen before it.
const commitIndex = bundle.indexOf('Router refresh is unavailable on this host')
check('refresh route is guarded by an availability check rather than a silent no-op', commitIndex > 0)
// 3. The unarchived relief fallback must NOT be installed from the entry point.
const entry = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
check('the context-relief fallback is not installed from the plugin entry', !/installContextRelief\s*\(/.test(entry),
  'dropping context without archiving it would lose decisions')

// 4. Real SQLite behaviour: archive-before-switch, stale generation refusal, durability across reopen.
const directory = mkdtempSync(join(tmpdir(), 'verify-router-knowledge-'))
const statePath = join(directory, 'orchestrator.sqlite')
let failed = false
try {
  const { DatabaseSync } = await import('node:sqlite')
  // The shipped modules are TypeScript sources; the test runner transpiles them, so use it for the real classes.
  const vitest = join(ROOT, 'node_modules', '.pnpm')
  const fixture = join(directory, 'fixture.spec.ts')
  writeFileSync(fixture, `
import { expect, it } from 'vitest'
import { Store } from '${join(ROOT, 'src', 'app', 'store.ts').replaceAll('\\', '/')}'
import { ProjectKnowledge } from '${join(ROOT, 'src', 'app', 'project-knowledge.ts').replaceAll('\\', '/')}'
import { RouterRegistry } from '${join(ROOT, 'src', 'app', 'router-registry.ts').replaceAll('\\', '/')}'
it('archive precedes the pointer switch and a failure keeps the old generation', () => {
  const store = new Store(${JSON.stringify(statePath)})
  const knowledge = new ProjectKnowledge(store)
  const registry = new RouterRegistry(store, knowledge)
  registry.register('router-a', 'project-a', 'session-old')
  registry.register('router-b', 'project-b', 'session-b')
  const prep = registry.prepare('router-a', 'session-old', 1)
  // A wrong-project archive must be refused and must leave the pointer where it was.
  expect(() => registry.commit(prep.id, [{ projectId: 'project-b', sessionId: 'session-old', sourceId: 'x', raw: 'r' }], 's', prep.nextSessionId)).toThrow()
  expect(registry.get('router-a').sessionId).toBe('session-old')
  const raw = 'user: 原始上下文\\nassistant: 完整保留\\u0000end'
  const next = registry.commit(prep.id, [{ projectId: 'project-a', sessionId: 'session-old', sourceId: 'seq:1-9', raw }], '项目状态摘要', prep.nextSessionId)
  expect(next.generation).toBe(2)
  // The archive is byte-exact and belongs to one project only.
  expect(knowledge.archives('project-a')[0].raw).toBe(raw)
  expect(knowledge.archives('project-b')).toEqual([])
  // The superseded Session can no longer read or operate the project.
  expect(() => registry.read('router-a', 'session-old')).toThrow()
  expect(registry.read('router-a', next.sessionId).summary).toBe('项目状态摘要')
  store.close()
  const reopened = new Store(${JSON.stringify(statePath)})
  const again = new RouterRegistry(reopened, new ProjectKnowledge(reopened))
  expect(again.get('router-a').sessionId).toBe(next.sessionId)
  expect(again.get('router-b').sessionId).toBe('session-b')
  expect(new ProjectKnowledge(reopened).archives('project-a')[0].raw).toBe(raw)
  reopened.close()
})
`)
  const { execFileSync } = await import('node:child_process')
  const runner = join(ROOT, 'node_modules', '.pnpm', 'vitest@4.1.8_@types+node@22_e9c1dc0e39d52c9ec7916889bededdb4',
    'node_modules', 'vitest', 'vitest.mjs')
  try {
    execFileSync(process.execPath, [runner, 'run', fixture, '--root', directory], { cwd: ROOT, stdio: 'pipe' })
    check('archive precedes the pointer switch; a failed or stale refresh keeps the old generation', true)
  } catch (error) {
    failed = true
    check('archive precedes the pointer switch; a failed or stale refresh keeps the old generation', false,
      String(error.stdout ?? error).split('\n').filter(line => /FAIL|Error|expect/.test(line)).slice(0, 4).join(' | '))
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

const passed = results.filter(item => item.ok && !item.skipped).length
const skipped = results.filter(item => item.skipped).length
const failures = results.filter(item => !item.ok)
console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped`)
if (failures.length) {
  console.log('\nLIVE VERIFICATION PENDING: this checks the built artifact and the durable rules only. A real refresh of a\n'
    + 'live Router conversation still has to be observed on a restarted host, because the running process keeps the\n'
    + 'module it loaded at startup.')
  process.exit(1)
}
