/**
 * Revocation marker: `controlDir/revoked.json` — existence is the signal.
 *
 * The check runs on *every* tool call and must stay cheap, so it is a single
 * `statSync` backed by a short cache. The cache window is capped at 1000 ms
 * (docs/IMPL-PLUGINS.md §1.2): a revocation is visible within one second, and a
 * busy tool loop cannot turn the kill switch into hundreds of stats per second.
 *
 * Fail closed: a marker that exists but cannot be parsed still revokes; a `stat`
 * that fails for any reason (ACLs, I/O) revokes too.
 */
import { readFileSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'

import { parseRevocationReason } from './contracts.js'

/** Name of the revocation marker inside the control directory. */
export const REVOCATION_FILE = 'revoked.json'

/** Upper bound on the stat cache, in milliseconds. */
export const MAX_REVOCATION_CACHE_MS = 1000

/** Observed revocation state. */
export interface RevocationState {
  readonly revoked: boolean
  readonly reason?: string
}

/** Options for {@link createRevocationMonitor}. */
export interface RevocationMonitorOptions {
  /** Absolute path to `revoked.json`. */
  readonly path: string
  /** Stat cache window in ms; clamped to [0, {@link MAX_REVOCATION_CACHE_MS}]. */
  readonly cacheMs?: number
  /** Injectable clock, for deterministic cache-expiry tests. */
  readonly now?: () => number
}

/** A cheap, cached revocation probe. */
export interface RevocationMonitor {
  readonly path: string
  /** Current state; re-stats the marker when the cache window has elapsed. */
  isRevoked(): RevocationState
}

const NOT_REVOKED: RevocationState = { revoked: false }

/**
 * Create a revocation probe for one control directory.
 * @param options marker path, cache window and clock.
 * @returns a monitor whose `isRevoked()` never throws.
 */
export function createRevocationMonitor(options: RevocationMonitorOptions): RevocationMonitor {
  const path = options.path
  const requested = options.cacheMs ?? MAX_REVOCATION_CACHE_MS
  const cacheMs = Math.min(Math.max(requested, 0), MAX_REVOCATION_CACHE_MS)
  const now = options.now ?? Date.now

  let checkedAt = Number.NEGATIVE_INFINITY
  let state: RevocationState = NOT_REVOKED
  let lastMtimeMs = Number.NaN
  let lastReason: string | undefined

  const readState = (): RevocationState => {
    let stats: Stats
    try {
      stats = statSync(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // "Absent" is the only benign outcome. Anything else (ENOTDIR, EACCES,
      // EIO, …) means the kill switch cannot be evaluated → fail closed.
      if (code === 'ENOENT') {
        lastMtimeMs = Number.NaN
        lastReason = undefined
        return NOT_REVOKED
      }
      const detail = error instanceof Error ? error.message : String(error)
      return { revoked: true, reason: `撤销标记无法检查（${detail}）` }
    }
    if (stats.mtimeMs !== lastMtimeMs) {
      lastMtimeMs = stats.mtimeMs
      try {
        lastReason = parseRevocationReason(JSON.parse(readFileSync(path, 'utf8')))
      } catch {
        // Present but unreadable/malformed: still revoked, just without a reason.
        lastReason = undefined
      }
    }
    return lastReason === undefined ? { revoked: true } : { revoked: true, reason: lastReason }
  }

  return {
    path,
    isRevoked(): RevocationState {
      const current = now()
      if (current - checkedAt < cacheMs) return state
      checkedAt = current
      state = readState()
      return state
    },
  }
}
