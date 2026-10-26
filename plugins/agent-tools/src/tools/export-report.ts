/**
 * `export_report` — create one export task for a station report.
 *
 * Risk: high, default action: **ask**. This is the approval demo: the policy plugin
 * blocks on the file control channel until a human answers (or denies on timeout).
 *
 * No real rendering happens here. The tool writes a deterministic task descriptor
 * to `AGENT_STUDIO_OUTPUT_DIR` and reports `{ reportId, path, format, stationId,
 * rows }`; the only timestamp lives inside the written file as `generatedAt`, never
 * in the tool result, so the same input always yields the same output.
 */
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { assertStationAuthorized, requireStation, safeFileToken, writeFileAtomic } from '../data.js'
import { toolsSettings } from '../runtime.js'
import type { BusinessToolMeta } from '../tool-meta.js'

/** Supported export formats. */
export const REPORT_FORMATS = ['pdf', 'xlsx'] as const

/** One report format. */
export type ReportFormat = (typeof REPORT_FORMATS)[number]

/** Catalogue metadata for this tool. */
export const meta: BusinessToolMeta = {
  name: 'export_report',
  title: '导出报表',
  description:
    '为某个监测站生成报表导出任务（不执行真实渲染）。stationId 为站点标识，format 必须是 pdf 或 xlsx。' +
    '该工具属于高风险操作（会生成文件）；站点必须位于授权范围内。是否需要人工确认由调用方（业务端口）决定。',
  risk: 'high',
  defaultAction: 'ask',
  requiresApprovalChannel: true,
  restrictedAllowed: true,
}

/** The registered tool definition. */
export const exportReport = defineTool({
  name: meta.name,
  description: meta.description,
  parameters: {
    stationId: {
      type: 'string',
      required: true,
      description: '站点标识，例如 "ST-001"。',
    },
    format: {
      type: 'string',
      required: true,
      enum: REPORT_FORMATS,
      description: '导出格式：pdf 或 xlsx。',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reportId: { type: 'string', required: true },
        path: { type: 'string', required: true },
        format: { type: 'string', required: true },
        stationId: { type: 'string', required: true },
        rows: { type: 'integer', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  execute(args, exec) {
    if (exec.signal.aborted) throw new Error('调用已取消')
    const stationId = args.stationId.trim()
    if (stationId.length === 0) throw new Error('`stationId` 不能为空')
    const format = args.format
    if (!REPORT_FORMATS.includes(format)) {
      throw new Error(`\`format\` 必须是 ${REPORT_FORMATS.join(' / ')} 之一（实际 ${String(format)}）`)
    }

    const settings = toolsSettings()
    assertStationAuthorized(settings, stationId)
    const station = requireStation(settings, stationId)
    const rows = station.readings.length
    const reportId = `rpt-${safeFileToken(station.id)}-${format}-${rows}`
    const path = join(settings.outputDir, `${reportId}.${format}`)

    const task = {
      reportId,
      stationId: station.id,
      stationName: station.name,
      format,
      rows,
      generatedAt: new Date().toISOString(),
      note: '报表任务描述文件；真实渲染由网关侧导出服务完成。',
    }
    writeFileAtomic(path, `${JSON.stringify(task, null, 2)}\n`)

    return Promise.resolve({ reportId, path, format, stationId: station.id, rows })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `导出报表 ${args.stationId}.${args.format}`,
    kind: 'other',
    rawInput: args,
  }),
})
