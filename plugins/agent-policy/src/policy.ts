/**
 * Policy snapshot loading and the allow / deny / ask matcher.
 *
 * Matcher precedence is fail closed: any matching `deny` entry wins, then any
 * matching `ask`, then `allow`, and an unmatched tool is denied. Mapping order in
 * the snapshot therefore cannot widen a permission by accident — the most
 * restrictive matching action always wins.
 *
 * Patterns support a trailing `*` (`mcp__water__*`) for both allow/ask and deny
 * entries; a deny wildcard that an allow wildcard overlaps still denies.
 */
import { readFileSync } from 'node:fs'

import { parsePolicySnapshot, PolicyConfigError, type PolicySnapshot, type ToolAction } from './contracts.js'

/** Whether one snapshot pattern selects a tool name. */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true
  if (!pattern.endsWith('*')) return false
  return toolName.startsWith(pattern.slice(0, -1))
}

/**
 * Effective action for one tool name.
 * @returns `deny` when nothing matches (the restricted-Agent default).
 */
export function resolveToolAction(snapshot: PolicySnapshot, toolName: string): ToolAction {
  let sawAllow = false
  let sawAsk = false
  for (const [pattern, action] of Object.entries(snapshot.tools)) {
    if (!matchesToolPattern(pattern, toolName)) continue
    if (action === 'deny') return 'deny'
    if (action === 'ask') sawAsk = true
    else sawAllow = true
  }
  if (sawAsk) return 'ask'
  if (sawAllow) return 'allow'
  return snapshot.defaultAction
}

/** Whether a tool may run at all (allow or ask-only), used by the synchronous guard. */
export function isToolAllowed(snapshot: PolicySnapshot, toolName: string): boolean {
  return resolveToolAction(snapshot, toolName) !== 'deny'
}

/**
 * Read, parse and validate one policy snapshot.
 *
 * Throws {@link PolicyConfigError} for a missing/unreadable/malformed snapshot:
 * the plugin refuses to load instead of running without a policy.
 */
export function loadPolicySnapshot(policyPath: string): PolicySnapshot {
  if (policyPath.trim().length === 0) {
    throw new PolicyConfigError('拒绝启动：未配置策略快照路径（AGENT_STUDIO_POLICY）')
  }
  let raw: string
  try {
    raw = readFileSync(policyPath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PolicyConfigError(`拒绝启动：策略快照不可读 ${policyPath}（${detail}）`, policyPath)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PolicyConfigError(`拒绝启动：策略快照不是合法 JSON ${policyPath}（${detail}）`, policyPath)
  }
  try {
    return parsePolicySnapshot(parsed)
  } catch (error) {
    if (error instanceof PolicyConfigError) {
      throw new PolicyConfigError(`拒绝启动：策略快照校验失败 ${policyPath}：${error.message}`, policyPath)
    }
    throw error
  }
}
