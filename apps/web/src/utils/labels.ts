/**
 * 状态词表：枚举值 → 中文文案 + Semi Tag 配色。
 * 集中在这里可以保证列表、详情、审计、聊天四处口径一致。
 */
import type { TagColor } from '@aifuxi/semi-ui-vue'

export type StatusKind =
  | 'agent-status'
  | 'tool-action'
  | 'risk'
  | 'audit-decision'
  | 'audit-status'
  | 'mcp-status'
  | 'session-status'
  | 'transport'
  | 'tool-source'

export interface TagTone {
  label: string
  color: TagColor
  /** 是否需要实心情调（高风险项用 solid 更醒目）。 */
  emphasis?: boolean
}

const FALLBACK: TagTone = { label: '未知', color: 'grey' }

const AGENT_STATUS: Record<string, TagTone> = {
  published: { label: '已发布', color: 'green' },
  draft: { label: '草稿', color: 'amber' },
  disabled: { label: '已停用', color: 'grey' },
}

const TOOL_ACTION: Record<string, TagTone> = {
  allow: { label: '允许', color: 'green' },
  ask: { label: '需审批', color: 'blue' },
  deny: { label: '禁止', color: 'red' },
}

const RISK: Record<string, TagTone> = {
  low: { label: '低风险', color: 'green' },
  medium: { label: '中风险', color: 'amber' },
  high: { label: '高风险', color: 'orange' },
  critical: { label: '严重', color: 'red', emphasis: true },
}

const AUDIT_DECISION: Record<string, TagTone> = {
  allow: { label: '策略允许', color: 'green' },
  approved: { label: '人工批准', color: 'green' },
  ask: { label: '请求审批', color: 'blue' },
  deny: { label: '策略拒绝', color: 'red' },
  rejected: { label: '人工拒绝', color: 'red' },
  cancelled: { label: '已取消', color: 'grey' },
  expired: { label: '审批超时', color: 'grey' },
}

const AUDIT_STATUS: Record<string, TagTone> = {
  started: { label: '执行中', color: 'blue' },
  succeeded: { label: '成功', color: 'green' },
  failed: { label: '失败', color: 'red' },
  denied: { label: '已拒绝', color: 'red' },
  cancelled: { label: '已取消', color: 'grey' },
}

const MCP_STATUS: Record<string, TagTone> = {
  ok: { label: '连接正常', color: 'green' },
  error: { label: '连接失败', color: 'red' },
  unknown: { label: '未探测', color: 'grey' },
}

const SESSION_STATUS: Record<string, TagTone> = {
  idle: { label: '空闲', color: 'grey' },
  running: { label: '运行中', color: 'blue' },
  failed: { label: '异常', color: 'red' },
  closed: { label: '已关闭', color: 'grey' },
}

const TRANSPORT: Record<string, TagTone> = {
  stdio: { label: 'stdio', color: 'purple' },
  sse: { label: 'SSE', color: 'cyan' },
  http: { label: 'HTTP', color: 'indigo' },
}

const TOOL_SOURCE: Record<string, TagTone> = {
  business: { label: '业务工具', color: 'blue' },
  mcp: { label: 'MCP 工具', color: 'purple' },
  dsh: { label: '运行时内置', color: 'grey' },
}

const TABLES: Record<StatusKind, Record<string, TagTone>> = {
  'agent-status': AGENT_STATUS,
  'tool-action': TOOL_ACTION,
  risk: RISK,
  'audit-decision': AUDIT_DECISION,
  'audit-status': AUDIT_STATUS,
  'mcp-status': MCP_STATUS,
  'session-status': SESSION_STATUS,
  transport: TRANSPORT,
  'tool-source': TOOL_SOURCE,
}

export function toneFor(kind: StatusKind, value: string | undefined): TagTone {
  if (value === undefined) return FALLBACK
  const table = TABLES[kind]
  return table[value] ?? { label: value, color: 'grey' }
}

/** 工具来源分组标题与顺序。 */
export const TOOL_SOURCE_ORDER: ReadonlyArray<{ source: 'business' | 'mcp' | 'dsh'; label: string }> = [
  { source: 'business', label: '业务工具' },
  { source: 'mcp', label: 'MCP 工具' },
  { source: 'dsh', label: '运行时内置工具' },
]

/** 审批动作在授权语义下的实际行为说明，用于发布页的权限模拟。 */
export const ACTION_BEHAVIOUR: Record<'allow' | 'ask' | 'deny', string> = {
  allow: '直接执行，写入审计记录，用户无感知。',
  ask: '挂起并弹出审批弹窗，用户"允许一次"后才执行；超时、拒绝或撤销一律不执行。',
  deny: '不执行，直接返回拒绝结果，并写入审计记录。',
}
