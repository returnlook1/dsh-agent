/**
 * DSH Agent Service —— 共享契约。
 *
 * 只描述"服务 ↔ 前端/业务后端"之间的形状：
 * - 能力配置（Skills / MCP / 模型）与两级继承（项目 → 对话）
 * - 对话、消息与 SSE 事件
 *
 * 这里**不包含** Agent 版本、发布、用户、角色、审批、审计——这些由业务后端负责，
 * 服务本身不做租户与权限管理（见 docs/SERVICE.md §1）。
 */
export * from './agent-config.js'
export * from './capabilities.js'
export * from './conversation.js'
export * from './events.js'
export * from './inventory.js'
export * from './messages.js'
export * from './model-catalog.js'
