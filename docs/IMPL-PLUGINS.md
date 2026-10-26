# 受限运行时插件实现规格（plugins/\*）

三个 Cordis 插件运行在 DSH 子进程内，**必须**满足本文档与 `docs/DECISIONS.md`。
核实依据：`docs/RESEARCH-TOOLS.md`、`docs/RESEARCH-SDK.md`、`docs/RESEARCH-PROFILE.md`。

共同约束：

- 目标 `@deepseek-ai/dsh-tools@0.2.1-rc.3`，ESM，构建为 `dist/index.js`（tsc，NodeNext）。
- 插件模块导出 `export const name`、`export const inject`（仅 `['tools']`）、`export function apply(ctx)`。
- **policy / audit 插件不得有任何运行时 import**（只用 `import type`），避免在子进程里加载第二份 Cordis/ToolRegistry；
  唯一例外是 `agent-tools` 可以使用 `defineTool`（纯函数工具工厂），版本必须与运行时一致。
- 配置只从环境变量读取（见下），**绝不**从模型输出、用户消息、工具参数里读取权限。
- 一切异常路径必须 fail closed（抛错 = 拒绝执行），但必须写好审计日志。
- 所有文件写入用"临时文件 + rename"原子替换；Windows 上 rename 覆盖需要先删除目标。

---

## 1. `plugins/agent-policy`

### 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `AGENT_STUDIO_POLICY` | 是 | 策略快照 JSON 绝对路径（只读） |
| `AGENT_STUDIO_CONTROL_DIR` | 是 | 控制通道目录（含 `approvals/`） |
| `AGENT_STUDIO_AUDIT_PATH` | 是 | 审计 JSONL 路径 |
| `AGENT_STUDIO_SESSION_ID` / `_USER_ID` / `_AGENT_ID` / `_AGENT_VERSION` | 是 | 快照缺失时的兜底标识，用于审计 |
| `AGENT_STUDIO_APPROVAL_TIMEOUT_MS` | 否 | 覆盖快照里的 `approvalTimeoutMs` |

启动时：读取并 zod 校验快照（`policySnapshotSchema`）；校验失败 → 打印清晰错误并 **拒绝加载**
（`apply` 抛错，让运行时启动失败，而不是"无策略裸奔"）。快照只读一次（不热更新）。

### 行为

1. **全局守卫**（同步，最后一道）：
   ```ts
   ctx.effect(() => ctx.tools.guard((exec) => {
     if (revocation.isRevoked()) return `运行已被管理员撤销：${reason}`
     if (!exec.agent) return '缺少 Agent 执行身份'
     if (callsExceeded()) return `工具调用次数超过上限(${maxToolCalls})`
     if (!isAllowed(exec.name)) return `工具 ${exec.name} 未获得授权`
     return undefined
   }))
   ```
   - `isAllowed`：先匹配 `deny`（精确）→ 再匹配 `allow`/`ask`（支持**尾部通配** `mcp__water__*`）→ 未命中即拒绝。
   - `revocation`：每次调用检查 `controlDir/revoked.json` 是否存在；用 `mtimeMs` 缓存避免高频 IO（缓存窗口 ≤ 1000ms）。
   - `callsExceeded`：进程内计数器，`maxToolCalls > 0` 时生效。

2. **异步前置策略**（`ctx.on('tools/pre-execute', ...)`）：
   - `deny` → `{ kind: 'deny', reason }`，并写审计（`decision='deny', status='denied'`）。
   - `allow` → 写审计（`decision='allow', status='started'`）后 `next()`。
   - `ask` → 走审批通道（**不要**返回 `kind:'ask'`，运行时没有 answerer，只会失败）：
     1. 生成 `approvalId = randomUUID()`；
     2. 写 `approvals/<approvalId>.request.json`（`approvalRequestSchema`，含 callId、tool、
        `argumentsPreview`（脱敏 + ≤300 字符）、`argumentsDigest`（sha256 of 规范化 JSON）、expiresAt）；
     3. 轮询等待 `approvals/<approvalId>.decision.json`（间隔 100ms，**同时**监听 `exec.signal`；
        超时 → 视为拒绝）；
     4. 得到 `allowed-once` → 写审计（`decision='approved'`）→ `next()`；否则 `{ kind: 'deny', reason }`。
   - 监听器必须是**幂等**的：同一 `callId` 重复进入不得重复写 request（用 Set 记录进行中的 callId）。
   - **必须**在 `exec.signal` abort 时立即返回 `{ kind: 'cancel' }`，并清理 request 文件。

