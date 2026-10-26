/**
 * `query_station` — read one station's trailing history.
 *
 * Risk: low, default action: allow. `days` is 1..30 and is validated *inside*
 * `execute`: the parameter DSL has no numeric bounds (docs/RESEARCH-TOOLS.md §1d).
 * The station id is additionally checked against `AGENT_STUDIO_ALLOWED_STATIONS`,
 * which is the L3 "allowed tool ≠ allowed data" enforcement point.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { assertStationAuthorized, requireStation } from '../data.js'
import { toolsSettings } from '../runtime.js'
import type { BusinessToolMeta } from '../tool-meta.js'

/** Lowest accepted `days` value. */
export const MIN_DAYS = 1

/** Highest accepted `days` value. */
export const MAX_DAYS = 30

/** Catalogue metadata for this tool. */
export const meta: BusinessToolMeta = {
  name: 'query_station',
  title: '查询监测站',
  description:
    '查询某个监测站的近期监测数据。stationId 为站点标识；days 为返回的最近天数，' +
    `必须是 ${MIN_DAYS}..${MAX_DAYS} 的整数（不足时返回全部可用数据）。` +
    '只在站点位于授权范围内时可用。',
  risk: 'low',
  defaultAction: 'allow',
  requiresApprovalChannel: false,
  restrictedAllowed: true,
}

/** The registered tool definition. */
export const queryStation = defineTool({
  name: meta.name,
  description: meta.description,
  parameters: {
    stationId: {
      type: 'string',
      required: true,
      description: '站点标识，例如 "ST-001"。',
    },
    // The DSL has no min/max, so the 1..30 bound is asserted in execute().
    days: {
      type: 'integer',
      required: true,
      description: `返回最近多少天的数据，${MIN_DAYS}..${MAX_DAYS}。`,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stationId: { type: 'string', required: true },
        stationName: { type: 'string', required: true },
        days: { type: 'integer', required: true },
        samples: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              day: { type: 'string', required: true },
              value: { type: 'number', required: true },
            },
          },
        },
        source: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  execute(args, exec) {
    if (exec.signal.aborted) throw new Error('调用已取消')
    const stationId = args.stationId.trim()
    if (stationId.length === 0) throw new Error('`stationId` 不能为空')
    if (!Number.isInteger(args.days)) {
      throw new Error(`\`days\` 必须是整数（实际 ${String(args.days)}）`)
    }
    if (args.days < MIN_DAYS || args.days > MAX_DAYS) {
      throw new Error(`\`days\` 必须在 ${MIN_DAYS}..${MAX_DAYS} 之间（实际 ${args.days}）`)
    }

    const settings = toolsSettings()
    assertStationAuthorized(settings, stationId)
    const station = requireStation(settings, stationId)
    const samples = station.readings.slice(Math.max(station.readings.length - args.days, 0)).map((reading) => ({
      day: reading.day,
      value: reading.value,
    }))

    return Promise.resolve({
      stationId: station.id,
      stationName: station.name,
      days: samples.length,
      samples,
      source: 'local',
    })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `查询站点 ${args.stationId}（${args.days} 天）`,
    kind: 'read',
    rawInput: args,
  }),
})
