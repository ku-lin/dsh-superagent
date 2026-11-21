/**
 * The Router's task list: a collapsible rail that shows every Taskboard project and its tasks, with the status of each.
 *
 * Read-only by construction — `GET tasks` opens the Taskboard's store read-only — and quiet when the board is not
 * there: the rail says so in one sentence and the Router keeps working.
 *
 * It learns about changes from the live channel, not from a timer: the host announces a board change and this refetches
 * once. When the stream is down the rail says 「已断开」 and offers a manual refresh, and nothing polls in the
 * background — a silent fallback would hide the very failure that state is reporting.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
// The status words are the board's, imported from the module that has no dependency on the database driver.
import { type TaskStatus } from '../app/task-status.ts'
import { Button, Icon } from './controls.tsx'
import { useLive } from './live.ts'
import { usePanel } from './provider.tsx'
import { errorText, when } from './text.ts'
import type { DshSuperagentKey } from './locales.ts'

type Tasks = ApiResponse<'GET tasks'>
type TaskRow = Tasks['projects'][number]['tasks'][number]
/** Statuses the rail hides unless "show finished" is on: the two that mean nothing is left to do. */
const FINISHED: readonly TaskStatus[] = ['done', 'canceled']
/** Statuses the summary counts, in the order a person reads them. */
const COUNTED: readonly { status: TaskStatus; key: DshSuperagentKey }[] = [
  { status: 'in_progress', key: 'tasksCountWorking' },
  { status: 'in_review', key: 'tasksCountReview' },
  { status: 'blocked', key: 'tasksCountBlocked' },
]
const STORAGE = 'dsh-superagent/tasks.v1'
interface Prefs { collapsed: boolean; showDone: boolean; project: string }
const DEFAULTS: Prefs = { collapsed: false, showDone: false, project: '' }
/** The rail's own switches survive a panel remount; an unreadable value falls back to the defaults. */
function stored(): Prefs {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE) ?? 'null') as Partial<Prefs> | null
    return { collapsed: value?.collapsed === true, showDone: value?.showDone === true,
      project: typeof value?.project === 'string' ? value.project : '' }
  } catch { return DEFAULTS }
}
const statusKey = (status: TaskStatus): DshSuperagentKey => `taskStatus.${status}` as DshSuperagentKey
const priorityKey = (priority: string): DshSuperagentKey => `taskPriority.${priority}` as DshSuperagentKey

/** The order a reader cares about: what is moving now, then what waits on someone, then what has not started. */
const WEIGHT: readonly TaskStatus[] = ['in_progress', 'in_review', 'blocked', 'todo', 'backlog', 'done', 'canceled']
/** A rail task, ordered by that weight and then by the board's own recency. */
const byStatus = (a: TaskRow, b: TaskRow): number =>
  WEIGHT.indexOf(a.status) - WEIGHT.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)

