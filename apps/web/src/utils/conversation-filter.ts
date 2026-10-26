/**
 * 会话列表的本地筛选（搜索 + 状态），抽成纯函数便于单测。
 */
import type { ConversationStatus, ConversationSummary } from '@agent-studio/shared'

export type ConversationStatusFilter = 'all' | ConversationStatus

/** 标题、ID、项目 ID 里任一命中即算匹配（不区分大小写）。 */
export function matchesQuery(item: ConversationSummary, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return (
    item.title.toLowerCase().includes(needle) ||
    item.id.toLowerCase().includes(needle) ||
    item.projectId.toLowerCase().includes(needle)
  )
}

/** 搜索 + 状态过滤；保持传入顺序。 */
export function filterConversations(
  items: readonly ConversationSummary[],
  query: string,
  status: ConversationStatusFilter,
): ConversationSummary[] {
  return items.filter(
    (item) => (status === 'all' || item.status === status) && matchesQuery(item, query),
  )
}

/** 每个状态的数量（用于过滤标签上的计数）。 */
export function countByStatus(
  items: readonly ConversationSummary[],
): Record<ConversationStatusFilter, number> {
  const counts: Record<ConversationStatusFilter, number> = {
    all: items.length,
    idle: 0,
    running: 0,
    failed: 0,
  }
  for (const item of items) counts[item.status] += 1
  return counts
}
