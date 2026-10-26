# 验证报告

本文档记录 Agent Studio 的**可复现验证**：跑了什么、断言什么、结果如何。
所有数字都来自本机实际执行（一次完整 `npm run verify` 的收尾运行）。

- 运行环境：Windows，Node `v24.21.0`，DSH `0.2.1-rc.3`（`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-sdk-client` 同版本）
- 模型：`@deepseek-ai/dsh-llm-mock-server`（进程内 mock，无网络、无 API Key）
- 数据：`runtime/tools/{datasets,stations}.json`（`npm run data:demo` 确定性子生成）

---

## 1. 总览

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（6 个包） | `npm run typecheck` | ✅ 0 错误 |
| 单元测试 | `npm test` | ✅ 17 文件 / **150 用例** 通过 |
| 受限运行时安全场景 | `npm run smoke` | ✅ **5/5** 场景通过（真实 DSH 子进程） |
| 网关端到端 | `npm run e2e` | ✅ **51 项断言**通过（allow + approval 两种模式） |
| 前端构建 | `npm run build:web` | ✅ `dist/` 产出（`index.html` + 分包资源） |

---

## 2. 单元测试覆盖（150 用例）

| 范围 | 文件 | 用例 | 覆盖点 |
| --- | --- | --- | --- |
| shared 契约 / 策略匹配 | `plugins/agent-policy/src/{matcher,contracts,redact,revocation,approval,plugin}.test.ts` | 64 | 通配与 deny 优先级、快照校验、脱敏、撤销缓存、审批超时/拒绝/中止、假 ctx 装载 |
| 业务工具 | `plugins/agent-tools/src/{tools,catalog}.test.ts` | 27 | 参数越界、站点白名单、确定性输出、目录与注册工具一致性 |
| 审计插件 | `plugins/agent-audit/src/plugin.test.ts` | 9 | 单行 JSONL、`durationMs` 配对、`block` 去重、策略拒绝不重复记账、写失败不影响执行 |
| 网关策略/事件/审批 | `apps/gateway/tests/runtime/*` | 21 | 策略快照生成、MCP 通配降级、事件映射与去重、审批桥过期/落盘 |
| 网关 API/仓储/服务 | `apps/gateway/tests/{api,repositories,services}/*` | 29 | 登录与令牌、SSE 帧、SPA 路由回退、归属隔离、运行限额 |

关键断言举例：

- `matcher.test.ts`：`allow mcp__*` + `deny mcp__water__*` 组合下，`mcp__water__query` 必须被拒绝（防止通配互相"遮盖"）。
- `plugin.test.ts`：未授权工具返回 `{kind:'deny'}`；`revoked.json` 出现后所有调用返回拒绝；`ask` 在决策文件出现后才放行，超时按拒绝处理。
- `DshEventAdapter.test.ts`：同一 `message.id` 重复推送只落一条；`turn/end{reason:{kind:'error'}}` 映射为 `agent.failed`；`turn/start` 超过 `maxTurns` 触发 `run.limit`。
- `plugin.test.ts`（audit）：策略已记录 deny 行时，`tools/result` 的失败回调**不再重复记账**。

---

## 3. 受限运行时安全场景（`npm run smoke`）

每个场景从零创建一个运行时：独立 `DSH_HOME`、空工作目录、独立策略快照、独立审计文件；
模型由 mock 扮演，**要求调用指定工具**，由脚本观察运行时行为与审计文件。

| 场景 | 模型要求调用 | 策略 | 期望 | 实际 |
| --- | --- | --- | --- | --- |
| `text` | 无 | 允许 3 个工具 | 纯文本回复 | ✅ 链路通，审计 0 条 |
| `allow` | `query_station` | `allow` | 执行成功 | ✅ `decision=allow` + `status=succeeded` |
| `deny` | `query_station` | 未授权 | 拒绝执行 | ✅ 工具错误「工具 query_station 未获得授权」，审计 `deny/denied` |
| `ask` | `export_report` | `ask` | 审批通过后执行 | ✅ 出现请求文件 → 脚本写 `allowed-once` → 执行成功，审计 `approved/succeeded` |
| `reject` | `export_report` | `ask` | 审批拒绝不执行 | ✅ 脚本写 `rejected` → 工具失败，审计 `rejected/denied` |

