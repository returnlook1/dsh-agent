/**
 * `agent-audit` — durable JSONL audit trail for tool calls.
 *
 * The child process never touches the database: it appends one line per event to
 * `AGENT_STUDIO_AUDIT_PATH`, and the gateway tails that file (docs/DECISIONS.md §5).
 *
 * Two lines per call, as the contract prescribes:
 * - `agent-policy` writes the decision line (`status: started | denied`);
 * - this plugin writes the result line (`status: succeeded | failed`).
 *
 * Timing comes from a `callId → startedAt` map filled in `tools/pre-execute`; the
 * registry exposes no duration field (docs/RESEARCH-TOOLS.md §7.1). `tools/result`
 * is an `emit` (synchronous, contained, cannot change the outcome), so the write
 * is a single `appendFileSync` and every failure is downgraded to stderr.
 *
 * Runtime imports: Node builtins only. Every `@deepseek-ai/*` import is type-only.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

import { appendAuditRecordBestEffort, createAuditRecord, type AuditIdentity } from './audit.js'
import { takeDecision } from './bridge.js'
import type { AuditDecision } from './contracts.js'
import { argumentsDigest, argumentsPreview } from './redact.js'
import { tryLoadPolicySnapshot } from './snapshot.js'

/** Plugin name used by Cordis fiber diagnostics. */
export const name = 'agent-audit'

/** Hard service dependency: the audit is expressed on the tool hooks. */
export const inject: string[] = ['tools']

/** Optional deployment overrides; every field defaults to a documented env var. */
export interface Config {
  /** Audit JSONL path. Defaults to `AGENT_STUDIO_AUDIT_PATH`, then the policy snapshot. */
  readonly auditPath?: string
  /** Policy snapshot path used for identity fallbacks. Defaults to `AGENT_STUDIO_POLICY`. */
  readonly policyPath?: string
  /** Injectable clock (tests only). */
  readonly now?: () => number
}

interface Settings {
  /** Absent = audit disabled; execution must continue unaffected. */
  readonly auditPath: string | undefined
  readonly identity: AuditIdentity
  readonly now: () => number
}

/** Upper bound on retained start timestamps / blocked markers. */
const MAX_TRACKED_CALLS = 1024

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = readEnv(name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function resolveSettings(config: Config): Settings {
  const now = config.now ?? Date.now
  const snapshot = tryLoadPolicySnapshot(config.policyPath ?? readEnv('AGENT_STUDIO_POLICY'))
  const auditPath = config.auditPath ?? readEnv('AGENT_STUDIO_AUDIT_PATH') ?? snapshot?.auditPath
  const identity: AuditIdentity = {
    sessionId: readEnv('AGENT_STUDIO_SESSION_ID') ?? snapshot?.sessionId ?? '',
    runtimeId: snapshot?.runtimeId ?? '',
    agentId: readEnv('AGENT_STUDIO_AGENT_ID') ?? snapshot?.agentId ?? '',
    agentVersion: readPositiveIntegerEnv('AGENT_STUDIO_AGENT_VERSION') ?? snapshot?.agentVersion ?? 0,
    userId: readEnv('AGENT_STUDIO_USER_ID') ?? snapshot?.userId ?? '',
  }
  return { auditPath, identity, now }
}

/** Drop the oldest entry once a tracking map/set exceeds its bound. */
function evictOldest<T>(map: Map<string, T>): void {
  while (map.size > MAX_TRACKED_CALLS) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
  }
}

/** Decisions that end a call before it executes and are already audited by policy. */
function isDenialDecision(decision: AuditDecision): boolean {
  return (
    decision === 'deny' ||
    decision === 'rejected' ||
    decision === 'cancelled' ||
    decision === 'expired'
  )
}

/**
 * Install the audit observers.
 * @param ctx plugin context carrying `ctx.tools` hooks.
 * @param config optional overrides; environment variables win otherwise.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { auditPath, identity, now } = resolveSettings(config)
  if (auditPath === undefined) {
    process.stderr.write(
      '[agent-audit] 未配置审计输出路径（AGENT_STUDIO_AUDIT_PATH），审计仅降级为不写入；工具执行不受影响\n',
    )
  }

  /** callId → start timestamp, filled by pre-execute and consumed by the result hook. */
  const startedAt = new Map<string, number>()
  /** callIds already recorded by the post-execute block branch (avoids a double line). */
  const blocked = new Set<string>()

  // 1. Start times. Must not alter the decision: delegate straight to `next()`.
  ctx.on('tools/pre-execute', async (exec, next) => {
    startedAt.set(exec.callId, now())
    evictOldest(startedAt)
    return await next()
  })

  // 2. Post-execute: only observable effect is the `block` verdict.
  ctx.on('tools/post-execute', async (exec: ToolExecution, _result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind === 'block') {
      const began = startedAt.get(exec.callId)
      startedAt.delete(exec.callId)
      blocked.add(exec.callId)
      while (blocked.size > MAX_TRACKED_CALLS) {
        const oldest = blocked.values().next()
        if (oldest.done === true) break
        blocked.delete(oldest.value)
      }
      const bridge = takeDecision(exec.callId)
      const approvalId = bridge?.approvalId
      if (auditPath !== undefined) {
        appendAuditRecordBestEffort(auditPath, createAuditRecord(identity, {
          callId: exec.callId,
          tool: exec.name,
          decision: bridge?.decision ?? 'deny',
          status: 'failed',
          argumentsPreview: argumentsPreview(exec.arguments),
          argumentsDigest: argumentsDigest(exec.arguments),
          error: 'blocked by post-execute policy',
          ...(began === undefined ? {} : { durationMs: now() - began }),
          ...(approvalId === undefined ? {} : { approvalId }),
          at: now(),
        }))
      }
    }
    return decision
  })

  // 3. Final outcome. `emit` semantics: must not throw and must not block the
  //    pipeline, hence one contained append.
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    try {
      const began = startedAt.get(exec.callId)
      startedAt.delete(exec.callId)
      // A block verdict was already recorded by the post-execute branch.
      if (blocked.delete(exec.callId)) return
      if (auditPath === undefined) return

      const bridge = takeDecision(exec.callId)
      const approvalId = bridge?.approvalId
      // A policy-level denial already wrote its authoritative record (decision +
      // status=denied + reason) before the call reached the registry's pipeline.
      // Writing a second "failed" line for the same call would double-count it in
      // the audit table and misreport it as an execution failure.
      if (bridge !== undefined && isDenialDecision(bridge.decision)) return
      const decision: AuditDecision = bridge?.decision ?? (result.isError ? 'deny' : 'allow')
      const error = result.isError ? result.error.message : undefined
      appendAuditRecordBestEffort(auditPath, createAuditRecord(identity, {
        callId: exec.callId,
        tool: exec.name,
        decision,
        status: result.isError ? 'failed' : 'succeeded',
        argumentsPreview: argumentsPreview(exec.arguments),
        argumentsDigest: argumentsDigest(exec.arguments),
        ...(error === undefined ? {} : { error }),
        ...(began === undefined ? {} : { durationMs: now() - began }),
        ...(approvalId === undefined ? {} : { approvalId }),
        at: now(),
      }))
    } catch (error) {
      // Never propagate: `tools/result` failures must not affect the call outcome.
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[agent-audit] 结果记录失败（${detail}）\n`)
    }
    return undefined
  })
}
