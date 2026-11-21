// @vitest-environment jsdom
// The Router's task list: what it shows, what it hides, and how it degrades.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { mount, remount, settle, all, click, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const rail = () => document.querySelector('.dt-tasks')
const rows = () => all('.dt-tasks-row')
const badges = () => all('.dt-task-badge')
const ids = () => rows().map(row => row.querySelector('.dt-tasks-id')?.textContent)
const setValue = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

it('shows every project\'s unfinished tasks with a status badge, and hides finished ones until asked', async () => {
  await mount()
  expect(rail()).not.toBeNull()
  // Only the project that has a visible task shows a group: an empty group is one heading too many.
  expect(all('.dt-tasks-group-name').map(name => name.textContent?.trim())).toEqual(['Fixture project2'])
  // The order is by what is moving, not by identifier or by the server's order: in progress, then to do, done hidden.
  expect(ids()).toEqual(['FIXTURE-1', 'FIXTURE-2'])
  expect(badges().map(badge => badge.textContent)).toEqual([zh['taskStatus.in_progress'], zh['taskStatus.todo']])
  expect(badges().map(badge => badge.getAttribute('data-status'))).toEqual(['in_progress', 'todo'])
  // The summary counts the three statuses a person acts on.
  expect(document.querySelector('.dt-tasks-summary')?.textContent)
    .toBe(zh.tasksCountWorking.replace('{count}', '1') + zh.tasksCountReview.replace('{count}', '0')
      + zh.tasksCountBlocked.replace('{count}', '0'))
  const toggle = document.querySelector('.dt-tasks-switch input') as HTMLInputElement
  await click(toggle.closest('label') as HTMLElement)
  expect(ids()).toEqual(['FIXTURE-1', 'FIXTURE-2', 'FIXTURE-3'])
})

it('filters to one project and copies an identifier when a row is clicked', async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  await mount()
  const select = document.querySelector('.dt-tasks-project') as HTMLSelectElement
  await setValue(select, 'OTHER')
  expect(rail()?.textContent).toContain(zh.tasksEmpty)
  expect(rows()).toEqual([])
  await setValue(select, '')
  expect(ids()).toEqual(['FIXTURE-1', 'FIXTURE-2'])
  await click(rows()[0]!)
  expect(writeText).toHaveBeenCalledWith('FIXTURE-1')
  expect(text()).toContain(zh.tasksCopied.replace('{identifier}', 'FIXTURE-1'))
})

it('collapses to a tab that keeps the count, and stays collapsed across a remount', async () => {
  await mount()
  const open = rows().length
  await click(all('button').find(button => button.getAttribute('aria-label') === zh.tasksCollapse)!)
  expect(rail()?.className).toContain('dt-tasks-collapsed')
  expect(all('.dt-tasks-toggle')).toHaveLength(1)
  expect(document.querySelector('.dt-tasks-toggle .dt-count')?.textContent).toBe(String(open))
  await remount()
  expect(rail()?.className).toContain('dt-tasks-collapsed')
  await click(document.querySelector('.dt-tasks-toggle') as HTMLElement)
  expect(rail()?.className).not.toContain('dt-tasks-collapsed')
})

it('says the board is unavailable instead of failing, and keeps the rest of the panel usable', async () => {
  server.tasks = { available: false, detail: 'no Taskboard database at /nowhere/taskboard.sqlite', at: '2026-09-23T00:00:00Z',
    projects: [] }
  await mount()
  expect(text()).toContain(zh.tasksUnavailable.replace('{detail}', 'no Taskboard database at /nowhere/taskboard.sqlite'))
  expect(rows()).toEqual([])
  // The Router's own views still render: the rail is a fixture of the panel, not a gate in front of it.
  expect(all('[role="tab"]').length).toBeGreaterThan(0)
})

it('says the list could not be read when the route itself fails, without an error toast', async () => {
  server.down = true
  await mount()
  expect(rail()?.textContent).toContain(zh.tasksLoadFailed)
  // The page's own failure is still reported by the header, separately from the rail's sentence.
  expect(text()).toContain(zh.hostNotRunning)
})

it('words the statuses and the summary in the interface language', async () => {
  await mount(en)
  expect(badges().map(badge => badge.textContent)).toEqual([en['taskStatus.in_progress'], en['taskStatus.todo']])
  expect(document.querySelector('.dt-tasks-summary')?.textContent)
    .toBe(en.tasksCountWorking.replace('{count}', '1') + en.tasksCountReview.replace('{count}', '0')
      + en.tasksCountBlocked.replace('{count}', '0'))
})
