// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { usePanel, mount, click, tab, type } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
it('only offers borrowable conversations and requires confirmation before binding a pending ticket', async () => {
  server.tickets.open = [ticketSummary()]
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, assignments: [
    { id: 'a1', state: 'pending', createdAt: '2026-09-22T00:00:00Z' }] }
  server.workerSessions = [
    { sessionId: 'master' as SessionId, agentAvailable: true, running: false, blank: false, updatedAt: 1, borrowable: false },
    { sessionId: 'human-1' as SessionId, title: '修登录 bug', agentAvailable: true, running: false, blank: false, updatedAt: 2, borrowable: true },
  ]
  await mount()
  await click(tab(zh['tab.worker']))
  const tickets = document.querySelector<HTMLSelectElement>('#dt-worker-ticket')!
  const sessions = document.querySelector<HTMLSelectElement>('#dt-worker-session')!
  expect([...sessions.options].map(option => option.value)).toEqual(['', 'human-1'])
  // The conversation is named by its title, not by its session id.
  expect([...sessions.options].map(option => option.textContent)).toEqual(['不使用现有 Session', '修登录 bug'])
  const rail = document.querySelector<HTMLElement>('.dt-worker-rail')!
  expect(rail.textContent).toContain('修登录 bug')
  expect(rail.textContent).toContain(zh.workerStatusIdle)
  expect(rail.textContent).not.toContain('human-1')
  await type(tickets, 't1')
  await type(sessions, 'human-1')
  await click(zh.workerAttach)
  expect(server.requests.some(request => request.path === 'tickets/t1/worker-session')).toBe(false)
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'tickets/t1/worker-session')).toMatchObject({
    method: 'POST', body: { sessionId: 'human-1' },
  })
  expect([...sessions.options].map(option => option.value)).toEqual([''])
})

it("offers the router conversation to open in DSH's own chat view, with its latest line", async () => {
  server.routerChat = { sessionId: 'master', items: [
    { role: 'user', text: '列出所有 worker', dispatched: [] },
    { role: 'assistant', text: '当前 worker：取证ag（空闲）', dispatched: ['取证ag'] },
  ] }
  await mount()
  await click(tab(zh['tab.worker']))
  const console_ = document.querySelector('.dt-router-chat')!
  expect(console_.textContent).toContain(zh.routerChatHint)
  // The panel summarises the conversation; the transcript itself belongs to the conversation view.
  expect(console_.querySelector('.dt-router-chat-list')).toBeNull()
  expect(console_.textContent).toContain('当前 worker：取证ag（空闲）')
  await click(zh.routerChatOpen)
  // The button hands the conversation to the workspace, which owns the real chat view.
  expect(server.opened).toContain('master')
})

it('says plugin discovery is unavailable, without a search form, when the host offers no index', async () => {
  server.pluginIndexes = { available: false, items: [] }
  await mount()
  await click(tab(zh['tab.worker']))
  expect(document.querySelector('.dt-worker-discovery')?.textContent).toContain(zh.workerDiscoveryUnavailable)
  expect(document.querySelector('#dt-worker-index')).toBeNull()
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('searches the selected plugin index without installing a plugin', async () => {
  server.pluginIndexes = { available: true, items: [{ url: 'https://plugins.example.test/index.json', title: { zh: '测试索引', en: 'Test index' } }] }
  server.pluginResults = { entries: [{ name: 'plugin-search-fixture', title: { zh: '检索工具', en: 'Search Tool' }, version: '1.2.3', description: '只读测试结果' }], total: 1, nextOffset: null }
  await mount()
  await click(tab(zh['tab.worker']))
  await type(document.querySelector<HTMLSelectElement>('#dt-worker-index')!, 'https://plugins.example.test/index.json')
  await type(document.querySelector<HTMLInputElement>('#dt-worker-query')!, '检索')
  await click(document.querySelector<HTMLButtonElement>('.dt-worker-discovery button')!)
  const search = server.requests.find(request => request.path.startsWith('plugin-search?'))
  expect(search?.method).toBe('GET')
  const query = new URLSearchParams(search?.path.split('?')[1])
  expect(query.get('url')).toBe('https://plugins.example.test/index.json')
  expect(query.get('text')).toBe('检索')
  expect(document.body.textContent).toContain('plugin-search-fixture')
  expect(server.requests.filter(request => request.method === 'POST' && request.path.includes('plugin'))).toEqual([])
})
