/**
 * In-process decision hand-off from `agent-policy` to `agent-audit`.
 *
 * Both plugins run in the same Cordis tree (one DSH subprocess per business
 * session), but neither may import the other. `Symbol.for()` on `globalThis` is a
 * cross-module channel that survives separate module instances and needs no
 * import: `agent-policy` writes the policy verdict for a `callId`, `agent-audit`
 * reads it when the call settles so the result line carries the real decision
 * instead of a guessed `allow`.
 *
 * Purely best effort: if the map is missing or the entry was evicted, the audit
 * plugin falls back to `allow` and still writes a valid record.
 */
import type { AuditDecision } from './contracts.js'

/** Symbol key shared verbatim with `plugins/agent-audit/src/bridge.ts`. */
const BRIDGE_KEY = Symbol.for('@agent-studio/tool-audit-bridge/v1')

/** Maximum retained verdicts; older entries are evicted first. */
const MAX_ENTRIES = 512

/** One policy verdict, as seen by an audit observer. */
export interface AuditBridgeEntry {
  readonly decision: AuditDecision
  readonly error?: string
  readonly approvalId?: string
}

interface AuditBridgeStore {
  readonly entries: Map<string, AuditBridgeEntry>
}

function store(): AuditBridgeStore {
  const host = globalThis as unknown as Record<symbol, AuditBridgeStore | undefined>
  const existing = host[BRIDGE_KEY]
  if (existing !== undefined) return existing
  const created: AuditBridgeStore = { entries: new Map() }
  host[BRIDGE_KEY] = created
  return created
}

/** Record the policy verdict for one call. */
export function putDecision(callId: string, entry: AuditBridgeEntry): void {
  const { entries } = store()
  entries.set(callId, entry)
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next()
    if (oldest.done === true) break
    entries.delete(oldest.value)
  }
}

/** Read (and forget) the policy verdict for one call. */
export function takeDecision(callId: string): AuditBridgeEntry | undefined {
  const { entries } = store()
  const entry = entries.get(callId)
  if (entry !== undefined) entries.delete(callId)
  return entry
}
