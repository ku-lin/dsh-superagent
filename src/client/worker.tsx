/** Explicit ticket/session borrowing, the failure list, and read-only plugin discovery. */
import { useCallback, useEffect, useState } from 'react'
import { usePoll } from './api.ts'
import type { ApiResponse } from '../app/api.ts'
import type { FailureRecord } from '../app/failures.ts'
import type { DshSuperagentKey } from './locales.ts'
import { Button, Icon } from './controls.tsx'
import { useLive } from './live.ts'
import { usePanel } from './provider.tsx'
import { errorText, valueLabel, when } from './text.ts'
import { ConfirmButton, Hint, Section } from './widgets.tsx'

const label = (value: string | Record<string, string> | undefined, lang: string): string =>
  typeof value === 'string' ? value : value?.[lang] ?? value?.en ?? ''
/** The Router's replies arrive as Markdown; the panel shows them as plain text, so the syntax marks are dropped. */
const plain = (text: string): string => text.replace(/\*\*/g, '').replace(/`/g, '')
const folderName = (path: string | undefined): string => path?.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

/**
 * The 异常 list: every failure a fixed code path recorded, newest first.
 *
 * It reads `GET worker/failures` on mount, whenever the host announces a new record, and when the person asks — never on
 * a timer. The route is the authority; the pushed record only saves the refetch when the list is already on screen.
 */
function FailureRail() {
  const { t, call } = usePanel()
  const live = useLive()
  const [items, setItems] = useState<readonly FailureRecord[]>([])
  const [error, setError] = useState<Error>()
  const load = useCallback(async () => {
    try { setItems((await call('GET worker/failures', { query: { limit: 50 } })).items); setError(undefined) }
    catch (failure) { setError(failure instanceof Error ? failure : new Error(String(failure))) }
  }, [call])
  // A pushed record carries the newest fact itself, so it leads the list before the refetch answers.
  const pushed = live.failures[0]
  const announced = live.revisions['failures'] ?? 0
  useEffect(() => { void load() }, [load, announced, live.generation])
  const shown = pushed && !items.some(item => item.id === pushed.id)
    ? [pushed as unknown as FailureRecord, ...items] : items
  return <Section title={t('failuresTitle')} icon="alert" count={shown.length || undefined}>
    <Hint>{t('failuresHint')}</Hint>
    {live.offline && <p className="dt-error" role="status">{t('tasksOffline')}</p>}
    {error && <p className="dt-error" role="alert">{t('failuresLoadFailed')}</p>}
    {shown.length ? <ul className="dt-failures">{shown.map(record => <li key={record.id} className="dt-failures-row" data-kind={record.kind}>
      <div className="dt-failures-head">
        <span className="dt-failures-kind">{valueLabel(t, 'failureKind', record.kind)}</span>
        {(record.ticketId || record.sessionId) && <span className="dt-failures-target">{record.ticketId ?? record.sessionId}</span>}
        {record.exitCode !== undefined && <span className="dt-failures-exit">{t('failuresExit', { code: String(record.exitCode) })}</span>}
        <span className="dt-failures-source">{valueLabel(t, 'failureSource', record.source)}</span>
        <span className="dt-failures-ago">{when(record.at, t('lang'))}</span>
      </div>
      <div className="dt-failures-detail" title={record.detail}>{record.detail}</div>
    </li>)}</ul> : (!error && !live.offline && <Hint>{t('failuresEmpty')}</Hint>)}
  </Section>
}


export function WorkerPanel() {
  const { t, call, openSession, navigate } = usePanel()
  const [ticketId, setTicketId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [indexUrl, setIndexUrl] = useState('')
  const [searchText, setSearchText] = useState('')
  const [result, setResult] = useState<ApiResponse<'GET plugin-search'>>()
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const tickets = usePoll(() => call('GET tickets', { query: { state: 'open', limit: 1000 } }), [])
  const sessions = usePoll(() => call('GET dsh-sessions'), [])
  const indexes = usePoll(() => call('GET plugin-indexes'), [])
  const detail = usePoll(() => ticketId ? call('GET tickets/:id', { id: ticketId }) : Promise.resolve(undefined), [ticketId])
  // The router conversation's id and latest line: the panel opens it in DSH's own chat view rather than redrawing it.
  const chat = usePoll(() => call('GET router-chat', { query: { limit: 40 } }), [])
  const eligibleTickets = (tickets.data?.items ?? []).filter(item => item.state === 'open')
  const chosen = detail.data?.id === ticketId ? detail.data : undefined
  const eligible = !!chosen && chosen.assignments.at(-1)?.state === 'pending' && !!chosen.directory
    && !chosen.assignments.some(item => !!item.startedAt) && !chosen.borrowedSessionId
  const candidates = (sessions.data?.items ?? []).filter(item => item.borrowable)
  const selected = candidates.some(item => item.sessionId === sessionId) && !!sessionId
  const bind = async () => {
    if (!eligible || !selected || busy) return
    setBusy(true); setActionError('')
    try {
      await call('POST tickets/:id/worker-session', { id: ticketId, body: { sessionId } })
      await Promise.all([sessions.reload(), detail.reload(), tickets.reload()])
      setSessionId('')
    } catch (error) { setActionError(errorText(error)) }
    finally { setBusy(false) }
  }
  const search = async () => {
    if (!indexUrl || busy) return
    setBusy(true); setActionError(''); setResult(undefined)
    try { setResult(await call('GET plugin-search', { query: { url: indexUrl, text: searchText } })) }
    catch (error) { setActionError(errorText(error)) }
    finally { setBusy(false) }
  }
  const status = (item: NonNullable<typeof sessions.data>['items'][number]) =>
    item.leasedToTicketId ? 'borrowed' : item.running ? 'running' : item.agentAvailable ? 'idle' : 'unavailable'
  const rail = [...(sessions.data?.items ?? [])].sort((a, b) =>
    (status(a) === 'running' || status(a) === 'borrowed' ? 0 : 1) - (status(b) === 'running' || status(b) === 'borrowed' ? 0 : 1)
    || a.updatedAt - b.updatedAt)
  return <Section title={t('workerPanel')} icon="session">
    <div className="dt-worker-layout">
      <div className="dt-worker-main">
    {/* The conversation itself runs in DSH's own chat view. This card is the console: the way in, and what it last said. */}
    <div className="dt-router-chat">
      <span className="dt-section-title">{t('routerChat')}</span>
      <p className="dt-router-hint">{t('routerChatHint')}</p>
      <div className="dt-worker-controls">
        <Button variant="primary" className="dt-router-open" icon={<Icon name="session" size={16} />}
          onClick={() => void openSession(chat.data?.sessionId ?? '').catch(error => setActionError(errorText(error)))}>{t('routerChatOpen')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void chat.reload()}>{t('routerChatRefresh')}</Button>
      </div>
      {chat.data?.items.length ? <p className="dt-router-last">{t('routerChatLast', { text: plain(chat.data.items.at(-1)!.text).slice(0, 200) })}</p> : null}
      {chat.error ? <Hint>{t('workerLoadFailed')}</Hint> : null}
    </div>
    {/* Borrowing a conversation for a Ticket and plugin discovery are occasional, so they stay out of the chat's way. */}
    <details className="dt-worker-more">
      <summary>{t('workerMore')}</summary>
    <div className="dt-worker-controls">
      <label className="dt-worker-picker" htmlFor="dt-worker-ticket">{t('workerChooseTicket')}
        <select id="dt-worker-ticket" className="dt-select" value={ticketId} onChange={event => { setTicketId(event.target.value); setSessionId(''); setActionError('') }}>
          <option value="">{t('workerNoTicket')}</option>
          {eligibleTickets.map(item => <option key={item.id} value={item.id}>{item.title} ({item.id})</option>)}
        </select>
      </label>
      <label className="dt-worker-picker" htmlFor="dt-worker-session">{t('workerChooseSession')}
        <select id="dt-worker-session" className="dt-select" value={sessionId} onChange={event => { setSessionId(event.target.value); setActionError('') }}>
          <option value="">{t('workerNoSession')}</option>
          {candidates.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title || folderName(item.cwd) || t('workerUntitled')}</option>)}
        </select>
      </label>
      <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void Promise.all([sessions.reload(), tickets.reload(), indexes.reload()])}>{t('workerRefreshSessions')}</Button>
      <ConfirmButton variant="outline" disabled={!eligible || !selected || busy} label={t('workerAttach')} title={t('workerAttach')} message={t('workerBindConfirm', { ticket: chosen?.title ?? ticketId, session: candidates.find(item => item.sessionId === sessionId)?.title || t('workerUntitled') })} onConfirm={bind} />
    </div>
    <Hint>{t('workerOptInHint')}</Hint>
    {!eligible && ticketId && <Hint>{t('workerTicketIneligible')}</Hint>}
    {ticketId && <Button variant="outline" size="sm" onClick={() => navigate({ page: 'execution', id: ticketId })}>{t('term.ticket')}</Button>}
    {sessionId && <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} onClick={() => void openSession(sessionId).catch(error => setActionError(errorText(error)))}>{t('openSession')}</Button>}
    {(tickets.error || sessions.error || detail.error || indexes.error || actionError) && <p className="dt-error" role="alert">{actionError || tickets.error?.message || sessions.error?.message || detail.error?.message || indexes.error?.message}</p>}
    <div className="dt-worker-discovery">
      <span className="dt-section-title">{t('workerPlugins')}</span>
      {!indexes.data?.available ? <Hint>{indexes.data ? t('workerDiscoveryUnavailable') : t('loading')}</Hint> : <>
        <div className="dt-worker-controls">
          <label className="dt-worker-picker" htmlFor="dt-worker-index">{t('workerPluginIndex')}
            <select id="dt-worker-index" className="dt-select" value={indexUrl} onChange={event => { setIndexUrl(event.target.value); setResult(undefined) }}>
              <option value="">{t('workerChooseIndex')}</option>
              {indexes.data.items.map(item => <option key={item.url} value={item.url}>{label(item.title, t('lang')) || item.url}</option>)}
            </select>
          </label>
          <label className="dt-worker-picker" htmlFor="dt-worker-query">{t('workerPluginQuery')}
            <input id="dt-worker-query" className="dt-input" type="search" value={searchText} onChange={event => setSearchText(event.target.value)} />
          </label>
          <Button variant="outline" size="sm" disabled={!indexUrl || busy} icon={<Icon name="search" size={14} />} onClick={() => void search()}>{t('searchLabel')}</Button>
        </div>
        {result && (result.entries.length ? <ul className="dt-list">{result.entries.map(item => <li key={item.name} className="dt-row"><div className="dt-row-main"><div className="dt-row-title">{label(item.title, t('lang')) || item.name}</div><div className="dt-row-meta">{item.name} {item.version ?? ''} {item.installation ?? ''}</div>{item.description && <div className="dt-row-meta">{label(item.description, t('lang'))}</div>}</div></li>)}</ul> : <Hint>{t('workerNoPlugins')}</Hint>)}
      </>}
    </div>
    </details>
      </div>
      <aside className="dt-worker-rail" aria-label={t('workerRail')}>
        <span className="dt-section-title">{t('workerRail')}</span>
        {rail.length ? <ul className="dt-worker-rail-list">{rail.map(item => <li key={item.sessionId} className="dt-worker-rail-row">
          <div className="dt-worker-rail-title">{item.title || folderName(item.cwd) || t('workerUntitled')}</div>
          <span className={`dt-worker-status dt-worker-status-${status(item)}`}>{t(`workerStatus${status(item)[0]!.toUpperCase()}${status(item).slice(1)}` as 'workerStatusIdle')}</span>
          {(item.ticketTitle || item.leasedToTicketId) && <div className="dt-row-meta">{item.ticketTitle ?? item.leasedToTicketId}</div>}
        </li>)}</ul> : <Hint>{sessions.error ? t('workerLoadFailed') : sessions.data ? t('workerNoSessions') : t('loading')}</Hint>}
      </aside>
    </div>
    <FailureRail />
  </Section>
}
