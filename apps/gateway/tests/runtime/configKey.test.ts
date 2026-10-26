import { describe, expect, it } from 'vitest'
import { canonicalJson, computeConfigKey } from '../../src/runtime/ConfigKey.js'

const base = {
  skills: ['gis-processing', 'netcdf-analysis'],
  mcpServers: ['data-center', 'gis-service'],
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  systemPrompt: '你是海洋环境分析助手。',
}

describe('runtime/ConfigKey', () => {
  it('skills 顺序无关（同一组能力必须复用同一个运行时）', () => {
    const a = computeConfigKey(base)
    const b = computeConfigKey({ ...base, skills: [...base.skills].reverse() })
    expect(b).toBe(a)
  })

  it('mcpServers 顺序无关', () => {
    const a = computeConfigKey(base)
    const b = computeConfigKey({ ...base, mcpServers: [...base.mcpServers].reverse() })
    expect(b).toBe(a)
  })

  it('对 provider / model / systemPrompt 敏感', () => {
    const key = computeConfigKey(base)
    expect(computeConfigKey({ ...base, provider: 'other' })).not.toBe(key)
    expect(computeConfigKey({ ...base, model: 'deepseek-v4-pro' })).not.toBe(key)
    expect(computeConfigKey({ ...base, systemPrompt: '换一个人设' })).not.toBe(key)
    expect(computeConfigKey({ ...base, skills: [...base.skills, 'extra'] })).not.toBe(key)
    expect(computeConfigKey({ ...base, mcpServers: [] })).not.toBe(key)
  })

  it('稳定：相同输入多次计算结果一致，长度 16 位十六进制', () => {
    const first = computeConfigKey(base)
    const second = computeConfigKey({ ...base })
    expect(second).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
  })

  it('canonicalJson 递归排序对象键，数组保持原序', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}')
    expect(canonicalJson([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]')
    expect(canonicalJson({ x: undefined, y: null })).toBe('{"y":null}')
  })
})
