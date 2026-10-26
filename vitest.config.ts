/**
 * 根 vitest 配置：一次收集全部测试（shared / plugins / gateway）。
 *
 * 运行：
 *   npm test                     # 全部单测（不需要网络、不启动真实 DSH）
 *   npx vitest run apps/gateway  # 只跑网关
 *   npx vitest run --dir plugins # 只跑插件
 *
 * 端到端链路（真实 DSH 子进程 + mock LLM）不在这里，见 `npm run smoke` / `npm run e2e`：
 * 它们需要启动子进程与本地端口，属于集成测试而不是单元测试。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'plugins/**/src/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.tmp/**', 'runtime/**'],
    environment: 'node',
    // 审批通道轮询 100ms，个别用例需要等文件出现。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
