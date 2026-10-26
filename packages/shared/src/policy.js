/**
 * 受限运行时的策略快照与"可信控制通道"文件协议。
 *
 * 设计要点（见 docs/DECISIONS.md）：
 * - 策略快照由网关在启动运行时前写入，对插件只读，且带版本号与哈希；
 * - 插件严禁从用户消息、模型输出或提示词读取权限；
 * - 当前 SDK（0.2.1-rc.3）没有 server→client 请求通道，因此审批与撤销通过
 *   运行时目录下的文件通道完成：插件写 request，网关写 decision，插件轮询；
 * - 一切失败都关闭（fail closed）：通道不可用时工具调用被拒绝。
 */
import { z } from 'zod';
import { toolActionSchema } from './agent-config.js';
export const POLICY_SNAPSHOT_VERSION = 1;
/** 插件启动时读取的只读策略快照。 */
export const policySnapshotSchema = z.object({
    snapshotVersion: z.literal(POLICY_SNAPSHOT_VERSION).default(POLICY_SNAPSHOT_VERSION),
    agentId: z.string(),
    agentVersion: z.number().int(),
    runtimeId: z.string(),
    /** 业务会话 id（不是 DSH 的 sessionId）。 */
    sessionId: z.string(),
    userId: z.string(),
    /** 生成时间（毫秒时间戳）。 */
    issuedAt: z.number(),
    /** 工具名 → allow / deny / ask。未列出的工具按 defaultAction 处理。 */
    tools: z.record(z.string(), toolActionSchema),
    /** 默认动作：受限 Agent 必须是 deny。 */
    defaultAction: z.literal('deny').default('deny'),
    /** 审批超时（毫秒）；超时即拒绝，不允许把一次审批扩展成永久授权。 */
    approvalTimeoutMs: z.number().int().positive().default(120_000),
    /** 控制通道目录（绝对路径），插件在其下读写审批文件。 */
    controlDir: z.string(),
    /** 审计 JSONL 输出路径（绝对路径）。 */
    auditPath: z.string(),
    /** 工具调用次数上限（0 或省略表示不限）。 */
    maxToolCalls: z.number().int().nonnegative().default(0),
    /** 允许的最大轮次，仅用于插件侧兜底告警。 */
    maxTurns: z.number().int().positive().default(20),
});
/** 控制通道内的固定文件名。 */
export const CONTROL_FILES = {
    /** 撤销标记：存在即拒绝一切工具调用。 */
    revoked: 'revoked.json',
    /** 审批子目录。 */
    approvalsDir: 'approvals',
};
/** 插件写入的审批请求。 */
export const approvalRequestSchema = z.object({
    approvalId: z.string(),
    callId: z.string(),
    tool: z.string(),
    /** 面向用户的操作描述（不包含敏感信息）。 */
    description: z.string(),
    /** 参数摘要（已脱敏、已截断）。 */
    argumentsPreview: z.string().default(''),
    /** 参数指纹，用于网关校验"同一份参数只批准一次"。 */
    argumentsDigest: z.string(),
    requestedAt: z.number(),
    expiresAt: z.number(),
});
export const approvalDecisionSchema = z.enum([
    'allowed-once',
    'rejected',
    'cancelled',
]);
/** 网关写入的审批决定。 */
export const approvalDecisionRecordSchema = z.object({
    approvalId: z.string(),
    decision: approvalDecisionSchema,
    decidedBy: z.string(),
    decidedAt: z.number(),
    reason: z.string().optional(),
});
/** 撤销记录：撤销应立即在执行守卫处生效。 */
export const revocationRecordSchema = z.object({
    revoked: z.literal(true),
    reason: z.string().default('revoked by administrator'),
    at: z.number(),
    by: z.string().optional(),
});
/** 审批文件名约定：<approvalId>.request.json / <approvalId>.decision.json */
export function approvalRequestFileName(approvalId) {
    return `${approvalId}.request.json`;
}
export function approvalDecisionFileName(approvalId) {
    return `${approvalId}.decision.json`;
}
/** 从审批文件名解析 approvalId；不是审批文件时返回 undefined。 */
export function parseApprovalFileName(fileName) {
    if (!fileName.endsWith('.request.json'))
        return undefined;
    return fileName.slice(0, -'.request.json'.length);
}
