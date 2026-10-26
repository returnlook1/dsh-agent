/**
 * Minimal JSONL audit writer.
 *
 * `agent-policy` and `agent-audit` write the *same* record format but must not
 * import each other (a plugin-to-plugin import would load a second module at
 * runtime), so the tiny writer is duplicated on purpose. Format contract:
 * `packages/shared/src/audit.ts` `auditRecordSchema`.
 *
 * One record = one line = one `fs.appendFileSync` call. Appends are not
 * "tmp+rename atomic" (that is impossible for an append-only log) but are atomic
 * per line for the OS write size that matters here, and each runtime process owns
 * its own file, so records never interleave across processes.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AuditDecision, AuditRecord, AuditStatus } from './contracts.js'

/** Identity fields copied onto every record from the policy snapshot / env. */
export interface AuditIdentity {
  readonly sessionId: string
  readonly runtimeId: string
  readonly agentId: string
  readonly agentVersion: number
  readonly userId: string
}

/** Everything the caller knows about one audit event. */
export interface AuditEvent {
  readonly callId: string
  readonly tool: string
  readonly decision: AuditDecision
  readonly status: AuditStatus
  readonly argumentsPreview: string
  readonly argumentsDigest: string
  readonly error?: string
  readonly durationMs?: number
  readonly approvalId?: string
  readonly at?: number
}

/**
 * Build one schema-shaped record. Optional fields are omitted (never `undefined`)
 * so the gateway's zod parse sees exactly what the contract declares.
 */
export function createAuditRecord(identity: AuditIdentity, event: AuditEvent): AuditRecord {
  const record: AuditRecord = {
    id: randomUUID(),
    at: event.at ?? Date.now(),
    sessionId: identity.sessionId,
    runtimeId: identity.runtimeId,
    agentId: identity.agentId,
    agentVersion: identity.agentVersion,
    userId: identity.userId,
    callId: event.callId,
    tool: event.tool,
    decision: event.decision,
    status: event.status,
    argumentsPreview: event.argumentsPreview,
    argumentsDigest: event.argumentsDigest,
  }
  if (event.error !== undefined) record.error = event.error
  if (event.durationMs !== undefined) record.durationMs = event.durationMs
  if (event.approvalId !== undefined) record.approvalId = event.approvalId
  return record
}

/**
 * Append one record as a single JSONL line.
 *
 * Throws on failure: in `agent-policy` a decision that cannot be recorded must
 * abort the call (fail closed), unlike `agent-audit` where a result record is
 * best effort.
 */
export function appendAuditRecord(auditPath: string, record: AuditRecord): void {
  const line = JSON.stringify(record)
  if (line.includes('\n') || line.includes('\r')) {
    throw new Error(`审计记录必须单行：${record.callId}`)
  }
  mkdirSync(dirname(auditPath), { recursive: true })
  appendFileSync(auditPath, `${line}\n`, 'utf8')
}

/**
 * Fail-fast check that the audit sink can be appended to.
 *
 * A policy process whose decisions cannot be recorded must not start: a call that
 * runs without a decision line is an unauditable call. The check writes an empty
 * string, which opens (and creates) the file without emitting a record.
 */
export function assertAuditWritable(auditPath: string): void {
  mkdirSync(dirname(auditPath), { recursive: true })
  appendFileSync(auditPath, '', 'utf8')
}
