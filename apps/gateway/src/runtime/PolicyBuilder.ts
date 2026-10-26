/**
 * 策略快照生成器。
 *
 * 规则（docs/IMPL-GATEWAY.md §5）：
 * 1. 只写 allow / ask 的工具，不写 deny —— 未列出的工具由 `defaultAction: deny` 兜底；
 * 2. `security.*` 为 true、`subagents` 为 true 一律拒绝（发布校验与运行时双重把关）；
 * 3. `ask` 只允许用于具备审批通道的工具，否则降级为 deny 并产生 warning；
 * 4. MCP 工具名保留 `mcp__<serverId>__*` 尾部通配；
 * 5. 快照带版本、运行时 id、控制通道与审计路径，插件只读。
 */
import {
  POLICY_SNAPSHOT_VERSION,
  policySnapshotSchema,
  type AgentConfig,
  type ConfigWarning,
  type PolicySnapshot,
  type ToolAction,
} from '@agent-studio/shared'

export class PolicyViolationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'PolicyViolationError'
    this.field = field
  }
}

/** PolicyBuilder 需要的最小目录能力（避免 runtime 层互相构造）。 */
export interface PolicyToolLookup {
  supportsApprovalChannel(name: string): boolean
}

export interface BuildPolicyInput {
  config: AgentConfig
  /** 已发布版本号（不是 draft.version）。 */
  agentVersion: number
  runtimeId: string
  sessionId: string
  userId: string
  controlDir: string
  auditPath: string
  approvalTimeoutMs: number
  /** 0 表示不限。 */
  maxToolCalls?: number
  toolLookup: PolicyToolLookup
  now?: number
}

export interface BuildPolicyResult {
  snapshot: PolicySnapshot
  warnings: ConfigWarning[]
}

const SECURITY_FIELDS = ['shell', 'fileRead', 'fileWrite', 'pluginManagement'] as const

export function buildPolicy(input: BuildPolicyInput): BuildPolicyResult {
  const { config } = input
  const warnings: ConfigWarning[] = []

  for (const field of SECURITY_FIELDS) {
    if (config.security[field]) {
      throw new PolicyViolationError(`security.${field}`, `受限 Agent 不允许开启 security.${field}`)
    }
  }
  if (config.capabilities.subagents) {
    throw new PolicyViolationError('capabilities.subagents', '第一版禁用子智能体')
  }

  const tools: Record<string, ToolAction> = {}
  for (const [name, action] of Object.entries(config.capabilities.tools)) {
    if (action === 'deny') continue

    // networkAccess=none：不挂载任何 MCP 工具，即使配置里写了 allow。
    if (config.security.networkAccess === 'none' && name.startsWith('mcp__')) {
      warnings.push({
        field: `capabilities.tools.${name}`,
        message: 'security.networkAccess=none 时不挂载任何 MCP 工具，该授权已忽略',
      })
      continue
    }

    if (action === 'ask' && !input.toolLookup.supportsApprovalChannel(name)) {
      warnings.push({
        field: `capabilities.tools.${name}`,
        message: `工具 ${name} 没有审批通道，ask 已降级为 deny（默认拒绝）`,
      })
      continue
    }

    tools[name] = action
  }

  const snapshot = policySnapshotSchema.parse({
    snapshotVersion: POLICY_SNAPSHOT_VERSION,
    agentId: config.id,
    agentVersion: input.agentVersion,
    runtimeId: input.runtimeId,
    sessionId: input.sessionId,
    userId: input.userId,
    issuedAt: input.now ?? Date.now(),
    tools,
    defaultAction: 'deny',
    approvalTimeoutMs: input.approvalTimeoutMs,
    controlDir: input.controlDir,
    auditPath: input.auditPath,
    maxToolCalls: input.maxToolCalls ?? 0,
    maxTurns: config.limits.maxTurns,
  })

  return { snapshot, warnings }
}
