/**
 * `map_fly_to` — ask the前端地图组件 to fly to one coordinate.
 *
 * Risk: low, default action: allow. Purely a UI intent: the tool returns the
 * normalized camera instruction and never touches the network or the map itself.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { toolsSettings } from '../runtime.js'
import type { BusinessToolMeta } from '../tool-meta.js'

/** Lowest accepted `zoom`. */
export const MIN_ZOOM = 1

/** Highest accepted `zoom`. */
export const MAX_ZOOM = 18

/** Zoom applied when the caller omits it. */
export const DEFAULT_ZOOM = 8

/** Catalogue metadata for this tool. */
export const meta: BusinessToolMeta = {
  name: 'map_fly_to',
  title: '地图定位',
  description:
    '让前端地图组件飞到指定坐标。longitude 为经度（-180..180），latitude 为纬度（-90..90），' +
    `zoom 为可选缩放级别（${MIN_ZOOM}..${MAX_ZOOM}，默认 ${DEFAULT_ZOOM}）。不访问网络。`,
  risk: 'low',
  defaultAction: 'allow',
  requiresApprovalChannel: false,
  restrictedAllowed: true,
}

/** The registered tool definition. */
export const mapFlyTo = defineTool({
  name: meta.name,
  description: meta.description,
  parameters: {
    longitude: {
      type: 'number',
      required: true,
      description: '经度，-180..180。',
    },
    latitude: {
      type: 'number',
      required: true,
      description: '纬度，-90..90。',
    },
    zoom: {
      type: 'integer',
      default: DEFAULT_ZOOM,
      description: `可选缩放级别，${MIN_ZOOM}..${MAX_ZOOM}。`,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', required: true },
        longitude: { type: 'number', required: true },
        latitude: { type: 'number', required: true },
        zoom: { type: 'integer', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  execute(args, exec) {
    if (exec.signal.aborted) throw new Error('调用已取消')
    const { longitude, latitude } = args
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(`\`longitude\` 必须在 -180..180 之间（实际 ${String(longitude)}）`)
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error(`\`latitude\` 必须在 -90..90 之间（实际 ${String(latitude)}）`)
    }
    const zoom = args.zoom ?? DEFAULT_ZOOM
    if (!Number.isInteger(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) {
      throw new Error(`\`zoom\` 必须是 ${MIN_ZOOM}..${MAX_ZOOM} 的整数（实际 ${String(zoom)}）`)
    }
    // Settings are read so a misconfigured deployment fails loudly instead of
    // silently acting on a stale default; this tool itself needs no fixture.
    toolsSettings()
    return Promise.resolve({ action: 'flyTo', longitude, latitude, zoom })
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `地图定位 ${args.latitude}, ${args.longitude}`,
    kind: 'other',
    rawInput: args,
  }),
})
