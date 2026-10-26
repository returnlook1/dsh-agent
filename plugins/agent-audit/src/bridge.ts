/**
 * Reader side of the in-process decision hand-off from `agent-policy`.
 *
 * Both plugins run in the same Cordis tree and must not import each other, so they
 * rendezvous on `globalThis[Symbol.for('@agent-studio/tool-audit-bridge/v1')]`.
 * If the map is absent (policy plugin not loaded, or the verdict was evicted) the
 * audit plugin falls back to inferring the decision from `result.isError`.
 */
import type { AuditDecision } from './contracts.js'

/** Symbol key shared verbatim with `plugins/agent-policy/src/bridge.ts`. */
const BRIDGE_KEY = Symbol.for('@agent-studio/tool-audit-bridge/v1')

/** One policy verdict, as seen by an audit observer. */
export interface AuditBridgeEntry {
  readonly decision: AuditDecision
  readonly error?: string
  readonly approvalId?: string
}

interface AuditBridgeStore {
  readonly entries: Map<string, AuditBridgeEntry>
}

function store(): AuditBridgeStore | undefined {
  const host = globalThis as unknown as Record<symbol, AuditBridgeStore | undefined>
  return host[BRIDGE_KEY]
}

/** Read (and forget) the policy verdict for one call, if the policy plugin left one. */
export function takeDecision(callId: string): AuditBridgeEntry | undefined {
  const bridge = store()
  if (bridge === undefined) return undefined
  const entry = bridge.entries.get(callId)
  if (entry !== undefined) bridge.entries.delete(callId)
  return entry
}
