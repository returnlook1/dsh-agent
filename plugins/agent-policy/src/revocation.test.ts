/**
 * Revocation marker semantics: existence = revoked, stat cache ≤ 1000 ms,
 * malformed content still revokes, and an unusable stat fails closed.
 */
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createRevocationMonitor,
  MAX_REVOCATION_CACHE_MS,
  REVOCATION_FILE,
} from './revocation.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-policy-revocation-'))
}

describe('createRevocationMonitor', () => {
  it('reports not revoked while the marker is absent', () => {
    const path = join(tempDir(), REVOCATION_FILE)
    const monitor = createRevocationMonitor({ path, now: () => 0 })
    expect(monitor.isRevoked()).toEqual({ revoked: false })
  })

  it('revokes as soon as the marker exists and exposes its reason', () => {
    const directory = tempDir()
    const path = join(directory, REVOCATION_FILE)
    let clock = 1_000
    const monitor = createRevocationMonitor({ path, cacheMs: 0, now: () => clock })

    expect(monitor.isRevoked().revoked).toBe(false)
    writeFileSync(path, JSON.stringify({ revoked: true, reason: '管理员停用该运行时', at: 1 }), 'utf8')
    clock += 1
    expect(monitor.isRevoked()).toEqual({ revoked: true, reason: '管理员停用该运行时' })
  })

  it('serves the cached result inside the 1000 ms window and refreshes after it', () => {
    const directory = tempDir()
    const path = join(directory, REVOCATION_FILE)
    let clock = 1_000
    const monitor = createRevocationMonitor({ path, cacheMs: 1_000, now: () => clock })

    expect(monitor.isRevoked().revoked).toBe(false)
    writeFileSync(path, JSON.stringify({ revoked: true, reason: 'late', at: 1 }), 'utf8')

    clock += 500
    expect(monitor.isRevoked().revoked).toBe(false) // still inside the cache window

    clock += 501
    expect(monitor.isRevoked()).toEqual({ revoked: true, reason: 'late' }) // window elapsed
  })

  it('clamps the cache window to 1000 ms', () => {
    const directory = tempDir()
    const path = join(directory, REVOCATION_FILE)
    let clock = 0
    const monitor = createRevocationMonitor({ path, cacheMs: 60_000, now: () => clock })

    expect(monitor.isRevoked().revoked).toBe(false)
    writeFileSync(path, JSON.stringify({ revoked: true, at: 1 }), 'utf8')

    clock += MAX_REVOCATION_CACHE_MS + 1
    expect(monitor.isRevoked().revoked).toBe(true)
  })

  it('revokes when the marker exists but cannot be parsed', () => {
    const directory = tempDir()
    const path = join(directory, REVOCATION_FILE)
    const monitor = createRevocationMonitor({ path, cacheMs: 0, now: () => 0 })

    writeFileSync(path, 'not json at all', 'utf8')
    expect(monitor.isRevoked()).toEqual({ revoked: true })
  })

  it('revokes when the stat fails for a non-ENOENT reason', () => {
    // A NUL byte makes Node reject the path before touching the filesystem
    // (ERR_INVALID_ARG_VALUE). The kill switch cannot be evaluated → fail closed.
    const monitor = createRevocationMonitor({ path: 'bad\u0000path', cacheMs: 0, now: () => 0 })
    const state = monitor.isRevoked()
    expect(state.revoked).toBe(true)
    expect(state.reason).toContain('撤销标记无法检查')
  })

  it('treats an absent marker as not revoked even when the parent is unusable', () => {
    // Windows reports ENOENT (not ENOTDIR) for `<file>/<name>`, so this is
    // indistinguishable from "no marker". A broken control directory is caught
    // earlier by `assertControlDirUsable()` at plugin start (see approval.test).
    const directory = tempDir()
    const blocker = join(directory, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const monitor = createRevocationMonitor({ path: join(blocker, REVOCATION_FILE), cacheMs: 0, now: () => 0 })
    expect(monitor.isRevoked().revoked).toBe(false)
  })

  it('picks up a changed reason when mtime changes', () => {
    const directory = tempDir()
    const path = join(directory, REVOCATION_FILE)
    const monitor = createRevocationMonitor({ path, cacheMs: 0, now: () => 0 })

    writeFileSync(path, JSON.stringify({ revoked: true, reason: 'first', at: 1 }), 'utf8')
    expect(monitor.isRevoked().reason).toBe('first')

    writeFileSync(path, JSON.stringify({ revoked: true, reason: 'second', at: 2 }), 'utf8')
    // Windows can report the same mtime for two writes in the same tick; the monitor
    // keys its reason cache on mtime, so force a distinct timestamp instead of
    // relying on filesystem clock granularity.
    const bumped = new Date(Date.now() + 5_000)
    utimesSync(path, bumped, bumped)

    expect(monitor.isRevoked().reason).toBe('second')
  })
})
