/**
 * 会话筛选的纯函数（搜索 + 状态）。
 */
import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '@agent-studio/shared'

import { countByStatus, filterConversations, matchesQuery } from '../src/utils/conversation-filter'

function item(overrides: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    projectId: 'ocean',
    sessionId: `dsh-${overrides.id}`,
    title: '未命名对话',
    status: 'idle',
    messageCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ConversationSummary
}

const ITEMS: ConversationSummary[] = [
  item({ id: 'conv-a', title: '长江口流场分析', status: 'idle' }),
  item({ id: 'conv-b', title: 'GIS 切片导出', status: 'running' }),
  item({ id: 'conv-c', title: '模型结果质检', status: 'failed' }),
  item({ id: 'conv-d', title: '站点潮位对比', status: 'idle', projectId: 'station' }),
]

describe('matchesQuery', () => {
  it('空查询命中全部', () => {
    expect(ITEMS.every((entry) => matchesQuery(entry, '   '))).toBe(true)
  })

  it('按标题 / ID / 项目 ID 匹配，且不区分大小写', () => {
    expect(matchesQuery(ITEMS[0]!, '流场')).toBe(true)
    expect(matchesQuery(ITEMS[1]!, 'CONV-B')).toBe(true)
    expect(matchesQuery(ITEMS[3]!, 'station')).toBe(true)
    expect(matchesQuery(ITEMS[0]!, '不存在')).toBe(false)
  })
})

describe('filterConversations', () => {
  it('按状态过滤', () => {
    expect(filterConversations(ITEMS, '', 'running').map((entry) => entry.id)).toEqual(['conv-b'])
    expect(filterConversations(ITEMS, '', 'failed').map((entry) => entry.id)).toEqual(['conv-c'])
    expect(filterConversations(ITEMS, '', 'idle').map((entry) => entry.id)).toEqual(['conv-a', 'conv-d'])
  })

  it('状态与搜索同时生效', () => {
    expect(filterConversations(ITEMS, '站点', 'idle').map((entry) => entry.id)).toEqual(['conv-d'])
    expect(filterConversations(ITEMS, '站点', 'failed')).toEqual([])
  })

  it('保持原顺序', () => {
    expect(filterConversations(ITEMS, '', 'all').map((entry) => entry.id)).toEqual([
      'conv-a',
      'conv-b',
      'conv-c',
      'conv-d',
    ])
  })
})

describe('countByStatus', () => {
  it('统计各状态数量', () => {
    expect(countByStatus(ITEMS)).toEqual({ all: 4, idle: 2, running: 1, failed: 1 })
  })

  it('空列表', () => {
    expect(countByStatus([])).toEqual({ all: 0, idle: 0, running: 0, failed: 0 })
  })
})
