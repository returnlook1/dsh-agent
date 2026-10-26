/**
 * 工具结果展示辅助单测：地图动作摘要与文本截断。
 */
import { describe, expect, it } from 'vitest'

import {
  formatMapAction,
  parseMapFlyTo,
  prettyJson,
  previewResultText,
} from '../src/utils/tool-result'

describe('地图动作摘要', () => {
  it('识别 flyTo 并生成一行摘要', () => {
    const result = { action: 'flyTo', longitude: 121.5, latitude: 31.2, zoom: 8 }
    expect(parseMapFlyTo(result)).toEqual(result)
    expect(formatMapAction(result)).toBe('地图动作：定位到 (121.5, 31.2)，缩放 8')
  })

  it('非 flyTo / 字段缺失 / 非数字时不误报', () => {
    expect(formatMapAction({ action: 'zoomTo', longitude: 1, latitude: 2, zoom: 3 })).toBeNull()
    expect(formatMapAction({ action: 'flyTo', longitude: '121.5', latitude: 31.2, zoom: 8 })).toBeNull()
    expect(formatMapAction({ action: 'flyTo', longitude: 1, latitude: 2 })).toBeNull()
    expect(formatMapAction(null)).toBeNull()
    expect(formatMapAction([1, 2])).toBeNull()
  })
})

describe('结果文本与 JSON 展示', () => {
  it('结构化结果美化；不可序列化时退回 String()', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}')
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(prettyJson(cyclic)).toBe('[object Object]')
  })

  it('超长 resultText 截断展示', () => {
    const text = 'x'.repeat(2500)
    const preview = previewResultText(text, 2000)
    expect(preview.truncated).toBe(true)
    expect(preview.text).toHaveLength(2000)
    expect(previewResultText('short').truncated).toBe(false)
  })
})
