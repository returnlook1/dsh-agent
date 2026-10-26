# Cordis 插件（受限运行时）

三个 Cordis 插件运行在 Agent Studio 的 DSH 子进程内（`@deepseek-ai/dsh@0.2.1-rc.3`）。
它们共同实现"服务端强制"的工具权限：**策略**（能不能调）→ **审批**（要不要人批）→
**审计**（发生了什么）。架构与安全模型见 `docs/DECISIONS.md`，实现规格见
`docs/IMPL-PLUGINS.md`，API 事实见 `docs/RESEARCH-TOOLS.md`。

| 插件 | 职责 | 进程内角色 |
| --- | --- | --- |
| `agent-policy` | allow / deny / ask 判定、撤销开关、审批等待、决策审计 | `ctx.tools.guard()` + `tools/pre-execute` |
| `agent-audit` | 工具执行结果审计（JSONL） | `tools/pre-execute` / `post-execute` / `result` |
| `agent-tools` | 4 个业务工具 + `dist/catalog.json` | `ctx.tools.register(defineTool(...))` |

> **policy / audit 插件没有任何运行时 `@deepseek-ai/*` import**（只有 `import type`），
> 构建产物里只剩 Node 内置模块。唯一例外是 `agent-tools` 的 `defineTool`（纯函数工厂，
> 版本与运行时一致）。这一点由 `grep '^import' dist/*.js` 和 fake-ctx 冒烟测试共同保证。

---

## 1. `plugins/agent-policy`

### 行为

1. **启动即校验**：读取 `policySnapshotSchema` 形状的 JSON 快照；文件缺失、不可读、不是
   合法 JSON、任一字段不符 → `apply()` 抛 `PolicyConfigError`，运行时启动失败。
   同时创建控制通道目录并验证审计文件可写。**没有策略就不启动**（fail closed）。
2. **同步守卫**（`ctx.tools.guard`，最后一道、不可翻案）按顺序判定：
   撤销标记 → 是否有 Agent 身份 → 进程内工具调用次数上限 → allow/ask 名单。
3. **异步前置策略**（`tools/pre-execute`）：`deny` 直接拒绝并写审计；`allow` 先
   `await next()`（不短路其它策略）再写审计；`ask` 走 §1.2 的审批通道。
   监听器幂等（同一 `callId` 不会重复发起审批）。
4. **审批**（不返回 `kind:'ask'`——非交互运行时没有 answerer，只会变成拒绝）：

   ```
   <controlDir>/approvals/<approvalId>.request.json    插件写
   <controlDir>/approvals/<approvalId>.decision.json   网关写
   ```

   轮询 100ms，自带 deadline（`approvalTimeoutMs`，默认取快照，默认 120s）；
   监听 `exec.signal`（abort → 立即返回 `{kind:'cancel'}`）；`finally` 里删除自己的
   request 文件。`allowed-once` → allow（`decision='approved'`）；`rejected` →
   deny；超时 → `decision='expired'`；通道不可用 → deny。**任何异常都按拒绝处理。**
5. **撤销**：`<controlDir>/revoked.json` **存在即全拒绝**。每次判定只做一次
   `statSync`，用 mtime + ≤1000ms 缓存窗口避免高频 IO；stat 出错（非 ENOENT）也按撤销处理。

### 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `AGENT_STUDIO_POLICY` | ✅ | 策略快照绝对路径（只读，启动时读一次，不热更新） |
| `AGENT_STUDIO_CONTROL_DIR` | ✅ | 控制通道目录（缺省时用快照里的 `controlDir`） |
| `AGENT_STUDIO_AUDIT_PATH` | ✅ | 审计 JSONL 路径（缺省时用快照里的 `auditPath`） |
| `AGENT_STUDIO_SESSION_ID` / `_USER_ID` / `_AGENT_ID` / `_AGENT_VERSION` | 建议 | 审计身份兜底（缺省取快照值） |
| `AGENT_STUDIO_APPROVAL_TIMEOUT_MS` | 否 | 覆盖快照里的 `approvalTimeoutMs` |

`apply(ctx, config)` 另接受同名可选覆盖（`policyPath`/`controlDir`/`auditPath`/
`approvalTimeoutMs`/`revocationCacheMs`/`now`），供测试与 Profile 显式配置使用。

---

## 2. `plugins/agent-tools`

| 工具 | 参数 | 风险 | 建议动作 |
| --- | --- | --- | --- |
| `search_datasets` | `keyword` 1..80 | low | allow |
| `query_station` | `stationId`、`days` 1..30（在 `execute` 内校验） | low | allow |
| `map_fly_to` | `longitude` -180..180、`latitude` -90..90、`zoom?` 1..18 | low | allow |
| `export_report` | `stationId`、`format: pdf\|xlsx` | high | **ask** |

- 数据：`<dataDir>/datasets.json`、`<dataDir>/stations.json`；缺失/损坏 → 结构化错误
  （`isError` 结果），进程不崩。
- **L3 参数级授权**：`AGENT_STUDIO_ALLOWED_STATIONS` 非空时，任何不在白名单里的站点
  都抛 `站点 <id> 不在授权范围内`（"允许工具 ≠ 允许任意数据"）。
