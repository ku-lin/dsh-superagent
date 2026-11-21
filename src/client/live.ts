/**
 * The panel's live channel, browser side: one fetch-held stream, a set of topics, and an explicit "已断开" state.
 *
 * This replaces polling as the way the panel learns that something changed. It is deliberately **not** an
 * `EventSource`: the host fenced its management routes behind `x-orchestrator-request: 1`, which `EventSource` cannot
 * set, so the stream is read from a `fetch` body instead. That also makes cancellation ordinary (`AbortController`),
 * and keeps the same `credentials: 'omit'` the other calls use — a cookie-bearing request is held by the host's own
 * gateway.
 *
 * When the stream cannot open or drops, the hook reports `offline` and **nothing polls in its place**. That is the
 * point: a silent fallback to polling would hide exactly the failure this state exists to show. The panel offers a
 * manual refresh, and the connection is retried on a bounded backoff so it recovers by itself once the host is back.
 * @module dsh-superagent/src/client/live
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreamEvent, StreamTopic } from '../app/stream.ts'

/** What a live subscription reports: the newest revision per topic, whether the stream is up, and a manual refresh. */
export interface Live {
  /** True once the stream's `hello` frame arrived and the connection has not dropped since. */
  readonly connected: boolean
  /** Set when the stream is not usable, for the panel to show next to its manual refresh. */
  readonly offline: boolean
  /** The newest revision seen per topic; a change bumps only the topic it names. */
  readonly revisions: Readonly<Record<string, number>>
  /** Records pushed with a `failures` event, newest first, so the list needs no refetch to show the newest alert. */
  readonly failures: readonly PushedFailure[]
  /** Ask for one full refetch of everything, which the manual refresh button does. */
  readonly refresh: () => void
  /** Bumped by `refresh`, so a view's own effect can depend on it. */
  readonly generation: number
}
/** The shape a pushed failure record carries; kept structural so the panel bundles no host code. */
export interface PushedFailure {
  readonly id: string
  readonly at: string
  readonly kind: string
  readonly source: string
  readonly detail: string
  readonly ticketId?: string
  readonly sessionId?: string
  readonly exitCode?: number
}

/** Backoff before a dropped stream is reopened; a healthy host comes back within the first or second step. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const
/** How many pushed failures are kept in memory; the log itself is the authority, this is only the fast path. */
const PUSHED_LIMIT = 50

/**
 * Hold one stream open for as long as the calling component is mounted.
 *
 * A `hello` frame opens the connection and carries the current revisions; each `change` frame carries the topic and its
 * new revision. Frames are parsed incrementally because a chunk boundary can split one anywhere, which is the one thing
 * a hand-written SSE reader usually gets wrong.
 * @param onEvent - called for every change frame, so a view can refetch the routes it owns.
 */
export function useLive(onEvent?: (event: StreamEvent) => void): Live {
  const [connected, setConnected] = useState(false)
  const [offline, setOffline] = useState(false)
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const [failures, setFailures] = useState<readonly PushedFailure[]>([])
  const [generation, setGeneration] = useState(0)
  // Read through a ref so a changing callback does not tear down the stream and reconnect on every render.
  const notify = useRef(onEvent)
  notify.current = onEvent
  useEffect(() => {
    let disposed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: AbortController | undefined
    const run = async (): Promise<void> => {
      if (disposed) return
      stop = new AbortController()
      try {
        const response = await fetch('/orchestrator/api/stream',
          // `signal` is the only cancellation the stream needs: aborting it closes the body reader.
          { signal: stop.signal, credentials: 'omit', headers: { accept: 'text/event-stream', 'x-orchestrator-request': '1' } })
        if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done || disposed) break
          buffer += decoder.decode(value, { stream: true })
          // Frames are separated by a blank line; a partial trailing frame stays in the buffer.
          let split = buffer.indexOf('\n\n')
          while (split >= 0) {
            const frame = buffer.slice(0, split)
            buffer = buffer.slice(split + 2)
            split = buffer.indexOf('\n\n')
            read(frame)
          }
        }
      } catch {
        // Unreachable host, aborted stream, or a body that ended: all are the same fact for the panel.
      }
      if (disposed) return
      setConnected(false)
      setOffline(true)
      const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!
      timer = setTimeout(() => { void run() }, wait)
    }
    /** Apply one frame: `hello` opens the stream, `change` bumps a topic. Comments and other events are ignored. */
    const read = (frame: string): void => {
      let event = 'message'
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) return
      let payload: { revisions?: Record<string, number> } & Partial<StreamEvent>
      try { payload = JSON.parse(data) as typeof payload } catch { return }
      if (event === 'hello') {
        attempt = 0
        setConnected(true); setOffline(false)
        if (payload.revisions) setRevisions(payload.revisions)
        // A reconnect may have missed changes: one refetch brings every view up to date.
        setGeneration(current => current + 1)
        return
      }
      if (event !== 'change' || !payload.topic) return
      const change = payload as StreamEvent
      setRevisions(current => ({ ...current, [change.topic]: change.revision }))
      if (change.failure) {
        const pushed = change.failure as unknown as PushedFailure
        setFailures(current => [pushed, ...current.filter(item => item.id !== pushed.id)].slice(0, PUSHED_LIMIT))
      }
      notify.current?.(change)
    }
    void run()
    return () => {
      disposed = true
      clearTimeout(timer)
      stop?.abort()
    }
  }, [])
  const refresh = useCallback(() => { setGeneration(current => current + 1) }, [])
  return { connected, offline, revisions, failures, refresh, generation }
}

/** Whether a live change on `topics` asks a view to refetch, given the revisions it last rendered. */
export function advanced(revisions: Readonly<Record<string, number>>, seen: Readonly<Record<string, number>>,
  topics: readonly StreamTopic[]): boolean {
  return topics.some(topic => (revisions[topic] ?? 0) > (seen[topic] ?? 0))
}