3. **审计**：与 `agent-audit` 插件共用一个 `AuditWriter`（policy 插件自己写决策记录，audit 插件写执行结果）。
   为避免重复实现，policy 插件内部实现最小写入器（append + `\n`，`fs.appendFileSync`），格式完全一致。

4. 若 `AGENT_STUDIO_POLICY` 缺失或不可读：`apply` 抛错（拒绝启动）。这是刻意的：**没有策略就不启动**。

---

## 2. `plugins/agent-tools`

注册业务工具（与 `packages/shared` 的目录契约一致）。第一版实现 4 个：

| 工具名 | 说明 | 参数 | 风险 | 默认动作 |
| --- | --- | --- | --- | --- |
| `search_datasets` | 检索授权的业务数据集 | `keyword: string`（1..80） | low | allow |
| `query_station` | 查询监测站历史数据 | `stationId: string`、`days: integer`（1..30，**在 execute 内校验**） | low | allow |
| `map_fly_to` | 在地图组件上定位 | `longitude: number`（-180..180）、`latitude: number`（-90..90）、`zoom?: integer`（1..18） | low | allow |
| `export_report` | 生成并导出报表 | `stationId: string`、`format: 'pdf' \| 'xlsx'` | high | ask |

实现要求：

- 数据来源：`AGENT_STUDIO_TOOLS_DATA_DIR`（默认 `<cwd>/.studio/data`）下的 JSON 文件（`datasets.json`、`stations.json`）。文件缺失 → 返回结构化错误（`isError` 由抛错产生），不得崩溃。
- **参数级授权（L3）**：从 `AGENT_STUDIO_ALLOWED_STATIONS`（逗号分隔，可选）读取授权站点；
  非空时，请求不在白名单内的站点必须抛错（`站点 <id> 不在授权范围内`）。
  这是"允许工具 ≠ 允许任意数据"的落地示例。
- 每个工具的 `output.schema` + `output.render` 必填；`render` 返回 `[{ type:'text', text: JSON.stringify(value, null, 2) }]`。
- 输出必须**确定性**（同一输入同一输出，不用当前时间作为数据内容；时间戳只用于 `generatedAt` 且允许）。
- 同时导出 `catalog.json`（构建产物，`plugins/agent-tools/dist/catalog.json`），内容为
  `{ catalogVersion: 1, generatedBy: 'agent-tools', entries: [...] }`，供网关读取。
  生成方式：构建脚本 `scripts/build-catalog.mjs` 从 `src/tools/*.ts` 的元数据表生成（避免手写两份漂移）。
- 工具描述必须是给模型看的中文/英文混排说明，清晰说明参数含义与限制。

`export_report` 只生成"报表任务"（写文件到 `AGENT_STUDIO_OUTPUT_DIR`，默认 `<cwd>/.studio/output`），
不做真实渲染；返回 `{ reportId, path, format, stationId, rows }`。它是 `ask` 的演示用例。

---

## 3. `plugins/agent-audit`

- 监听 `ctx.on('tools/result', (exec, result) => {...})`（emit，无 next）：写 `status = result.isError ? 'failed' : 'succeeded'`
  与 `durationMs`（用 `exec.callId` 在内存 map 里记录开始时间，命中后删除）。
- 同时监听 `tools/post-execute`（waterfall）以捕获被 block 的情况（`kind === 'block'` → `status='failed'`，error=`blocked by post-execute policy`），
  并 `return next()` 保持行为不变。
- 审计写入器与 policy 插件共享同一格式；**必须**保证字段与 `auditRecordSchema` 一致，
  并且每条记录一行 JSON（不能跨行）。
- 目录不存在时自动创建；写入失败只记录到 stderr，**不得**抛错影响工具执行（审计不可用不能导致业务失败，
  但 policy 插件里的**决策**记录失败要抛错——两者语义不同，注意区分）。

---

## 4. 构建与验证

- `plugins/*/tsconfig.json` 继承 `../../tsconfig.base.json`，`rootDir: src`、`outDir: dist`、`declaration: true`。
- 构建：`npm run build -w @agent-studio/plugin-agent-policy` 等。
- 单测（vitest，纯函数级）：
  - `isAllowed` 的通配/优先级矩阵（deny 优先于 allow、未命中拒绝）；
  - 撤销缓存过期；
  - 参数脱敏（含 token/password 字段）；
  - `argumentsDigest` 对键序不敏感；
  - `query_station` 的 days 越界与站点白名单；
  - `catalog.json` 与工具定义一致（工具名/参数/风险）。
- 端到端验证由 `scripts/smoke-run.mjs`（Lead 负责）覆盖：未授权工具必须被拒绝且审计可见。