- 输出确定性：同输入同输出；唯一时间戳写在报表任务文件的 `generatedAt` 里。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_STUDIO_TOOLS_DATA_DIR` | `<cwd>/.studio/data` | `datasets.json` / `stations.json` 所在目录 |
| `AGENT_STUDIO_OUTPUT_DIR` | `<cwd>/.studio/output` | `export_report` 写报表任务的位置 |
| `AGENT_STUDIO_ALLOWED_STATIONS` | 空（不限制） | 逗号分隔的授权站点 id |

### `dist/catalog.json`

构建时由 `scripts/build-catalog.mjs` 生成（`tsc` 之后运行），内容来自**与 `apply()`
注册完全相同的那组工具定义**，因此不会和运行时漂移。Entry 形状
（`packages/shared/src/catalog.ts` `toolCatalogEntrySchema`）：

```json
{
  "name": "export_report",
  "title": "导出报表",
  "description": "……给模型看的说明……",
  "source": "business",
  "risk": "high",
  "parameters": { "type": "object", "properties": { "...": {} }, "required": ["..."] },
  "requiresApprovalChannel": true,
  "restrictedAllowed": true
}
```

顶层为 `{ "catalogVersion": 1, "generatedBy": "agent-tools", "entries": [...] }`。
`parameters` 是 `defineTool` 编译出的**真实参数 JSON Schema**（不是另一份手写副本）。
`catalog.test.ts` 断言 `catalog.json` 与真实注册结果一致（名称/顺序/参数/风险），
并检测"改了工具没重新构建"的过期文件。

---

## 3. `plugins/agent-audit`

- 每次调用两行 JSONL：策略插件的**决策行**（`status=started|denied`）+ 本插件的
  **结果行**（`status=succeeded|failed`）。每行一个 `JSON.stringify` + `fs.appendFileSync`，
  每个运行时进程只有自己的文件，跨进程不会交错。
- `durationMs`：在 `tools/pre-execute` 用 `callId` 记开始时间，在 `tools/result` 配对
  （registry 不提供耗时字段）。
- `tools/post-execute` 返回 `block` 时写一行 `status=failed`、`error=blocked by post-execute policy`，
  并让随后的 `tools/result` 跳过，避免重复行。
- 决策来源：`agent-policy` 通过 `globalThis[Symbol.for('@agent-studio/tool-audit-bridge/v1')]`
  传递本进程内的判定（两个插件不能互相 import），取不到时回退按 `result.isError` 推断。
- **审计不可用不影响业务**：写失败只写 stderr，绝不抛错；未配置路径时整体降级为 no-op。

### 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `AGENT_STUDIO_AUDIT_PATH` | 建议 | 审计 JSONL 路径（缺省读快照的 `auditPath`；都没有则 no-op） |
| `AGENT_STUDIO_POLICY` | 否 | 用于读取身份字段兜底 |
| `AGENT_STUDIO_SESSION_ID` / `_USER_ID` / `_AGENT_ID` / `_AGENT_VERSION` | 否 | 身份兜底 |

审计字段严格等于 `packages/shared/src/audit.ts` 的 `auditRecordSchema`：
`id, at, sessionId, runtimeId, agentId, agentVersion, userId, callId, tool, decision,
status, argumentsPreview, argumentsDigest, error?, durationMs?, approvalId?`。
参数只写**脱敏 + ≤300 字符**的预览与 sha256 指纹（对规范化/排序后的 JSON 取摘要）。

---

## 4. 构建与测试

```powershell
# 构建（agent-tools 会顺带生成 dist/catalog.json）
npm run build -w @agent-studio/plugin-agent-policy
npm run build -w @agent-studio/plugin-agent-audit
npm run build -w @agent-studio/plugin-agent-tools
# 或一次性：npm run build -w a -w b -w c

# 类型检查
npm run typecheck -w @agent-studio/plugin-agent-policy   # 同上，三个都要

# 仅校验 catalog.json 是否过期
npm run check:catalog -w @agent-studio/plugin-agent-tools
```

### 测试

```powershell
# 规范方式（任意普通环境）
npx vitest run --dir plugins
npx vitest run --config plugins/vitest.config.ts
```

冒烟测试直接 `import` 构建后的 `dist/index.js`，因此**必须先 build 再 test**
（缺 `dist` 时测试会以明确错误提示先构建）。

---

## 5. 与规格的偏差（有意为之，均已在代码注释中说明）

1. **快照校验不用 zod**：规格写"用 `policySnapshotSchema` 校验"，但硬性约束是
   `agent-policy` / `agent-audit` **不得有运行时 import**。因此改为手写等价校验器
   （`src/contracts.ts`），并用 `contracts.test.ts` 在运行时把**接受/拒绝矩阵**与
   `packages/shared/src/policy.ts` 的真实 zod schema 逐条对齐。
2. **`deny` 支持尾部通配**：规格只要求 allow/ask 支持 `mcp__water__*`。这里 deny 也支持，
   否则"allow `mcp__*` + deny `mcp__water__*`"会因为 deny 只做精确匹配而**放行**。
   优先级仍然是 deny > ask > allow > 未命中拒绝。
3. **`argumentsDigest` 对脱敏后的参数取值**：摘要会写进审计与审批请求，对原文取哈希
   等于给密钥留指纹；审批是**一次性**（`allowed-once`，按 `callId` 生效），不依赖摘要
   做强一致校验。
4. **`key` 按词匹配，`token/secret/password/authorization` 按子串匹配**：`apiKey`、
   `private_key`、`clientSecret`、`authtoken` 都会脱敏，而业务参数 `keyword` 不会被误杀。
5. **启动不写伪审计记录**：改为"空写"验证审计文件可写，避免把 `__policy__` 之类的假
   工具名灌进网关的审计表。
6. **`catalog.json` 由编译后的模块生成**，而不是用正则解析 `src/tools/*.ts`：单一口径、
   能带上 `defineTool` 编译出的真实参数 JSON Schema，且不会静默漂移。
