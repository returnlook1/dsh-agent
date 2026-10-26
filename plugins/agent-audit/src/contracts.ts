/**
 * Runtime-free mirrors of the file contracts owned by `packages/shared`.
 *
 * Why duplicated instead of imported: `agent-audit` must not perform *any* runtime
 * import (docs/IMPL-PLUGINS.md "共同约束"), and `@agent-studio/shared` exports zod
 * schemas as values.
 *
 * Sources of truth:
 * - `packages/shared/src/policy.ts` — policySnapshotSchema / approval* schemas.
 * - `packages/shared/src/audit.ts` — auditRecordSchema.
 * - `packages/shared/src/agent-config.ts` — toolActionSchema.
 *
 * Keep this file byte-identical to `plugins/agent-policy/src/contracts.ts`.
 */

/** `POLICY_SNAPSHOT_VERSION` — the only snapshot version this plugin understands. */
export const POLICY_SNAPSHOT_VERSION = 1

/** `toolActionSchema` */
export type ToolAction = 'allow' | 'deny' | 'ask'

/** `auditDecisionSchema` */
export type AuditDecision = 'allow' | 'deny' | 'ask' | 'approved' | 'rejected' | 'cancelled' | 'expired'

/** `auditStatusSchema` */
export type AuditStatus = 'started' | 'succeeded' | 'failed' | 'denied' | 'cancelled'

/** `policySnapshotSchema` — validated, defaulted, read-only. */
export interface PolicySnapshot {
  readonly snapshotVersion: typeof POLICY_SNAPSHOT_VERSION
  readonly agentId: string
  readonly agentVersion: number
  readonly runtimeId: string
  readonly sessionId: string
  readonly userId: string
  readonly issuedAt: number
  /** Tool name → action. Unlisted tools fall back to `defaultAction`. */
  readonly tools: Readonly<Record<string, ToolAction>>
  readonly defaultAction: 'deny'
  readonly approvalTimeoutMs: number
  readonly controlDir: string
  readonly auditPath: string
  readonly maxToolCalls: number
  readonly maxTurns: number
}

/** `approvalRequestSchema` — written by `agent-policy`, read by the gateway. */
export interface ApprovalRequest {
  readonly approvalId: string
  readonly callId: string
  readonly tool: string
  readonly description: string
  readonly argumentsPreview: string
  readonly argumentsDigest: string
  readonly requestedAt: number
  readonly expiresAt: number
}

/** `approvalDecisionSchema` */
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled'

/** `approvalDecisionRecordSchema` — written by the gateway, read by `agent-policy`. */
export interface ApprovalDecisionRecord {
  readonly approvalId: string
  readonly decision: ApprovalDecision
  readonly decidedBy: string
  readonly decidedAt: number
  readonly reason?: string
}

/** `revocationRecordSchema` — only ever read for its human-readable reason. */
export interface RevocationRecord {
  readonly revoked: true
  readonly reason: string
  readonly at: number
  readonly by?: string
}

/** `auditRecordSchema` — one JSONL line in the runtime audit file. */
export interface AuditRecord {
  id: string
  at: number
  sessionId: string
  runtimeId: string
  agentId: string
  agentVersion: number
  userId: string
  callId: string
  tool: string
  decision: AuditDecision
  status: AuditStatus
  argumentsPreview: string
  argumentsDigest: string
  error?: string
  durationMs?: number
  approvalId?: string
}

/** Raised for any policy/control-channel file that does not match its contract. */
export class PolicyConfigError extends Error {
  readonly path?: string

  constructor(message: string, path?: string) {
    super(message)
    this.name = 'PolicyConfigError'
    if (path !== undefined) this.path = path
  }
}

const TOOL_ACTIONS: readonly ToolAction[] = ['allow', 'deny', 'ask']

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(input)) {
    throw new PolicyConfigError(`${label} 必须是 JSON 对象（实际为 ${describe(input)}）`)
  }
  return input
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new PolicyConfigError(`字段 "${key}" 必须是字符串（实际为 ${describe(value)}）`)
  }
  return value
}

function requireFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PolicyConfigError(`字段 "${key}" 必须是有限数字（实际为 ${describe(value)}）`)
  }
  return value
}

/**
 * Integer field, mirroring `z.number().int()` plus the schema's own bound.
 * `min` is `undefined` where the source schema declares no bound.
 */
