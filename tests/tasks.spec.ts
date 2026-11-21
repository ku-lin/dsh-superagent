/**
 * `GET tasks`: the read-only Taskboard projection behind the Router's task list.
 *
 * The fixture is a real SQLite file built here with the three columns the reader selects, so the reader's
 * own SQL is exercised rather than mocked. Nothing is written back: the reader opens `readOnly`.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TASKS_PER_PROJECT, TaskboardReader, taskboardDatabase } from '../src/app/tasks.ts'
import { TASK_STATUSES, taskPriority, taskStatus } from '../src/app/task-status.ts'

let dir = ''
const database = (): string => join(dir, 'taskboard.sqlite')
const at = (ms: number) => new Date(ms).toISOString()

/** The two tables the reader reads, with the columns the Taskboard plugin writes for them. */
function seed(rows: { key: string; name: string; tasks: { identifier: string; title: string; status: string; priority?: string
  updated?: number; archived?: number | null }[] }[]): void {
  const db = new DatabaseSync(database())
  try {
    // Re-seeding replaces the board, so a test can watch a change on disk between two reads.
    db.exec('drop table if exists tasks; drop table if exists projects;')
    db.exec(`create table projects (id text primary key, key text not null unique, name text not null);
      create table tasks (id text primary key, project_id text not null, identifier text not null unique, title text not null,
        status text not null, priority text not null, archived_at integer, updated_at integer not null)`)
    const project = db.prepare('insert into projects (id, key, name) values (?, ?, ?)')
    const task = db.prepare(`insert into tasks (id, project_id, identifier, title, status, priority, archived_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const [index, item] of rows.entries()) {
      const id = `project-${index}`
      project.run(id, item.key, item.name)
      for (const [order, entry] of item.tasks.entries()) {
        task.run(`${id}-t${order}`, id, entry.identifier, entry.title, entry.status, entry.priority ?? 'none',
          entry.archived ?? null, entry.updated ?? 1000 + order)
      }
    }
  } finally { db.close() }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-superagent-tasks-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('lists every project with its tasks, newest first, as the panel reads them', () => {
  seed([
    { key: 'ARK', name: 'ark', tasks: [
      { identifier: 'ARK-1', title: 'old', status: 'done', priority: 'low', updated: 100 },
      { identifier: 'ARK-2', title: 'new', status: 'in_progress', priority: 'high', updated: 900 },
    ] },
    { key: 'EMPTY', name: 'empty project', tasks: [] },
  ])
  const view = new TaskboardReader(database, 0, () => 5_000).read()
  expect(view.available).toBe(true)
  expect(view.projects.map(project => project.key)).toEqual(['ARK', 'EMPTY'])
  expect(view.projects[0]!.tasks).toEqual([
    { identifier: 'ARK-2', title: 'new', status: 'in_progress', priority: 'high', updatedAt: at(900) },
    { identifier: 'ARK-1', title: 'old', status: 'done', priority: 'low', updatedAt: at(100) },
  ])
  // A project without tasks still lists, so an empty board reads as empty rather than as missing.
  expect(view.projects[1]!.tasks).toEqual([])
})

it('filters to one project by its key, ignoring case, and answers nothing for an unknown key', () => {
  seed([{ key: 'KALIFOR', name: 'kali', tasks: [{ identifier: 'KALIFOR-1', title: 'one', status: 'todo' }] },
    { key: 'CTFA', name: 'ctf', tasks: [{ identifier: 'CTFA-1', title: 'two', status: 'done' }] }])
  const reader = new TaskboardReader(database, 0, () => 5_000)
  expect(reader.read('kalifor').projects.map(project => project.key)).toEqual(['KALIFOR'])
  expect(reader.read('CTFA').projects[0]!.tasks.map(task => task.identifier)).toEqual(['CTFA-1'])
  expect(reader.read('nope')).toMatchObject({ available: true, projects: [] })
  // An empty filter is the unfiltered list, not a project named ''.
  expect(reader.read('').projects).toHaveLength(2)
})

it('leaves out archived tasks and caps one project at the row budget', () => {
  seed([{ key: 'BIG', name: 'big', tasks: [
    { identifier: 'BIG-archived', title: 'gone', status: 'todo', archived: 1 },
    ...Array.from({ length: TASKS_PER_PROJECT + 5 }, (_unused, index) => ({ identifier: `BIG-${index}`, title: `t${index}`,
      status: 'todo', updated: index })),
  ] }])
  const tasks = new TaskboardReader(database, 0, () => 0).read().projects[0]!.tasks
  expect(tasks).toHaveLength(TASKS_PER_PROJECT)
  expect(tasks.some(task => task.identifier === 'BIG-archived')).toBe(false)
})

it('words an unknown status or priority as the board\'s own fallback instead of failing the read', () => {
  expect(TASK_STATUSES.every(status => taskStatus(status) === status)).toBe(true)
  expect(taskStatus('done-ish')).toBe('backlog')
  expect(taskPriority('blocker')).toBe('none')
  seed([{ key: 'ODD', name: 'odd', tasks: [{ identifier: 'ODD-1', title: 'odd', status: 'done-ish', priority: 'blocker' }] }])
  expect(new TaskboardReader(database, 0, () => 0).read().projects[0]!.tasks[0]).toMatchObject({ status: 'backlog',
    priority: 'none' })
})

it('degrades to a sentence, never to an error, when the board is not there', () => {
  // A board the Taskboard plugin has not created yet is the ordinary case, not a failure.
  expect(new TaskboardReader(database, 0, () => 0).read()).toMatchObject({ available: false, projects: [] })
  expect(new TaskboardReader(database, 0, () => 0).read().detail).toContain('taskboard.sqlite')
})

it('caches one answer for the cache window and rereads after it', () => {
  seed([{ key: 'ARK', name: 'ark', tasks: [{ identifier: 'ARK-1', title: 'one', status: 'todo' }] }])
  let clock = 1_000
  const reader = new TaskboardReader(database, 5_000, () => clock)
  const first = reader.read()
  // A second call inside the window answers the cached object even though the file changed on disk.
  seed([{ key: 'ARK', name: 'ark', tasks: [{ identifier: 'ARK-2', title: 'two', status: 'done' }] }])
  expect(reader.read()).toBe(first)
  clock += 5_000
  expect(reader.read().projects[0]!.tasks.map(task => task.identifier)).toEqual(['ARK-2'])
})

it('resolves the store from the mounted service, then $DSH_HOME, then the home directory', () => {
  // The mounted service is authoritative: its own configuration decides where the board lives.
  expect(taskboardDatabase({ service: { config: { databasePath: 'D:/board/board.sqlite' } } })).toBe('D:/board/board.sqlite')
  // An in-memory board is not a file the panel could read, so the default location is used instead.
  expect(taskboardDatabase({ service: { config: { databasePath: ':memory:' } }, env: {}, home: '/home/op' }))
    .toBe(join('/home/op', '.dsh', 'taskboard.sqlite'))
  expect(taskboardDatabase({ env: { DSH_HOME: 'S:/share/dsh_work_place/bypass-home' }, home: '/home/op' }))
    .toBe(join('S:/share/dsh_work_place/bypass-home', 'taskboard.sqlite'))
  // A blank DSH_HOME is the same as none at all.
  expect(taskboardDatabase({ env: { DSH_HOME: '  ' }, home: '/home/op' })).toBe(join('/home/op', '.dsh', 'taskboard.sqlite'))
})

it('serves the same view through the management route, and only with the panel\'s request header', async () => {
  seed([{ key: 'SUPERAGENT', name: 'superagent', tasks: [{ identifier: 'SUPERAGENT-1', title: 'ship', status: 'todo' }] }])
  const reader = new TaskboardReader(database, 0, () => 0)
  const { registerHttp } = await import('../src/app/http.ts')
  // The prefix handler of the management API, not the panel's live channel that shares the prefix.
  let handler = async (_req: unknown, _res: unknown): Promise<void> => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3082,
    register: (route: { path: string; handler: typeof handler }) => {
      if (route.path === '/orchestrator') handler = route.handler
      return () => {}
    } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), tasks: reader,
    // The panel's live channel is another route on the same prefix; this test only reads the list.
    stream: { attach: () => {} } } as never)
  const call = async (path: string, headers: Record<string, string> = { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }) => {
    let status = 0, text = ''
    const req = { method: 'GET', url: `/orchestrator/api/${path}`, headers, async *[Symbol.asyncIterator]() { /* no body */ } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    // A refused request answers with a status and no body, like every other management route does.
    return { status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
  }
  expect(await call('tasks')).toMatchObject({ status: 200, body: { available: true, projects: [{ key: 'SUPERAGENT' }] } })
  expect(await call('tasks?project=SUPERAGENT')).toMatchObject({ status: 200, body: { projects: [{ key: 'SUPERAGENT' }] } })
  expect(await call('tasks?project=NOPE')).toMatchObject({ status: 200, body: { projects: [] } })
  // Without the fence header the route refuses the request, as every management route does.
  expect(await call('tasks', { host: '127.0.0.1:3082' })).toMatchObject({ status: 403 })
})
