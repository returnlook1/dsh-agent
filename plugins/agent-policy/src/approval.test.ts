/**
 * Approval control-channel edge cases.
 *
 * Every failure mode must end in a denial (or `cancel`): an unwritable channel, a
 * mismatched decision record, a malformed file, an expired deadline, or an aborted
 * call. The request file must always be cleaned up.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  APPROVALS_DIR,
  approvalDecisionFileName,
  approvalRequestFileName,
  assertControlDirUsable,
  requestApproval,
} from './approval.js'
import { PolicyConfigError } from './contracts.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-policy-approval-'))
}

const BASE = {
  tool: 'export_report',
  callId: 'call-1',
  description: '导出报表需要审批',
  argumentsPreview: '{"stationId":"ST-001"}',
  argumentsDigest: 'a'.repeat(64),
}

function listRequests(controlDir: string): string[] {
  try {
    return readdirSync(join(controlDir, APPROVALS_DIR)).filter((name) => name.endsWith('.request.json'))
  } catch {
    return []
  }
}

describe('assertControlDirUsable', () => {
  it('rejects an empty control directory', () => {
    expect(() => assertControlDirUsable('  ')).toThrow(PolicyConfigError)
  })

  it('rejects a control directory that cannot be created', () => {
    const directory = tempDir()
    const blocker = join(directory, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    expect(() => assertControlDirUsable(join(blocker, 'control'))).toThrow(/控制通道目录不可用/)
  })

  it('creates the approvals directory', () => {
    const controlDir = join(tempDir(), 'control')
    assertControlDirUsable(controlDir)
    expect(existsSync(join(controlDir, APPROVALS_DIR))).toBe(true)
  })
})

describe('requestApproval', () => {
  it('writes a request file and resolves allowed-once from the decision file', async () => {
    const controlDir = join(tempDir(), 'control')
    const pending = requestApproval({ ...BASE, controlDir, timeoutMs: 2_000, signal: new AbortController().signal })

    // Wait for the request file the gateway would answer.
    let requestFile: string | undefined
    const deadline = Date.now() + 1_000
    while (requestFile === undefined && Date.now() < deadline) {
      ;[requestFile] = listRequests(controlDir)
      if (requestFile === undefined) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(requestFile).toBeDefined()
    const approvalId = requestFile?.replace('.request.json', '') ?? ''
    const request = JSON.parse(readFileSync(join(controlDir, APPROVALS_DIR, requestFile ?? ''), 'utf8')) as Record<
      string,
      unknown
    >
    expect(request).toMatchObject({
      approvalId,
      callId: 'call-1',
      tool: 'export_report',
      argumentsDigest: 'a'.repeat(64),
    })
    writeFileSync(
      join(controlDir, APPROVALS_DIR, approvalDecisionFileName(approvalId)),
      JSON.stringify({ approvalId, decision: 'allowed-once', decidedBy: 'tester', decidedAt: Date.now() }),
      'utf8',
    )

    const outcome = await pending
    expect(outcome).toMatchObject({ verdict: 'allowed-once', approvalId })
    expect(listRequests(controlDir)).toEqual([])
  })

  it('denies on a decision that belongs to another approval', async () => {
    const controlDir = join(tempDir(), 'control')
    const pending = requestApproval({ ...BASE, controlDir, timeoutMs: 2_000, signal: new AbortController().signal })
    const deadline = Date.now() + 1_000
    while (listRequests(controlDir).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const [requestFile] = listRequests(controlDir)
    const approvalId = (requestFile ?? '').replace('.request.json', '')
    writeFileSync(
      join(controlDir, APPROVALS_DIR, approvalDecisionFileName(approvalId)),
      JSON.stringify({ approvalId: 'someone-else', decision: 'allowed-once', decidedBy: 'x', decidedAt: 1 }),
      'utf8',
    )

    const outcome = await pending
    expect(outcome.verdict).toBe('rejected')
    expect(outcome.reason).toContain('不匹配')
    expect(listRequests(controlDir)).toEqual([])
  })

  it('ignores a malformed decision file and denies on timeout', async () => {
    const controlDir = join(tempDir(), 'control')
    const pending = requestApproval({ ...BASE, controlDir, timeoutMs: 250, signal: new AbortController().signal })
    const deadline = Date.now() + 1_000
    while (listRequests(controlDir).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const [requestFile] = listRequests(controlDir)
    const approvalId = (requestFile ?? '').replace('.request.json', '')
    writeFileSync(join(controlDir, APPROVALS_DIR, approvalDecisionFileName(approvalId)), '{oops', 'utf8')

    const outcome = await pending
    expect(outcome.verdict).toBe('timeout')
    expect(listRequests(controlDir)).toEqual([])
  })

  it('denies immediately when the deadline configuration is invalid', async () => {
    const controlDir = join(tempDir(), 'control')
    const outcome = await requestApproval({
      ...BASE,
      controlDir,
      timeoutMs: 0,
      signal: new AbortController().signal,
    })
    expect(outcome.verdict).toBe('unavailable')
    expect(listRequests(controlDir)).toEqual([])
  })

  it('denies when the control channel cannot be written', async () => {
    const directory = tempDir()
    const blocker = join(directory, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const outcome = await requestApproval({
      ...BASE,
      controlDir: join(blocker, 'control'),
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    expect(outcome.verdict).toBe('unavailable')
    expect(outcome.reason).toContain('审批请求无法写入')
  })

  it('returns cancelled when the call is aborted, and removes the request file', async () => {
    const controlDir = join(tempDir(), 'control')
    const controller = new AbortController()
    const pending = requestApproval({
      ...BASE,
      controlDir,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    const deadline = Date.now() + 1_000
    while (listRequests(controlDir).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    controller.abort()

    const outcome = await pending
    expect(outcome.verdict).toBe('cancelled')
    expect(listRequests(controlDir)).toEqual([])
  })

  it('uses the documented file names', () => {
    expect(approvalRequestFileName('abc')).toBe('abc.request.json')
    expect(approvalDecisionFileName('abc')).toBe('abc.decision.json')
  })
})
