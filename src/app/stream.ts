/**
 * The panel's live channel: one Server-Sent Events stream per open management panel, and the event bus behind it.
 *
 * The panel used to ask `GET tasks` every thirty seconds and every other route every few seconds. Those reads are
 * still correct, but they are no longer how the panel learns that something changed: the host bumps a revision on
 * every write that a person can see, the stream pushes the new revision, and the panel refetches exactly the routes it
 * was told about. A change nobody made pushes nothing, so an idle panel is silent.
 *
 * DSH's own web server already owns the plumbing this needs: a prefix route's handler owns the full response
 * lifecycle ("may hold the response open, e.g. SSE"), and its gzip middleware deliberately skips
 * `text/event-stream`, so a route can hold its response without fighting compression. No new listen port, no second
 * server, and no change to `node_modules`.
 *
 * Degradation is explicit, never silent: a stream that cannot open or that drops leaves the panel in its "已断开"
 * state with a manual refresh button. Nothing falls back to polling — a fallback would hide exactly the failure the
 * panel is meant to report.
 * @module dsh-superagent/src/app/stream
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FailureRecord } from './failures.ts'

/** What changed, as one name the panel maps to the routes it must refetch. */
export const STREAM_TOPICS = ['tasks', 'tickets', 'sessions', 'failures', 'state', 'router', 'settings', 'overview'] as const
export type StreamTopic = typeof STREAM_TOPICS[number]

/** One pushed frame: the topic, the monotonic revision, and at most one failure record when the topic is `failures`. */
export interface StreamEvent {
  readonly topic: StreamTopic
  readonly revision: number
  /** ISO timestamp of the change, so a panel can say when the newest fact it holds happened. */
  readonly at: string
  /** The record that caused a `failures` push, so the list can prepend it without a refetch. */
  readonly failure?: FailureRecord
}

/** How often a comment is written so a proxy or a sleeping client notices a dead peer. */
const HEARTBEAT_MS = 25_000
/** How many events one connection may fall behind before it is closed instead of being buffered for ever. */
const MAX_BUFFERED_BYTES = 1 << 20

/** One connected panel. */
interface Subscriber {
  readonly send: (frame: string) => void
  readonly close: () => void
}

/**
 * The event bus and its connected panels.
 *
 * `publish` is synchronous and never throws: a stream that cannot be written to is dropped from the set instead of
 * failing the write that produced the event. Every published topic is also remembered with a revision, so a panel that
 * reconnects can tell whether it missed anything (`revision` in the `hello` frame) instead of refetching blindly.
 */
export class StreamHub {
  private readonly subscribers = new Set<Subscriber>()
  private readonly revisions = new Map<StreamTopic, number>()

  /** How many panels are connected right now. */
  get size(): number { return this.subscribers.size }

  /** The newest revision published for `topic`; `0` means nothing has been published since this process started. */
  revision(topic: StreamTopic): number { return this.revisions.get(topic) ?? 0 }

  /** Every topic's current revision, as the `hello` frame carries it. */
  revisionsFrame(): Record<string, number> { return Object.fromEntries(STREAM_TOPICS.map(topic => [topic, this.revision(topic)])) }

  /**
   * Announce one change.
   * @param topic - what changed.
   * @param failure - the record behind a `failures` push, when there is one.
   */
  publish(topic: StreamTopic, failure?: FailureRecord): void {
    const revision = (this.revisions.get(topic) ?? 0) + 1
    this.revisions.set(topic, revision)
    if (!this.subscribers.size) return
    const event: StreamEvent = { topic, revision, at: new Date().toISOString(), ...failure ? { failure } : {} }
    const frame = `event: change\ndata: ${JSON.stringify(event)}\n\n`
    for (const subscriber of [...this.subscribers]) {
      try { subscriber.send(frame) } catch { this.subscribers.delete(subscriber) }
    }
  }

  /**
   * Hold one HTTP response open as an SSE stream until the client goes away.
   *
   * The response is finished with the request, never by this method: a closed stream is the browser's decision, and
   * the panel's own "已断开" state is what tells a person it happened.
   * @param req - the request whose close ends the stream.
   * @param res - the response to hold open.
   * @returns false when the response cannot hold a stream (a test double, or a host that answered elsewhere), so the
   * caller can answer that case instead of throwing out of the route.
   */
  attach(req: IncomingMessage, res: ServerResponse): boolean {
    // A real response always exposes `write`; a request answered by a double that only writes a body does not.
    if (typeof res.write !== 'function' || typeof res.once !== 'function') return false
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
    // A reconnect is expected after a restart: the hello frame says what this process has published so far.
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(),
      revisions: this.revisionsFrame() })}\n\n`)
    const subscriber: Subscriber = {
      send: frame => {
        if (res.writableEnded || res.destroyed) throw new Error('stream closed')
        // A panel that stops reading is disconnected rather than buffered without bound.
        if (res.writableLength > MAX_BUFFERED_BYTES) throw new Error('stream falling behind')
        res.write(frame)
      },
      close: () => { try { res.end() } catch { /* Already closed. */ } },
    }
    this.subscribers.add(subscriber)
    // One timer per connection, which the connection's own close clears: a shared heartbeat would have to outlive the
    // host's lifetime to be correct, and a stream nobody reads is exactly what it is meant to detect.
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      this.subscribers.delete(subscriber)
      clearInterval(timer)
      // `end` rather than `destroy`: a half-written frame is the only thing at risk, and the socket is going anyway.
      subscriber.close()
    }
    const timer = setInterval(() => {
      try { subscriber.send(': keep-alive\n\n') } catch { finish() }
    }, HEARTBEAT_MS)
    timer.unref?.()
    req.once('close', finish)
    res.once('close', finish)
    res.once('error', finish)
    return true
  }

  /** End every open stream, which a shutting-down host does before its listener closes. */
  dispose(): void {
    for (const subscriber of [...this.subscribers]) subscriber.close()
    this.subscribers.clear()
  }
}