export function TaskListPanel() {
  const { t, call, notify } = usePanel()
  const [prefs, setPrefs] = useState(stored)
  const edit = useCallback((patch: Partial<Prefs>) => setPrefs(current => {
    const next = { ...current, ...patch }
    try { sessionStorage.setItem(STORAGE, JSON.stringify(next)) } catch { /* The rail's switches are a convenience. */ }
    return next
  }), [])
  // One request for every project; filtering by key here keeps the project selector instant. The request happens on
  // mount, whenever the host announces a board change, and when the person presses refresh — never on a timer.
  const live = useLive()
  const [data, setData] = useState<Tasks>()
  const [error, setError] = useState<Error>()
  // A refetch asked for twice before the first answer lands runs once, so a burst of announcements costs one request.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const load = useCallback(() => {
    queue.current = queue.current.then(async () => {
      try { setData(await call('GET tasks')); setError(undefined) }
      catch (failure) { setError(failure instanceof Error ? failure : new Error(String(failure))) }
    })
    return queue.current
  }, [call])
  // The board's changes arrive as `tasks` announcements; `generation` also bumps on a reconnect and on refresh.
  const announced = live.revisions['tasks'] ?? 0
  useEffect(() => { void load() }, [load, announced, live.generation])
  const reload = load
  const projects = useMemo(() => (data?.projects ?? []).map(project => ({ ...project,
    tasks: [...project.tasks].sort(byStatus) })).filter(project => !prefs.project || project.key === prefs.project),
  [data, prefs.project])
  const shown = (task: TaskRow): boolean => prefs.showDone || !FINISHED.includes(task.status)
  const counts = useMemo(() => {
    const all = projects.flatMap(project => project.tasks)
    return COUNTED.map(({ status, key }) => ({ key, count: all.filter(task => task.status === status).length }))
  }, [projects])
  const copy = (identifier: string): void => {
    void navigator.clipboard?.writeText(identifier).then(() => notify(t('tasksCopied', { identifier })),
      () => notify(identifier))
  }
  const total = projects.reduce((sum, project) => sum + project.tasks.filter(shown).length, 0)
  // A project whose every task is filtered out shows no heading, so an empty list is one sentence and not a stack of
  // empty groups.
  const groups = projects.map(project => ({ ...project, rows: project.tasks.filter(shown) })).filter(project => project.rows.length > 0)
  const status = data ? !data.available ? t('tasksUnavailable', { detail: data.detail }) : '' : error ? t('tasksLoadFailed') : t('loading')
  if (prefs.collapsed) return <aside className="dt-tasks dt-tasks-collapsed" aria-label={t('tasksTitle')}>
    <button type="button" className="dt-tasks-toggle" aria-expanded={false} title={t('tasksTitle')}
      onClick={() => edit({ collapsed: false })}><Icon name="chevron-left" size={14} /><span className="dt-tasks-toggle-label">{t('tasksTitle')}</span>
      <span className="dt-count">{total}</span></button>
  </aside>
  return <aside className="dt-tasks" aria-label={t('tasksTitle')}>
    <div className="dt-tasks-head">
      {/* Not `.dt-section-title`: that class marks a page's own sections, and the rail's heading is not one of them. */}
      <h2 className="dt-tasks-heading"><span className="dt-tasks-heading-name">{t('tasksTitle')}</span>
        <span className="dt-count">{total}</span></h2>
      <div className="dt-tasks-actions">
        {/* A live channel needs no refresh button; a dropped one needs exactly this, and says so below. */}
        {!live.connected && <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} aria-label={t('tasksRefresh')}
          title={t('tasksRefresh')} onClick={() => void reload()} />}
        <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} />} aria-label={t('tasksCollapse')}
          title={t('tasksCollapse')} onClick={() => edit({ collapsed: true })} />
      </div>
    </div>
    {/* The disconnect is stated, never worked around: nothing polls while the stream is down. */}
    {live.offline && <p className="dt-tasks-offline" role="status">{t('tasksOffline')}</p>}
    <select className="dt-select dt-tasks-project" aria-label={t('tasksProject')} value={prefs.project}
      onChange={event => edit({ project: event.target.value })}>
      <option value="">{t('tasksAllProjects')}</option>
      {(data?.projects ?? []).map(project => <option key={project.id} value={project.key}>{project.name}</option>)}
    </select>
    <div className="dt-tasks-summary">{counts.map(({ key, count }) => <span key={key} className="dt-tasks-count">{t(key, { count })}</span>)}</div>
    {status && <p className="dt-hint dt-tasks-status" role="status">{status}</p>}
    {error && data && <p className="dt-hint dt-tasks-status" role="status">{t('tasksLoadFailed')}</p>}
    <ul className="dt-tasks-groups">
      {groups.map(project => <li key={project.id} className="dt-tasks-group">
        <div className="dt-tasks-group-name"><span className="dt-ellipsis">{project.name}</span>
          <span className="dt-count">{project.rows.length}</span></div>
        <ul className="dt-tasks-list">
          {project.rows.map(task => <li key={task.identifier}>
            <button type="button" className="dt-tasks-row" title={t('tasksCopyHint', { identifier: task.identifier })}
              onClick={() => copy(task.identifier)}>
              <span className="dt-tasks-id">{task.identifier}</span>
              <span className="dt-tasks-title">{task.title}</span>
              <span className="dt-task-badge" data-status={task.status} title={t(priorityKey(task.priority))}>
                {t(statusKey(task.status))}</span>
            </button>
          </li>)}
        </ul>
      </li>)}
    </ul>
    {!status && !groups.length && <p className="dt-hint">{t('tasksEmpty')}</p>}
    <div className="dt-tasks-foot">
      <label className="dt-tasks-switch">
        <input type="checkbox" checked={prefs.showDone} onChange={event => edit({ showDone: event.target.checked })} />
        <span>{t('tasksShowDone')}</span>
      </label>
      {data && <span className="dt-hint dt-tasks-stamp">{t('tasksUpdated', { at: when(data.at, t('lang')) })}</span>}
    </div>
    {error && !data && <p className="dt-hint dt-tasks-status">{errorText(error)}</p>}
  </aside>
}