function requireInteger(
  record: Record<string, unknown>,
  key: string,
  min: number | undefined,
  fallback?: number,
): number {
  const value = record[key]
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PolicyConfigError(`字段 "${key}" 必须是整数（实际为 ${describe(value)}）`)
  }
  if (min !== undefined && value < min) {
    throw new PolicyConfigError(`字段 "${key}" 必须 >= ${min}（实际为 ${value}）`)
  }
  return value
}

/**
 * Validate one policy snapshot exactly like `policySnapshotSchema.parse()`.
 *
 * Fail closed: every deviation (missing field, wrong type, unknown tool action,
 * unsupported `snapshotVersion` / `defaultAction`) throws.
 *
 * Like zod's default object mode, unknown extra keys are ignored.
 */
export function parsePolicySnapshot(input: unknown): PolicySnapshot {
  const record = requireRecord(input, '策略快照')

  const snapshotVersion = record['snapshotVersion'] === undefined ? POLICY_SNAPSHOT_VERSION : record['snapshotVersion']
  if (snapshotVersion !== POLICY_SNAPSHOT_VERSION) {
    throw new PolicyConfigError(`不支持的策略快照版本 snapshotVersion=${String(snapshotVersion)}（仅支持 ${POLICY_SNAPSHOT_VERSION}）`)
  }

  const defaultAction = record['defaultAction'] === undefined ? 'deny' : record['defaultAction']
  if (defaultAction !== 'deny') {
    throw new PolicyConfigError(`defaultAction 必须是 "deny"（实际为 ${String(defaultAction)}）`)
  }

  const rawTools = record['tools']
  if (!isPlainRecord(rawTools)) {
    throw new PolicyConfigError(`字段 "tools" 必须是对象（实际为 ${describe(rawTools)}）`)
  }
  const tools: Record<string, ToolAction> = {}
  for (const [toolName, action] of Object.entries(rawTools)) {
    if (typeof action !== 'string' || !TOOL_ACTIONS.includes(action as ToolAction)) {
      throw new PolicyConfigError(`tools["${toolName}"] 必须是 allow / deny / ask 之一（实际为 ${String(action)}）`)
    }
    tools[toolName] = action as ToolAction
  }

  return Object.freeze({
    snapshotVersion: POLICY_SNAPSHOT_VERSION,
    agentId: requireString(record, 'agentId'),
    agentVersion: requireInteger(record, 'agentVersion', undefined),
    runtimeId: requireString(record, 'runtimeId'),
    sessionId: requireString(record, 'sessionId'),
    userId: requireString(record, 'userId'),
    issuedAt: requireFiniteNumber(record, 'issuedAt'),
    tools: Object.freeze(tools),
    defaultAction: 'deny',
    approvalTimeoutMs: requireInteger(record, 'approvalTimeoutMs', 1, 120_000),
    controlDir: requireString(record, 'controlDir'),
    auditPath: requireString(record, 'auditPath'),
    maxToolCalls: requireInteger(record, 'maxToolCalls', 0, 0),
    maxTurns: requireInteger(record, 'maxTurns', 1, 20),
  })
}

/** Validate one gateway-written decision record. Unknown shapes return `undefined`. */
export function parseApprovalDecisionRecord(input: unknown): ApprovalDecisionRecord | undefined {
  if (!isPlainRecord(input)) return undefined
  const approvalId = input['approvalId']
  const decision = input['decision']
  const decidedBy = input['decidedBy']
  const decidedAt = input['decidedAt']
  const reason = input['reason']
  if (typeof approvalId !== 'string') return undefined
  if (decision !== 'allowed-once' && decision !== 'rejected' && decision !== 'cancelled') return undefined
  if (typeof decidedBy !== 'string') return undefined
  if (typeof decidedAt !== 'number' || !Number.isFinite(decidedAt)) return undefined
  if (reason !== undefined && typeof reason !== 'string') return undefined
  return {
    approvalId,
    decision,
    decidedBy,
    decidedAt,
    ...(reason === undefined ? {} : { reason }),
  }
}

/** Best-effort reason from a revocation file; malformed content still counts as revoked. */
export function parseRevocationReason(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return undefined
  const reason = input['reason']
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined
}
