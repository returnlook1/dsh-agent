/**
 * `agent-policy` — server-side allow / deny / ask enforcement for restricted agents.
 *
 * Layering (docs/DECISIONS.md §3, docs/IMPL-PLUGINS.md §1):
 * 1. `ctx.tools.guard()` — synchronous, monotonic last line of defence. Deny-all by
 *    default, revocation first, per-process tool-call budget, then the allowlist.
 *    Guards have no "allow" result, so no later listener can turn a denial back
 *    into permission.
 * 2. `tools/pre-execute` — async waterfall. Denies unlisted tools, records the
 *    decision, and for `ask` tools waits on the file control channel and reports a
 *    plain allow/deny. It never returns `kind: 'ask'`: the `sdk` profile has no
 *    approval answerer, so `ask` could only ever resolve to `unavailable` → deny.
 *
 * Runtime imports: Node builtins only. Every `@deepseek-ai/*` import is type-only,
 * so this module can never mint a second Cordis `Context` or a second
 * `ToolRuntime` mirror inside the child process.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

import { appendAuditRecord, assertAuditWritable, createAuditRecord, type AuditIdentity } from './audit.js'
import { assertControlDirUsable, requestApproval } from './approval.js'
import { putDecision } from './bridge.js'
import { PolicyConfigError, type AuditDecision, type PolicySnapshot } from './contracts.js'
import { argumentsDigest, argumentsPreview } from './redact.js'
import { isToolAllowed, loadPolicySnapshot, resolveToolAction } from './policy.js'
import { createRevocationMonitor, MAX_REVOCATION_CACHE_MS, REVOCATION_FILE } from './revocation.js'

/** Plugin name used by Cordis fiber diagnostics. */
export const name = 'agent-policy'

/** Hard service dependency: the policy is expressed on the tool registry. */
export const inject: string[] = ['tools']

/**
 * Optional deployment overrides. Every field defaults to the documented
 * environment variable, so a profile row may pass none of them.
 */
export interface Config {
  /** Absolute path to the read-only policy snapshot. Defaults to `AGENT_STUDIO_POLICY`. */
  readonly policyPath?: string
  /** Control channel directory. Defaults to `AGENT_STUDIO_CONTROL_DIR`, then the snapshot. */
  readonly controlDir?: string
  /** Audit JSONL path. Defaults to `AGENT_STUDIO_AUDIT_PATH`, then the snapshot. */
  readonly auditPath?: string
  /** Overrides the snapshot's `approvalTimeoutMs`. */
  readonly approvalTimeoutMs?: number
  /** Stat cache window for `revoked.json`, clamped to 1000 ms. */
  readonly revocationCacheMs?: number
  /** Injectable clock (tests only). */
  readonly now?: () => number
}

