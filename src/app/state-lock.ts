/**
 * The state directory's lock, taken with a bounded retry.
 *
 * The lock is what keeps two processes from migrating or writing the database at once, so it is held for the whole
 * life of the Runtime. A process that is killed leaves its lock directory behind: proper-lockfile refuses the next
 * start with ELOCKED until that directory is older than the stale window. Without a retry inside that window a
 * restart failed before anything was mounted — the plugin entry showed the error and every `/orchestrator/api/*`
 * route answered 404 — so a start now waits the window out instead.
 */
import { statSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'

/** Where proper-lockfile keeps a directory's lock: beside it, named after it. */
export const lockPath = (directory: string): string => `${directory}.lock`

/** What a lock directory tells about its holder, which is all a newcomer can learn: when it last proved it was alive. */
export interface LockHolder { path: string; refreshedAt?: string; ageMs?: number }

/** The lock that could not be taken, with enough of its holder's trace to explain the wait. */
export interface LockRefusal {
  /** The last refusal as proper-lockfile raised it: `ELOCKED` while another process holds the lock, or a filesystem error. */
  error: Error
  /** Acquisition attempts made before giving up. */
  attempts: number
  /** Milliseconds spent waiting between attempts. */
  waitedMs: number
  /** The holder's trace, when a lock directory was there to read. */
  holder?: LockHolder
}

export interface LockPolicy {
  /** A lock its holder stops refreshing for this long is stale and may be taken; the holder refreshes it every half of this. */
  staleMs: number
  /** Acquisition attempts, one after the other, before the caller is told the lock is held. */
  attempts: number
  /** Milliseconds waited between two attempts. */
  waitMs: number
  /** Called if the held lock is later found compromised, such as when its own mtime could not be refreshed. */
  onCompromised?: (error: Error) => void
  /** The wait between attempts; tests replace it, and production blocks the thread. */
  sleep?: (ms: number) => void
}

/** About ten seconds in all: long enough for a predecessor's stale window, short enough not to hold up the host's boot. */
export const DEFAULT_LOCK_POLICY: Omit<LockPolicy, 'onCompromised' | 'sleep'> = { staleMs: 5_000, attempts: 10, waitMs: 1_000 }

/** Blocks this thread without a timer, because the lock must be held before the Runtime composes anything. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The holder's trace a lock directory carries, or undefined when there is no lock directory. */
export function describeLock(directory: string, now = Date.now()): LockHolder | undefined {
  const path = lockPath(directory)
  try {
    const { mtimeMs } = statSync(path)
    return { path, refreshedAt: new Date(mtimeMs).toISOString(), ageMs: Math.max(0, Math.round(now - mtimeMs)) }
  } catch { return undefined }
}

/** The lock this process holds, with what it cost to take it. */
export interface HeldLock {
  release(): Promise<void>
  /** The same release, for a constructor that must let go before it throws. */
  releaseSync(): void
  /** The attempt that took the lock: 1 unless a predecessor's lock directory had to age out first. */
  attempts: number
  /** Milliseconds waited for a predecessor's lock directory to age out. */
  waitedMs: number
}

export interface LockAttempt {
  /** The lock, absent when every attempt was refused. */
  held?: HeldLock
  /** Why it was refused; absent when `held` is set. */
  refusal?: LockRefusal
}

/**
 * Takes the state directory's lock, waiting out a predecessor's stale window.
 * A refusal is returned rather than thrown, so the caller can report the wait and keep its plugin mounted.
 */
export function acquireStateLock(directory: string, policy: Partial<LockPolicy> = {}): LockAttempt {
  const { staleMs, attempts, waitMs } = { ...DEFAULT_LOCK_POLICY, ...policy }
  const sleep = policy.sleep ?? sleepSync
  const options = { stale: staleMs, ...policy.onCompromised ? { onCompromised: policy.onCompromised } : {} }
  const total = Math.max(1, attempts)
  let refusal: Error | undefined
  let waitedMs = 0
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      const release = lockSync(directory, options)
      return { held: { release: async () => { release() }, releaseSync: release, attempts: attempt, waitedMs } }
    } catch (error) {
      refusal = error instanceof Error ? error : new Error(String(error))
      if (attempt >= total) break
      sleep(waitMs)
      waitedMs += waitMs
    }
  }
  const holder = describeLock(directory)
  return { refusal: { error: refusal ?? new Error('The state directory lock could not be taken'), attempts: total, waitedMs,
    ...holder ? { holder } : {} } }
}
