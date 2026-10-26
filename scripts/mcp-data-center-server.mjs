#!/usr/bin/env node
/**
 * 示例 MCP 服务器（stdio，换行分隔 JSON-RPC 2.0）。
 *
 * 用途：给 Agent Service 的 MCP 能力提供一个**可离线运行**的真实服务器，
 * 让"按对话选择 MCP 服务器 → 模型调用 mcp__<server>__<tool>"这条链路可以被验证，
 * 而不依赖任何外部系统。
 *
 * 支持的方法：
 *   initialize              握手
 *   notifications/initialized  客户端确认（无响应）
 *   tools/list              列出工具
 *   tools/call              调用工具
 *   ping                    健康检查
 *
 * 工具：
 *   search_dataset(keyword)    按关键词检索数据集目录
 *   get_dataset_meta(datasetId) 读取数据集元信息
 *   get_flow_field(region, date) 返回某区域某日的流场摘要（演示业务数据）
 *
 * 用法（由 dsh-mcp-client 拉起，一般不需要手工运行）：
 *   node scripts/mcp-data-center-server.mjs
 */
import process from 'node:process'
import { createInterface } from 'node:readline'

/** 模拟的数据集目录：确定性、无网络、无文件依赖。 */
const DATASETS = [
  {
    id: 'ocean-flow-2026',
    name: '长江口流场再分析数据',
    keywords: ['流场', '长江口', '海洋', '再分析', 'flow', 'ocean'],
    variables: ['u', 'v', 'w', 'zeta', 'temp', 'salt'],
    temporal: { from: '2026-01-01', to: '2026-10-25', step: '1h' },
    spatial: { type: 'curvilinear', grid: '900 x 600', resolution: '300m' },
    format: 'NetCDF-4',
    sizeGb: 412,
  },
  {
    id: 'sediment-2025',
    name: '近岸悬沙浓度观测数据',
    keywords: ['悬沙', '泥沙', '近岸', 'sediment'],
    variables: ['ssc', 'depth', 'velocity'],
    temporal: { from: '2025-03-01', to: '2025-12-31', step: '1d' },
    spatial: { type: 'regular', grid: '220 x 180', resolution: '1km' },
    format: 'NetCDF-4',
    sizeGb: 37,
  },
  {
    id: 'station-water-quality',
    name: '水质监测站逐日数据',
    keywords: ['水质', '监测站', 'water', 'quality'],
    variables: ['ph', 'dissolvedOxygen', 'codmn', 'ammoniaNitrogen', 'totalPhosphorus'],
    temporal: { from: '2021-01-01', to: '2026-10-25', step: '1d' },
    spatial: { type: 'points', grid: '6 stations', resolution: 'point' },
    format: 'CSV / JSON',
    sizeGb: 2,
  },
]

const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'search_dataset',
    description: '按关键词检索数据中心的数据集目录，返回匹配的数据集摘要。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '检索关键词，例如“流场”“泥沙”“长江口”' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_dataset_meta',
    description: '读取某个数据集的元信息（变量、时间范围、空间网格、格式、体量）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        datasetId: { type: 'string', description: '数据集 id，例如 ocean-flow-2026' },
      },
      required: ['datasetId'],
    },
  },
  {
    name: 'get_flow_field',
    description: '返回指定区域某日的流场摘要（平均流速、主流向、最大流速）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        region: { type: 'string', description: '区域名称，例如“长江口”' },
        date: { type: 'string', description: '日期，格式 YYYY-MM-DD' },
      },
      required: ['region', 'date'],
    },
  },
]

/** 确定性哈希，保证同一输入返回同一摘要。 */
function hash(text) {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

function searchDataset(args) {
  const keyword = String(args?.keyword ?? '').trim()
  if (keyword.length === 0) throw new Error('keyword 不能为空')
  const lowered = keyword.toLowerCase()
  const matched = DATASETS.filter(
    (dataset) =>
      dataset.name.toLowerCase().includes(lowered) ||
      dataset.keywords.some((word) => word.toLowerCase().includes(lowered) || lowered.includes(word.toLowerCase())),
  )
  return {
    keyword,
    matches: matched.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      format: dataset.format,
      variables: dataset.variables,
      timeRange: `${dataset.temporal.from} ~ ${dataset.temporal.to}`,
    })),
    hint: matched.length === 0 ? '没有匹配的数据集，可尝试换用更宽泛的关键词' : undefined,
  }
}

function getDatasetMeta(args) {
  const datasetId = String(args?.datasetId ?? '').trim()
  const dataset = DATASETS.find((item) => item.id === datasetId)
  if (dataset === undefined) {
    throw new Error(`未知数据集 ${datasetId}；可用：${DATASETS.map((item) => item.id).join(', ')}`)
  }
  return dataset
}

function getFlowField(args) {
  const region = String(args?.region ?? '').trim()
  const date = String(args?.date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 必须是 YYYY-MM-DD')
  const seed = hash(`${region}:${date}`)
  const speed = 0.4 + (seed % 160) / 100
  const direction = (seed % 360).toFixed(0)
  return {
    region,
    date,
    meanSpeedMs: Number(speed.toFixed(2)),
    maxSpeedMs: Number((speed * 1.63).toFixed(2)),
    dominantDirectionDeg: Number(direction),
    unit: 'm/s',
    source: 'ocean-flow-2026',
    note: '演示数据，非真实观测',
  }
}

const HANDLERS = {
  search_dataset: searchDataset,
  get_dataset_meta: getDatasetMeta,
  get_flow_field: getFlowField,
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function handle(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'data-center', version: '1.0.0' },
      })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      respond(id, {})
      return
    case 'tools/list':
      respond(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const name = params?.name
      const handler = HANDLERS[name]
      if (handler === undefined) {
        fail(id, -32602, `未知工具 ${name}`)
        return
      }
      try {
        const value = handler(params?.arguments ?? {})
        respond(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          isError: false,
        })
      } catch (error) {
        respond(id, {
          content: [{ type: 'text', text: `Error: ${error?.message ?? String(error)}` }],
          isError: true,
        })
      }
      return
    }
    default:
      if (id !== undefined) fail(id, -32601, `未实现的方法 ${method}`)
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    fail(null, -32700, 'JSON 解析失败')
    return
  }
  try {
    handle(message)
  } catch (error) {
    if (message?.id !== undefined) fail(message.id, -32603, error?.message ?? String(error))
  }
})
reader.on('close', () => process.exit(0))

process.stderr.write('[mcp-data-center] ready\n')
