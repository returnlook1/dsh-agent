/**
 * 生产用运行时客户端：把快照物化结果翻译成 `@deepseek-ai/dsh-sdk-client` 的启动参数。
 *
 * 关键点（docs/RESEARCH-SDK.md / RESEARCH-PROFILE.md）：
 * - `dshHome` 通过**环境变量**给子进程（SDK 内部注入 `DSH_HOME`）；
 * - `patches` 一定排在 dshBin 自带 patch 之后，顺序 = [agent, mcp]；
 * - `env` 传对象会**整体替换**父环境，本服务正是要这种"从零构造"；
 * - `requestTimeoutMs` 不设：一个 turn 可以合法地跑很久，超时由 RuntimePool 的
 *   `TURN_TIMEOUT_MS` 兜底（超时后关闭整个运行时）。
 */
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import type { RuntimeClient, RuntimeClientOptions } from './RuntimePool.js'

/** 默认客户端工厂（唯一允许 spawn DSH 子进程的地方）。 */
export function createHarnessRuntimeClient(options: RuntimeClientOptions): RuntimeClient {
  const client = new HarnessClient({
    dshBin: options.dshBin,
    profile: options.profile,
    dshHome: options.dshHome,
    processCwd: options.processCwd,
    patches: options.patches,
    env: options.env,
    initializeTimeoutMs: 60_000,
    shutdownTimeoutMs: 2_000,
  })
  // HarnessClient 的公开方法与 RuntimeClient 结构一致；这里收窄到服务实际使用的子集。
  return client as unknown as RuntimeClient
}
