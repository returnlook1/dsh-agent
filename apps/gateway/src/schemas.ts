/**
 * 共享契约的本地汇聚层 + 网关私有的校验 schema。
 *
 * 单独一层的原因：共享包只导出 DTO 类型，`ConfigWarning[]` 等持久化形状需要
 * 在网关侧做 zod 校验；集中在这里避免每个仓库各写一份。
 */
import { z } from 'zod'

export {
  agentConfigSchema,
  agentConfigInputSchema,
  agentStatusSchema,
  capabilitiesSchema,
  createAgentRequestSchema,
  limitsSchema,
  mergeAgentConfig,
  modelConfigSchema,
  networkAccessSchema,
  promptConfigSchema,
  securitySchema,
  slugifyAgentId,
  toolActionSchema,
  toolRiskSchema,
  uiConfigSchema,
  updateAgentRequestSchema,
} from '@agent-studio/shared'

export type {
  AgentConfig,
  AgentConfigInput,
  AgentDetail,
  AgentStatus,
  AgentSummary,
  AgentVersionDto,
  ApprovalDto,
  ConfigWarning,
  CreateAgentRequest,
  Limits,
  McpServerConfig,
  McpServerDto,
  MessageDto,
  Role,
  Security,
  ToolAction,
  ToolCallRecord,
  ToolRisk,
  UpdateAgentRequest,
} from '@agent-studio/shared'

export const configWarningSchema = z.object({
  field: z.string(),
  message: z.string(),
})

export const configWarningsSchema = z.array(configWarningSchema)

/** 消息角色与工具调用记录（持久化形状）。 */
export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])

export const toolCallRecordSchema = z.array(
  z.object({
    callId: z.string(),
    tool: z.string(),
    argumentsPreview: z.string().optional(),
    status: z.enum(['running', 'succeeded', 'failed', 'denied']),
    error: z.string().optional(),
    durationMs: z.number().optional(),
  }),
)

/** SQLite 中布尔列（0/1）的读取。 */
export function readBoolean(value: unknown): boolean {
  return Number(value) === 1
}
