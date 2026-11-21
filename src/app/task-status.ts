/**
 * The Taskboard's statuses and priorities as plain data.
 *
 * Kept apart from `tasks.ts` so the browser bundle can import the words and the order without pulling in
 * `node:sqlite`: this module imports nothing at all, and both the reader and the panel take it.
 */
export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'] as const
export type TaskStatus = typeof TASK_STATUSES[number]
export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]
/** A status the board writes that this build has no words for reads as the board's first status, never as a crash. */
export const taskStatus = (value: unknown): TaskStatus => TASK_STATUSES.find(status => status === value) ?? 'backlog'
export const taskPriority = (value: unknown): TaskPriority => TASK_PRIORITIES.find(priority => priority === value) ?? 'none'
