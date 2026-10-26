/**
 * `search_datasets` — search the authorized business dataset catalogue.
 *
 * Risk: low, default action: allow. Deterministic: the fixture is read on every
 * call, results are sorted by id and capped at 20 entries.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { loadDatasets } from '../data.js'
import { toolsSettings } from '../runtime.js'
import type { BusinessToolMeta } from '../tool-meta.js'

/** Maximum number of entries returned by one search. */
export const MAX_SEARCH_RESULTS = 20

/** Minimum accepted keyword length. */
export const MIN_KEYWORD_LENGTH = 1

/** Maximum accepted keyword length. */
export const MAX_KEYWORD_LENGTH = 80

/** Catalogue metadata for this tool. */
export const meta: BusinessToolMeta = {
  name: 'search_datasets',
  title: '检索数据集',
  description:
    '检索已授权的业务数据集。keyword 为 1..80 字符的检索词，匹配数据集名称、描述与标签（大小写不敏感）。' +
    `最多返回 ${MAX_SEARCH_RESULTS} 条，按 id 排序，输出确定。`,
  risk: 'low',
  defaultAction: 'allow',
  requiresApprovalChannel: false,
  restrictedAllowed: true,
}

/** The registered tool definition. */
export const searchDatasets = defineTool({
  name: meta.name,
  description: meta.description,
  parameters: {
    keyword: {
      type: 'string',
      required: true,
      description: `检索关键词，1..${MAX_KEYWORD_LENGTH} 个字符；匹配数据集名称、描述与标签。`,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', required: true },
        total: { type: 'integer', required: true },
        datasets: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              description: { type: 'string', required: true },
              tags: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  execute(args, exec) {
    if (exec.signal.aborted) throw new Error('调用已取消')
    const keyword = args.keyword.trim()
    if (keyword.length < MIN_KEYWORD_LENGTH || keyword.length > MAX_KEYWORD_LENGTH) {
      throw new Error(`\`keyword\` 长度必须在 ${MIN_KEYWORD_LENGTH}..${MAX_KEYWORD_LENGTH} 之间（实际 ${keyword.length}）`)
    }
    const needle = keyword.toLowerCase()
    const matched = loadDatasets(toolsSettings()).filter((dataset) => {
      if (dataset.name.toLowerCase().includes(needle)) return true
      if (dataset.description.toLowerCase().includes(needle)) return true
      return dataset.tags.some((tag) => tag.toLowerCase().includes(needle))
    })
    const datasets = matched.slice(0, MAX_SEARCH_RESULTS).map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      tags: dataset.tags,
    }))
    return Promise.resolve({ keyword, total: matched.length, datasets })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `检索数据集：${args.keyword}`,
    kind: 'search',
    rawInput: args,
  }),
})