interface Settings {
  readonly snapshot: PolicySnapshot
  readonly controlDir: string
  readonly auditPath: string
  readonly approvalTimeoutMs: number
  readonly identity: AuditIdentity
}

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
  const policyPath = config.policyPath ?? readEnv('AGENT_STUDIO_POLICY')
  if (policyPath === undefined) {
    throw new PolicyConfigError(
      '拒绝启动：未设置策略快照路径。请通过 AGENT_STUDIO_POLICY 指向由网关写入的 policy.json；' +
        '受限 Agent 没有策略快照时不会启动（fail closed）。',
    )
  }

  const snapshot = loadPolicySnapshot(policyPath)

  const controlDir = config.controlDir ?? readEnv('AGENT_STUDIO_CONTROL_DIR') ?? snapshot.controlDir
  const auditPath = config.auditPath ?? readEnv('AGENT_STUDIO_AUDIT_PATH') ?? snapshot.auditPath
  if (auditPath.trim().length === 0) {
    throw new PolicyConfigError('拒绝启动：未配置审计输出路径（AGENT_STUDIO_AUDIT_PATH）')
  }
  assertControlDirUsable(controlDir)
  try {
    mkdirSync(dirname(auditPath), { recursive: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PolicyConfigError(`拒绝启动：审计目录不可写 ${auditPath}（${detail}）`)
  }

  const approvalTimeoutMs =
    config.approvalTimeoutMs ??
    readPositiveIntegerEnv('AGENT_STUDIO_APPROVAL_TIMEOUT_MS') ??
    snapshot.approvalTimeoutMs

  const agentVersionEnv = readPositiveIntegerEnv('AGENT_STUDIO_AGENT_VERSION')
  const identity: AuditIdentity = {
    sessionId: readEnv('AGENT_STUDIO_SESSION_ID') ?? snapshot.sessionId,
    runtimeId: snapshot.runtimeId,
    agentId: readEnv('AGENT_STUDIO_AGENT_ID') ?? snapshot.agentId,
    agentVersion: agentVersionEnv ?? snapshot.agentVersion,
    userId: readEnv('AGENT_STUDIO_USER_ID') ?? snapshot.userId,
  }

  return { snapshot, controlDir, auditPath, approvalTimeoutMs, identity }
}

/**
 * Install the guard and the pre-execute policy.
 * @param ctx plugin context carrying `ctx.tools`.
 * @param config optional overrides; environment variables win otherwise.
 * @throws PolicyConfigError when the snapshot is missing/invalid or the control or
 * audit directories are unusable — the runtime must not start without a policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { snapshot, controlDir, auditPath, approvalTimeoutMs, identity } = resolveSettings(config)
  const now = config.now ?? Date.now
  const revocation = createRevocationMonitor({
    path: join(controlDir, REVOCATION_FILE),
    cacheMs: Math.min(config.revocationCacheMs ?? MAX_REVOCATION_CACHE_MS, MAX_REVOCATION_CACHE_MS),
    now,
  })

  /** In-flight approval waits, keyed by `callId`, so a re-entrant gate cannot double-ask. */
  const pending = new Set<string>()
  /** Process-wide tool-call counter backing `maxToolCalls`. */
  let toolCalls = 0

  // ── 1. Synchronous, monotonic guard: the last word before the tool body. ──────
  // ctx.effect keeps the disposer on the fiber so HMR unload removes the guard.
  ctx.effect(() =>
    ctx.tools.guard((exec) => {
      const revoked = revocation.isRevoked()
      if (revoked.revoked) {
        return `运行已被管理员撤销：${revoked.reason ?? '管理员撤销'}`
      }
      if (exec.agent === undefined) {
        return '缺少 Agent 执行身份'
      }
      toolCalls += 1
      if (snapshot.maxToolCalls > 0 && toolCalls > snapshot.maxToolCalls) {
        return `工具调用次数超过上限(${snapshot.maxToolCalls})`
      }
      if (!isToolAllowed(snapshot, exec.name)) {
        return `工具 ${exec.name} 未获得授权`
      }
      return undefined
    }),
  'agent-policy:guard')

  // ── 2. Extensible async gate: records decisions and runs the approval wait. ──
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    let argumentInfo: { preview: string; digest: string } | undefined
    const args = (): { preview: string; digest: string } => {
      argumentInfo ??= {
        preview: argumentsPreview(exec.arguments),
        digest: argumentsDigest(exec.arguments),
      }
      return argumentInfo
    }

    const record = (decision: AuditDecision, status: 'started' | 'denied' | 'cancelled', error?: string, approvalId?: string): void => {
      const info = args()
      const auditRecord = createAuditRecord(identity, {
        callId: exec.callId,
        tool: exec.name,
        decision,
        status,
        argumentsPreview: info.preview,
        argumentsDigest: info.digest,
        ...(error === undefined ? {} : { error }),
        ...(approvalId === undefined ? {} : { approvalId }),
        at: now(),
      })
      appendAuditRecord(auditPath, auditRecord)
    }

    const deny = (reason: string, decision: AuditDecision = 'deny', status: 'denied' | 'cancelled' = 'denied', approvalId?: string): PreToolDecision => {
      record(decision, status, reason, approvalId)
      putDecision(exec.callId, {
        decision,
        error: reason,
        ...(approvalId === undefined ? {} : { approvalId }),
      })
      return { kind: 'deny', reason, info: { name: 'PolicyError', code: 'POLICY_DENIED' } }
    }

    // Revocation outranks everything else, including the allowlist.
    const revoked = revocation.isRevoked()
    if (revoked.revoked) {
      return deny(`运行已被管理员撤销：${revoked.reason ?? '管理员撤销'}`)
    }
    if (exec.agent === undefined) {
      return deny('缺少 Agent 执行身份')
    }

    const action = resolveToolAction(snapshot, exec.name)

    if (action === 'deny') {
      return deny(`工具 ${exec.name} 未获得授权`)
    }

    if (action === 'allow') {
      // Never short-circuit: call `next()` first so other policy listeners still run.
      const downstream = await next()
      if (downstream.kind === 'allow') {
        record('allow', 'started')
        putDecision(exec.callId, { decision: 'allow' })
      }
      return downstream
    }

    // ── ask ────────────────────────────────────────────────────────────────────
    // A downstream veto is authoritative and must not be softened into an approval.
    const downstream = await next()
    if (downstream.kind !== 'allow') {
      return downstream
    }

    if (pending.has(exec.callId)) {
      return deny(`工具 ${exec.name} 的审批请求重复进入（callId=${exec.callId}）`)
    }
    pending.add(exec.callId)
    try {
      const info = args()
      const outcome = await requestApproval({
        controlDir,
        tool: exec.name,
        callId: exec.callId,
        description: `工具 ${exec.name} 需要人工审批（agent=${identity.agentId}, session=${identity.sessionId}）`,
        argumentsPreview: info.preview,
        argumentsDigest: info.digest,
        timeoutMs: approvalTimeoutMs,
        signal: exec.signal,
        now,
      })

      if (outcome.verdict === 'allowed-once') {
        record('approved', 'started', undefined, outcome.approvalId)
        putDecision(exec.callId, { decision: 'approved', approvalId: outcome.approvalId })
        return downstream
      }

      if (outcome.verdict === 'cancelled') {
        record('cancelled', 'cancelled', outcome.reason, outcome.approvalId)
        putDecision(exec.callId, {
          decision: 'cancelled',
          error: outcome.reason ?? '调用在等待审批期间被取消',
          approvalId: outcome.approvalId,
        })
        // `cancel` selects the registry's canonical pre-dispatch cancellation result.
        return { kind: 'cancel' }
      }

      if (outcome.verdict === 'timeout') {
        return deny(outcome.reason ?? `工具 ${exec.name} 等待审批超时`, 'expired', 'denied', outcome.approvalId)
      }
      if (outcome.verdict === 'unavailable') {
        return deny(outcome.reason ?? `工具 ${exec.name} 无法进入审批通道`, 'deny', 'denied', outcome.approvalId)
      }
      return deny(outcome.reason ?? `工具 ${exec.name} 的审批被拒绝`, 'rejected', 'denied', outcome.approvalId)
    } finally {
      pending.delete(exec.callId)
    }
  })

  // Fail fast when decisions cannot be recorded: a call that runs without a
  // decision line is an unauditable call, so the runtime must not start.
  try {
    assertAuditWritable(auditPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PolicyConfigError(`拒绝启动：审计文件不可写 ${auditPath}（${detail}）`)
  }
}
