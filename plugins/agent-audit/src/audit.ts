/**
 * Minimal JSONL audit writer (result side).
 *
 * `agent-policy` and `agent-audit` write the *same* record format but must not
 * import each other, so the tiny writer is duplicated on purpose. Format contract:
 * `packages/shared/src/audit.ts` `auditRecordSchema`.
 *
 * One record = one line = one `fs.appendFileSync` call. Each runtime process owns
 * its own audit file, so lines never interleave across processes.
 *
 * Difference from the policy copy: failures here are downgraded to stderr. An
 * unavailable audit log must never turn a business tool call into a failure.
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
 * Append one record as a single JSONL line, swallowing every failure.
 * @returns `true` when the line reached the file.
 */
export function appendAuditRecordBestEffort(auditPath: string, record: AuditRecord): boolean {
  try {
    const line = JSON.stringify(record)
    if (line.includes('\n') || line.includes('\r')) {
      process.stderr.write(`[agent-audit] 审计记录必须单行，已丢弃：${record.callId}\n`)
      return false
    }
    mkdirSync(dirname(auditPath), { recursive: true })
    appendFileSync(auditPath, `${line}\n`, 'utf8')
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[agent-audit] 审计写入失败 ${auditPath}（${detail}），工具执行不受影响\n`)
    return false
  }
}
