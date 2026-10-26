/**
 * 工具执行审计记录。
 *
 * 插件进程（DSH 子进程）把记录以 JSONL 追加写入 `auditPath`，网关负责 tail
 * 并落库。这样做的原因：子进程不持有数据库连接，也不会因为网关重启丢失
 * 已发生的执行事实。
 */
import { z } from 'zod'

export const auditDecisionSchema = z.enum([
  'allow',
  'deny',
  'ask',
  'approved',
  'rejected',
  'cancelled',
  'expired',
])
export type AuditDecision = z.infer<typeof auditDecisionSchema>

export const auditStatusSchema = z.enum(['started', 'succeeded', 'failed', 'denied', 'cancelled'])
export type AuditStatus = z.infer<typeof auditStatusSchema>

export const auditRecordSchema = z.object({
  /** 记录 id（uuid）。 */
  id: z.string(),
  /** 记录写入时间。 */
  at: z.number(),
  /** 业务会话 id。 */
  sessionId: z.string(),
  runtimeId: z.string(),
  agentId: z.string(),
  agentVersion: z.number().int(),
  userId: z.string(),
  /** DSH 工具调用 id。 */
  callId: z.string(),
  tool: z.string(),
  /** 策略判断结果。 */
  decision: auditDecisionSchema,
  /** 执行状态；deny 时固定为 denied。 */
  status: auditStatusSchema,
  /** 参数摘要（脱敏 + 截断）。 */
  argumentsPreview: z.string().default(''),
  /** 参数 sha256 指纹，用于审计追溯与审批一致性校验。 */
  argumentsDigest: z.string().default(''),
  /** 失败原因或拒绝原因。 */
  error: z.string().optional(),
  /** 执行耗时（毫秒），仅在 succeeded / failed 时有值。 */
  durationMs: z.number().optional(),
  /** 审批 id（decision=ask 时）。 */
  approvalId: z.string().optional(),
})
export type AuditRecord = z.infer<typeof auditRecordSchema>

/** 审批结果对审计 decision 的映射。 */
export function auditDecisionForApproval(
  decision: 'allowed-once' | 'rejected' | 'cancelled' | 'expired',
): AuditDecision {
  if (decision === 'allowed-once') return 'approved'
  return decision
}
