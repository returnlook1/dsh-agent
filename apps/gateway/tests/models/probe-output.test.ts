/**
 * 探针输出解析：容错但不猜测。
 *
 * 探针在 DSH 子进程里运行，输出是"跨进程契约"，所以这里对形状做严格校验：
 * 坏条目丢弃、缺 models 记日志、整体不是对象则抛错（上层降级到缓存）。
 */
import { describe, expect, it } from 'vitest'
import { parseProbeOutput } from '../../src/models/ModelDiscovery.js'
import { silentLogger } from '../../src/logger.js'

const logger = silentLogger

describe('parseProbeOutput', () => {
  it('解析标准输出（含 contextWindow / description / provider 级 error）', () => {
    const providers = parseProbeOutput(
      {
        probedAt: 1,
        providers: [
          {
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [
              { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
              { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '更强', contextWindow: 0 },
            ],
          },
          { id: 'broken', name: '', models: [], error: '401 unauthorized' },
        ],
      },
      logger,
    )

    expect(providers).toHaveLength(2)
    expect(providers[0]).toMatchObject({
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '更强' },
      ],
    })
    expect(providers[1]).toMatchObject({ id: 'broken', name: 'broken', models: [], error: '401 unauthorized' })
  })

  it('丢弃没有 id 的 provider / model', () => {
    const providers = parseProbeOutput({
      providers: [
        { name: 'no id', models: [{ id: 'm1' }] },
        { id: 'ok', models: [{ id: 'm1' }, { name: 'no id model' }, null, 'x'] },
      ],
    })
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ id: 'ok', models: [{ id: 'm1', name: 'm1' }] })
  })

  it('provider 缺少 models 数组时记 warn 并当作空清单', () => {
    const warnings: unknown[] = []
    const providers = parseProbeOutput(
      { providers: [{ id: 'p', name: 'P' }] },
      { ...logger, warn: (...args: unknown[]) => warnings.push(args) } as unknown as typeof logger,
    )
    expect(providers).toEqual([{ id: 'p', name: 'P', models: [] }])
    expect(warnings).toHaveLength(1)
  })

  it('整体形状不对时抛错（调用方降级到缓存）', () => {
    expect(() => parseProbeOutput(null)).toThrow()
    expect(() => parseProbeOutput({})).toThrow(/providers/)
    expect(() => parseProbeOutput({ providers: 'nope' })).toThrow(/providers/)
  })
})
