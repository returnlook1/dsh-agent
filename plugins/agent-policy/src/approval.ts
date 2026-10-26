/**
 * Fail-closed approval over the on-disk control channel.
 *
 * Why not `PreToolDecision.kind: 'ask'`: `0.2.1-rc.3` has no answerer in the `sdk`
 * profile (`approval/request` has no listener) and no server→client request
 * channel on the SDK wire, so `ask` can only ever resolve to `unavailable` → deny
 * (docs/RESEARCH-TOOLS.md §5.4, docs/RESEARCH-SDK.md §5). This module implements
 * the wait itself and reports a plain `allow`/`deny` to the registry.
 *
 * Protocol (docs/DECISIONS.md §4):
 *   <controlDir>/approvals/<approvalId>.request.json    ← this plugin writes
 *   <controlDir>/approvals/<approvalId>.decision.json   ← the gateway writes
 *
 * Everything here is fail closed:
 * - no control directory / unwritable request file → deny;
 * - malformed or mismatched decision record → denied (never "allow");
 * - deadline reached → deny;
 * - `exec.signal` aborted → `cancel` (the registry maps it to its canonical
 *   pre-dispatch cancellation result), and the request file is removed.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomic } from './atomic.js'
import {
  parseApprovalDecisionRecord,
  PolicyConfigError,
  type ApprovalDecisionRecord,
  type ApprovalRequest,
} from './contracts.js'

/** Approval sub-directory inside the control directory. */
export const APPROVALS_DIR = 'approvals'

/** Poll cadence while waiting for a decision file (docs/IMPL-PLUGINS.md §1.2 → 100ms). */
export const DEFAULT_POLL_INTERVAL_MS = 100

/** File name of one pending request. */
export function approvalRequestFileName(approvalId: string): string {
  return `${approvalId}.request.json`
}

/** File name of one gateway decision. */
export function approvalDecisionFileName(approvalId: string): string {
  return `${approvalId}.decision.json`
}

/** Terminal verdict of one approval wait. */
export type ApprovalVerdict = 'allowed-once' | 'rejected' | 'cancelled' | 'timeout' | 'unavailable'

/** Outcome of one approval wait. */
export interface ApprovalOutcome {
  readonly verdict: ApprovalVerdict
  readonly approvalId: string
  readonly waitedMs: number
  readonly reason?: string
}

/** Inputs for {@link requestApproval}. */
export interface RequestApprovalOptions {
  /** Absolute control directory; `approvals/` is created underneath it. */
  readonly controlDir: string
  readonly tool: string
  readonly callId: string
  readonly description: string
  readonly argumentsPreview: string
  readonly argumentsDigest: string
  /** Hard deadline; `<= 0` denies immediately. */
  readonly timeoutMs: number
  /** Caller-owned cancellation signal; never ignored. */
  readonly signal: AbortSignal
  /** Injectable clock, for deterministic deadline tests. */
  readonly now?: () => number
  /** Poll cadence override. */
  readonly pollIntervalMs?: number
}

/** Abortable sleep: resolves early when `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function readDecision(path: string): ApprovalDecisionRecord | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return parseApprovalDecisionRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * Ask the control channel for one verdict and wait for it.
 *
 * Always resolves (never rejects) and always removes the request file it wrote.
 * @param options identity, deadline, signal and previews for the request.
 * @returns the verdict plus the id the gateway saw.
 */
export async function requestApproval(options: RequestApprovalOptions): Promise<ApprovalOutcome> {
  const now = options.now ?? Date.now
  const approvalId = randomUUID()
  const startedAt = now()
  const deadline = startedAt + options.timeoutMs
  const approvalsDir = join(options.controlDir, APPROVALS_DIR)
  const requestPath = join(approvalsDir, approvalRequestFileName(approvalId))
  const decisionPath = join(approvalsDir, approvalDecisionFileName(approvalId))
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)

  const deny = (verdict: ApprovalVerdict, reason: string): ApprovalOutcome => ({
    verdict,
    approvalId,
    waitedMs: now() - startedAt,
    reason,
  })

  if (options.timeoutMs <= 0) {
    return deny('unavailable', `工具 ${options.tool} 需要审批，但审批超时配置无效`)
  }

  const request: ApprovalRequest = {
    approvalId,
    callId: options.callId,
    tool: options.tool,
    description: options.description,
    argumentsPreview: options.argumentsPreview,
    argumentsDigest: options.argumentsDigest,
    requestedAt: startedAt,
    expiresAt: deadline,
  }

  try {
    mkdirSync(approvalsDir, { recursive: true })
    writeFileAtomic(requestPath, `${JSON.stringify(request, null, 2)}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return deny('unavailable', `工具 ${options.tool} 需要审批，但审批请求无法写入控制通道（${detail}）`)
  }

  try {
    for (;;) {
      if (options.signal.aborted) {
        return deny('cancelled', `工具 ${options.tool} 的调用在等待审批期间被取消`)
      }

      const record = readDecision(decisionPath)
      if (record !== undefined) {
        if (record.approvalId !== approvalId) {
          return deny('rejected', `工具 ${options.tool} 的审批决定与请求不匹配`)
        }
        if (record.decision === 'allowed-once') {
          return { verdict: 'allowed-once', approvalId, waitedMs: now() - startedAt }
        }
        if (record.decision === 'cancelled') {
          return deny('cancelled', record.reason ?? `工具 ${options.tool} 的审批被取消`)
        }
        return deny('rejected', record.reason ?? `工具 ${options.tool} 的审批被拒绝`)
      }

      if (now() >= deadline) {
        return deny('timeout', `工具 ${options.tool} 等待审批超时（${options.timeoutMs}ms）`)
      }

      const remaining = deadline - now()
      await sleep(Math.min(pollIntervalMs, Math.max(remaining, 1)), options.signal)
    }
  } finally {
    try {
      rmSync(requestPath, { force: true })
    } catch {
      // Cleanup is best effort; a leaked request file is expired by the gateway.
    }
  }
}

/** Read a decision file without waiting; exposed for tests and diagnostics. */
export function peekApprovalDecision(controlDir: string, approvalId: string): ApprovalDecisionRecord | undefined {
  return readDecision(join(controlDir, APPROVALS_DIR, approvalDecisionFileName(approvalId)))
}

/** Validate that a control directory is usable before the runtime starts serving. */
export function assertControlDirUsable(controlDir: string): void {
  if (controlDir.trim().length === 0) {
    throw new PolicyConfigError('控制通道目录未配置（AGENT_STUDIO_CONTROL_DIR）')
  }
  try {
    mkdirSync(join(controlDir, APPROVALS_DIR), { recursive: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PolicyConfigError(`控制通道目录不可用：${controlDir}（${detail}）`)
  }
}
