/**
 * Tolerant policy-snapshot loading for the audit plugin.
 *
 * The audit plugin is *not* the enforcement point, so an unreadable snapshot must
 * never break tool execution: it degrades to the environment-variable identity and
 * still writes a schema-shaped record. (`agent-policy` is the plugin that refuses
 * to start without a policy.)
 */
import { readFileSync } from 'node:fs'

import { parsePolicySnapshot, PolicyConfigError, type PolicySnapshot } from './contracts.js'

/** Read + validate a snapshot, or `undefined` when it is absent/unreadable/invalid. */
export function tryLoadPolicySnapshot(policyPath: string | undefined): PolicySnapshot | undefined {
  if (policyPath === undefined || policyPath.trim().length === 0) return undefined
  let raw: string
  try {
    raw = readFileSync(policyPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    return parsePolicySnapshot(JSON.parse(raw))
  } catch (error) {
    if (error instanceof PolicyConfigError) return undefined
    return undefined
  }
}
