/**
 * Web 端的少量本地常量。
 *
 * 默认模型等值必须与 `@agent-studio/shared` 保持一致（agent-config.ts）。
 * 这里不复用 shared 的**运行时**导出，是为了让 `apps/web` 只依赖 shared 的
 * 类型：Vite/Rollup 解析 shared 源码里的 `export * from './x.js'` 时不会映射回
 * `.ts`，而且 `packages/shared/dist` 是构建产物；只依赖类型可避免这两点。
 */
export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-flash'

/** 稳定去重（保留首次出现顺序），与 shared 的 `unique()` 行为一致。 */
export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}
