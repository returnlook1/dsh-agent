/**
 * 工具结果的展示辅助（纯函数，可在浏览器 / 单测中复用）。
 *
 * SSE 的 `tool.completed.result` 是未知 JSON：这里只做展示窄化，
 * 不假设任何业务工具的具体 schema。
 */

/** JSON 美化；遇到循环引用 / BigInt 等不可序列化值时退回 String()。 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

export interface MapFlyToSummary {
  action: 'flyTo'
  longitude: number
  latitude: number
  zoom: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 窄化 `{ action: 'flyTo', longitude, latitude, zoom }`。 */
export function parseMapFlyTo(value: unknown): MapFlyToSummary | null {
  if (!isRecord(value)) return null
  if (value['action'] !== 'flyTo') return null
  const longitude = readFiniteNumber(value, 'longitude')
  const latitude = readFiniteNumber(value, 'latitude')
  const zoom = readFiniteNumber(value, 'zoom')
  if (longitude === null || latitude === null || zoom === null) return null
  return { action: 'flyTo', longitude, latitude, zoom }
}

/** 地图动作摘要；不是 flyTo 结果时返回 null。 */
export function formatMapAction(value: unknown): string | null {
  const summary = parseMapFlyTo(value)
  if (summary === null) return null
  return `地图动作：定位到 (${summary.longitude}, ${summary.latitude})，缩放 ${summary.zoom}`
}

export interface TextPreview {
  text: string
  truncated: boolean
}

/**
 * 文本结果预览：`resultText` 本身最多 4KB，这里再按字符数截断，
 * 避免超长单行把工具卡片撑坏。
 */
export function previewResultText(raw: string, maxChars = 2000): TextPreview {
  if (raw.length <= maxChars) return { text: raw, truncated: false }
  return { text: raw.slice(0, maxChars), truncated: true }
}
