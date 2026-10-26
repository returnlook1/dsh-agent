/** 审批决定路由（归属校验 + fail closed）。 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { approvalDecisionRequestSchema, type ApprovalDto } from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthGuards } from '../auth/guard.js'
import { conflict, notFound, parseInput } from '../http/errors.js'

const approvalParams = z.object({ id: z.string().min(1).max(128) })

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext, guards: AuthGuards): void {
  app.post('/api/approvals/:id/decision', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(approvalParams, request.params, '路径参数')
    const body = parseInput(approvalDecisionRequestSchema, request.body, '审批请求')

    const row = ctx.repos.approvals.resolveForUser(id, user.id, user.role)
    if (row === undefined) throw notFound(`审批不存在: ${id}`)
    if (row.status !== 'pending') throw conflict(`审批已处理: ${row.status}`)

    const now = Date.now()
    if (row.expires_at <= now) {
      ctx.repos.approvals.updateDecision(row.id, 'expired', 'system', now)
      ctx.hub.publish({
        type: 'approval.decided',
        sessionId: row.session_id,
        approvalId: row.approval_id,
        decision: 'expired',
        at: now,
      })
      throw conflict('审批已过期')
    }

    const result = ctx.runtime.decideApproval(
      row.session_id,
      row.approval_id,
      body.decision,
      user.id,
      body.reason,
    )

    if (!result.ok) {
      if (result.status === 'missing') {
        // 运行时已不在：决定无法送达子进程，按过期处理（fail closed）。
        ctx.repos.approvals.updateDecision(row.id, 'expired', user.id, now)
        ctx.hub.publish({
          type: 'approval.decided',
          sessionId: row.session_id,
          approvalId: row.approval_id,
          decision: 'expired',
          at: now,
        })
        throw conflict('运行时已停止，审批已过期')
      }
      throw conflict(`审批已处理: ${result.status}`)
    }

    const updated = ctx.repos.approvals.getById(row.id)
    if (updated === undefined) throw notFound(`审批不存在: ${id}`)
    const dto: ApprovalDto = ctx.repos.approvals.toDto(updated)
    reply.send(dto)
  })
}