代表性输出（`deny` 场景）：

```
tool/call query_station {"stationId":"ST-3101","days":7}
tool/result ERROR: Error: 工具 query_station 未获得授权
审计记录 1 条：
  - query_station decision=deny status=denied error=工具 query_station 未获得授权
```

`ask` 场景：

```
tool/call export_report {"stationId":"ST-3101","format":"pdf"}
→ approver wrote allowed-once for 91bad273-...
tool/result ok: { "reportId": "...", "path": "...", ... }
审计记录 2 条：
  - export_report decision=approved status=started   approval=91bad273-...
  - export_report decision=approved status=succeeded approval=91bad273-...
```

---

## 4. 网关端到端（`npm run e2e`）

真实 Fastify 进程 + 真实 DSH 子进程 + mock 模型，全部通过 HTTP/SSE 驱动。

### 4.1 `--mode allow`（30 项断言）

链路：`/api/health` → 错误密码被拒 → 管理员登录 → `/api/auth/me` → 工具目录（4 个业务工具）→
创建 Agent → 发布（内部执行 `dsh --dump-config` 校验插件树）→ `/api/agents/:id/tools` →
创建会话（绑定已发布版本）→ 发消息（SSE）→ 审计 → 第二轮 → 运行时状态 → 停止 → 越权抽查。

SSE 事件序列（真实抓取）：

```
run.started → message.delta → tool.started → tool.completed → message.delta → agent.completed
```

断言结果：`tool.started.tool = query_station`、`tool.completed.success = true`、
审计 `decision=allow / status=succeeded`、消息落库 `user + assistant`（第二轮数量增加）、
普通用户读审计返回 403、普通用户建 Agent 返回 403、网关托管前端静态资源返回 200。

### 4.2 `--mode approval`（21 项断言）

链路：创建 `export_report: ask` 的 Agent → 发消息 → **SSE 中出现 `approval.required`** →
`POST /api/approvals/:approvalId/decision {allowed-once}` → `approval.decided` → 工具执行成功。

真实事件序列：

```
（批准）run.started → message.delta → tool.started → approval.required → approval.decided → tool.completed → message.delta → agent.completed
（拒绝）run.started → message.delta → approval.required → approval.decided → tool.completed → message.delta → agent.completed
```

断言结果：批准后 `tool.completed.success = true` 且审计 `approved/succeeded`；拒绝后
`success = false` 且审计 `rejected/denied`；审批记录状态分别为 `allowed` / `rejected`；
普通用户审批他人会话返回 403/404。

> 这条链路证明了方案里最关键的一环：**审批决定确实回传到了运行中的 Agent 进程**，
> 而不是只在前端界面上"看起来被批准了"。

---

## 5. 已知未验证项

| 项目 | 原因 |
| --- | --- |
| 真实模型（DeepSeek 官方 API）调用 | 本次验证只用 mock 模型；真实调用需开发者提供 API Key，代码路径与 mock 完全一致（同一 adapter，仅 baseURL 不同） |
| MCP 服务器真实联通 | 仓库内没有可用的外部 MCP 服务；`McpProbe` 的 stdio `initialize`/`tools/list` 有单测，profile 覆盖层有 `--dump-config` 证据，但未做真机联通 |
| 浏览器 UI 端到端 | 前端做了类型检查、生产构建，SSE 解析器用真实源码跑过 6 组用例（分包/CRLF/注释/多行 data/尾帧/中途取消）；没有 Playwright 自动化 |
| 多用户并发压力 | 单机 SQLite + 每会话一进程，未做压测 |
| Windows 信号处理 | `SIGTERM` 在 Windows 上不会走 Node 处理器；优雅关闭逻辑面向真实部署环境 |

---

## 6. 复现步骤

```powershell
npm install --cache .npm-cache --no-audit --no-fund --ignore-scripts
npm run build
npm run data:demo
npm run verify
```

只跑某一层：

```powershell
npm run typecheck
npm test
npm run smoke
node scripts/e2e-gateway.mjs --mode approval --keep
```

> `smoke` / `e2e` 会启动带管道 stdio 的子进程。若你的环境禁止子进程（受限沙箱），
> 这两条命令无法执行，但 `typecheck` / `test` / `build` 不受影响。
