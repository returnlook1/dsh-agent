/**
 * 配置指纹（docs/SERVICE.md §2）。
 *
 * `configKey = sha256(canonicalJson({
 *    skills: sorted, mcpServers: sorted, provider, model, systemPrompt,
 *    capabilityRevision
 * })).slice(0, 16)`
 *
 * 稳定性要求：同一组能力必须永远得到同一个 key（顺序无关）；任何影响运行时形态的
 * 字段（provider/model/systemPrompt/**能力版本**）变化都必须得到不同 key
 * （否则会错误复用运行时）。
 *
 * `capabilityRevision` 解决"名字没变但能力变了"的情况：改了 `SKILL.md` 内容、
 * MCP 服务器连接配置、或 profile 模板后，新对话会得到新 key → 新建运行时；
 * 已有对话的快照不变，继续用它启动时的那份能力。
 */
import { createHash } from 'node:crypto'

export interface ConfigKeyInput {
  skills: readonly string[]
  mcpServers: readonly string[]
  provider: string
  model: string
  systemPrompt: string
  /** 能力版本（技能内容/MCP 定义/profile 模板的摘要）；缺省视为空。 */
  capabilityRevision?: string
}

/** 稳定 JSON：对象键递归排序，数组保持原序（调用方负责先排序集合类字段）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/** 计算配置指纹（16 位十六进制）。 */
export function computeConfigKey(input: ConfigKeyInput): string {
  const material = canonicalJson({
    skills: [...input.skills].sort(),
    mcpServers: [...input.mcpServers].sort(),
    provider: input.provider,
    model: input.model,
    systemPrompt: input.systemPrompt,
    capabilityRevision: input.capabilityRevision ?? '',
  })
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16)
}
