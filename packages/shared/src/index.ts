/**
 * Agent Studio 共享契约。
 *
 * 三个消费者共用这里的类型：
 * - `apps/gateway`：HTTP/SSE 服务、运行时管理、审计；
 * - `apps/web`：Vue3 管理端与聊天端；
 * - `plugins/*`：运行在 DSH 子进程内的 Cordis 插件（只依赖其中的
 *   policy / audit 两个模块，且以 type-only 方式导入）。
 */
export * from './agent-config.js'
export * from './events.js'
export * from './policy.js'
export * from './audit.js'
export * from './dto.js'
export * from './catalog.js'
