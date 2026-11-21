/**
 * Read-only projection of the local Taskboard database for the Router's task list (`GET tasks`).
 *
 * The panel polls this route; the database belongs to another plugin and this module never writes it.
 * Every connection is opened `readOnly` and closed within the same call, so a poll cannot hold a write
 * lock or repair a WAL: the board keeps serving whichever Host owns it.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { taskPriority, taskStatus, type TaskPriority, type TaskStatus } from './task-status.ts'

/** One row of the list: what a person needs to recognise a task, and its status. */
export interface TaskEntry {
  identifier: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  /** ISO timestamp of the task's last change. */
  updatedAt: string
}
export interface TaskProjectEntry { id: string; key: string; name: string; tasks: TaskEntry[] }
/**
 * The whole answer. `available: false` with a `detail` is the degraded case (no board, unreadable file,
 * a locked database): the panel shows the sentence instead of an error, and nothing throws.
 */
export interface TasksView { available: boolean; detail: string; at: string; projects: TaskProjectEntry[] }

/** Most tasks one project shows; a board with thousands of rows still answers within a poll. */
export const TASKS_PER_PROJECT = 200

/** What a mounted Taskboard service is read for: the store it resolved, which its own configuration decides. */
interface TaskboardServiceLike { config?: { databasePath?: unknown } }

/**
 * Where the Taskboard plugin keeps its store, in the order the answer can be trusted:
 *
 * 1. the store the mounted service actually resolved (`<service>.config.databasePath`) — this is the only
 *    answer that follows a profile which pins an absolute path instead of the default;
 * 2. `$DSH_HOME/taskboard.sqlite` — the plugin's own default for a Host started without that pin;
 * 3. `~/.dsh/taskboard.sqlite` — the same default with no `DSH_HOME` at all.
 *
 * The service is asked by duck-typing on `ctx.get`, so dsh-superagent keeps no dependency on the Taskboard
 * package and simply falls back when it is not mounted.
 */
export function taskboardDatabase(options: {
  service?: TaskboardServiceLike | undefined
  env?: Record<string, string | undefined>
  home?: string
} = {}): string {
  const configured = options.service?.config?.databasePath
  if (typeof configured === 'string' && configured && configured !== ':memory:') return configured
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const root = env['DSH_HOME']
  return join(root && root.trim() ? root : join(home, '.dsh'), 'taskboard.sqlite')
}

interface Joined { id: string; key: string; name: string; identifier: string | null; title: string | null; status: string | null
  priority: string | null; updated_at: number | null }

/**
 * Reads the Taskboard store through one short-lived read-only connection per refresh.
 * `database` is read per call so a moved store is picked up without restarting dsh-superagent, and the
 * answer is cached for `ttlMs` because the panel polls while several tabs may be open.
 */
export class TaskboardReader {
  private readonly cache = new Map<string, { at: number; value: TasksView }>()
  constructor(private readonly database: () => string, private readonly ttlMs = 5000,
    private readonly now: () => number = Date.now) {}

  /** Clear snapshots before notifying clients of a committed board change. */
  invalidate(): void { this.cache.clear() }

  /** The list for one project key, or for every project when `project` is empty. */
  read(project?: string): TasksView {
    const filter = (project ?? '').trim()
    const at = this.now()
    const cached = this.cache.get(filter)
    if (cached && at - cached.at < this.ttlMs) return cached.value
    const value = this.load(filter || undefined, at)
    this.cache.set(filter, { at, value })
    return value
  }

  private load(project: string | undefined, at: number): TasksView {
    const stamp = new Date(at).toISOString()
    const path = this.database()
    // Missing is the ordinary state before the Taskboard plugin ever opens its store, so it reads as a sentence
    // rather than as the driver's own "unable to open database file".
    if (!existsSync(path)) return { available: false, detail: `no Taskboard database at ${path}`, at: stamp, projects: [] }
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path, { readOnly: true })
      const rows = db.prepare(`select p.id as id, p.key as key, p.name as name, t.identifier as identifier,
          t.title as title, t.status as status, t.priority as priority, t.updated_at as updated_at
        from projects p left join tasks t on t.project_id = p.id and t.archived_at is null
        ${project ? 'where p.key = ? collate nocase' : ''}
        order by p.key asc, t.updated_at desc`).all(...(project ? [project] : [])) as unknown as Joined[]
      return { available: true, detail: '', at: stamp, projects: grouped(rows) }
    } catch (error) {
      // A missing board is the normal state before the Taskboard plugin ever runs; either way the panel
      // shows the sentence and the Router keeps working.
      return { available: false, detail: error instanceof Error ? error.message : String(error), at: stamp, projects: [] }
    } finally {
      try { db?.close() } catch { /* A connection that already failed to open has nothing to close. */ }
    }
  }
}

function grouped(rows: readonly Joined[]): TaskProjectEntry[] {
  const projects = new Map<string, TaskProjectEntry>()
  for (const row of rows) {
    const project = projects.get(row.id) ?? { id: row.id, key: row.key, name: row.name, tasks: [] }
    projects.set(row.id, project)
    // A project with no task still lists, so an empty board reads as empty rather than as missing.
    if (!row.identifier || !row.title || !row.status) continue
    if (project.tasks.length >= TASKS_PER_PROJECT) continue
    project.tasks.push({ identifier: row.identifier, title: row.title,
      status: taskStatus(row.status), priority: taskPriority(row.priority),
      updatedAt: new Date(row.updated_at ?? 0).toISOString() })
  }
  return [...projects.values()]
}
