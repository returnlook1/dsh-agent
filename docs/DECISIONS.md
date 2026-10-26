# Agent Studio 架构决策记录（ADR）

本文档记录"基于 DSH 的受限 Agent 平台"落地时的关键决策、被否决的方案与仍然存在的风险。
所有实现必须与本文档一致；偏离时必须先改这份文档。

参考方案：`基于 DSH 的受限 Agent 平台实施方案.md`。本文档只记录**实现层面**的确定结论与原因。

---

## 0. 固定版本与前置条件

| 项 | 取值 | 说明 |
| --- | --- | --- |
| DSH Runtime | `@deepseek-ai/dsh@0.2.1-rc.3` | 与本机 Desktop 运行时 `0.2.1-rc.3` 一致；`latest` 标签仍是 `0.2.1-rc.2`，因此**必须显式写 `0.2.1-rc.3`** |
| DSH SDK | `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3` | 运行时与 SDK 必须同版本，`next` 标签 |
| Node.js | `>= 22.5`（本机 24.21.0） | 依赖内置 `node:sqlite`，无需原生编译 |
| 包管理 | **npm workspaces** | 见 §1 |
| 前端 | Vue 3.5 + Semi Design（`@aifuxi/semi-ui-vue`）+ Pinia + Vite | |
| 网关 | Fastify 5 + `@deepseek-ai/dsh-sdk-client` | |
| 数据库 | SQLite（`node:sqlite`，WAL） | 后续可换 PostgreSQL |

**升级 DSH 时必须同时升级 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-sdk-client`，并重跑 `npm run test` 中的 SDK 契约测试。**

---

## 1. 为什么用 npm workspaces 而不是 pnpm

方案原文建议 pnpm workspace。实测在本机环境（Windows + Node 24 + 只读用户目录沙箱）中：

- pnpm 11 的 store 需要 SQLite 索引，默认 store 位于用户目录，被文件沙箱拒绝（`ERR_SQLITE_ERROR: unable to open database file`）；即使把 store 指到仓库内，`node-linker=isolated` 用 **Windows junction** 链接包，而 Node 的 ESM 解析不会把 junction 还原成 realpath，导致包内部再引用其它 `@deepseek-ai/*` 包时 `ERR_MODULE_NOT_FOUND`（已在 `dsh-sdk-client → dsh-sdk-protocol` 上复现）。
- `node-linker=hoisted` 在 workspace 场景下仍保留 `.pnpm` 虚拟store，同样踩到 junction 解析问题。

因此改用 **npm workspaces**：真实目录、扁平提升，`node_modules/@deepseek-ai/*` 之间互相解析正常，也与 DSH 官方文档中的安装方式（`npm install @deepseek-ai/dsh`）一致。

`pnpm-workspace.yaml` 仍然保留，便于在其它平台使用 pnpm；但**本仓库的 CI 与文档以 npm 为准**。

安装：`npm install --cache .npm-cache --no-audit --no-fund`

---

## 2. 系统边界

```
浏览器 (Vue3)
   │  HTTP + SSE（只允许访问网关，绝不直连 DSH）
   ▼
Agent Gateway (Fastify, 单进程)
   │  ① 认证/授权 ② Agent 配置与版本 ③ 会话编排 ④ 审批 ⑤ 审计入库
   │  stdio JSON-RPC（SDK 客户端）
   ▼
DSH Runtime 子进程（每个业务会话一个）
   │  原版 Agent Loop / Provider / Session / MCP / Skills
   │  + plugins/agent-policy   （工具白/黑名单、审批、撤销）
   │  + plugins/agent-tools    （业务工具）
   │  + plugins/agent-audit    （审计 JSONL）
   ▼
业务 HTTP API / MCP Server / SQLite
```

四条不可妥协的原则（来自方案）：

1. 不重写 Agent Loop；
2. 不修改 DSH 源码（只用独立 Profile + Cordis 插件 + `--patch`）；
3. 前端永远不持有 DSH 管理权限；
4. 工具权限由**服务端**强制执行，不由提示词或前端按钮决定。

---

## 3. 权限四层模型与落地位置

| 层 | 作用 | 落地位置 | 状态 |
| --- | --- | --- | --- |
| L1 Agent 能力 | 允许哪些工具 / MCP / Skills | 受限 Profile（移除 shell/fs/web/subagent 插件） + 工具注册 | 必须 |
| L2 执行策略 | allow / deny / ask | `plugins/agent-policy`：`ctx.tools.guard()` + `tools/pre-execute` | 必须 |
| L3 用户授权 | 哪个用户能访问哪些业务数据 | 网关（会话归属校验） + 业务工具内部参数级校验 | 必须 |
| L4 系统隔离 | 文件/进程/网络/凭据 | 独立 `DSH_HOME`、独立工作目录、最小环境变量、独立凭据 | 必须 |

**四层不能互相替代。** 允许 `query_station` 不等于允许用户查询任意站点：工具内部仍要校验用户的数据权限（L3）。

---

## 4. 审批（ask）为什么走文件控制通道

- 方案原文假设 SDK 的 `client.onRequest()` 可以处理 `approval/request`。**当前版本不成立**：`dsh-sdk-client@0.2.1-rc.3` 的 README 明确写 "Client→server notifications and server→client requests are unimplemented on both wire ends"。
- DSH 的 `PreToolDecision.kind = 'ask'` 需要审批服务（`@deepseek-ai/dsh-user-approval`）支持，非交互 SDK Profile 中没有可用的审批 UI；缺少审批支持时 `ask` 会被当作拒绝。

因此实现为**可信控制通道**（方案 §六.1 "通过可信控制通道更新策略" 的延伸）：

```
<runtimeDir>/control/revoked.json                 撤销标记（存在即全拒绝）
<runtimeDir>/control/approvals/<id>.request.json  子进程写：待审批请求
<runtimeDir>/control/approvals/<id>.decision.json 网关写：allowed-once / rejected / cancelled
```

规则（fail closed）：

1. 策略快照 `policy.json` 在运行时启动前写入，权限只来自它，插件**只读**；
2. `tools/pre-execute` 是异步 waterfall，插件在其中阻塞等待 decision 文件（轮询 ~50–100ms），并监听 `exec.signal`；
3. 等待超时（默认 120s）→ 拒绝；
4. 审批只对**本次调用**有效（`allowed-once`），不写回策略，不做"永久允许"；
5. 撤销标记的检查优先级最高，**每次** guard 都会同步检查（stat + mtime 缓存），一旦出现立即拒绝后续所有工具调用；
6. 网关重启后，旧的 request 文件对应审批记录置为 `expired`；decision 文件不可写时按拒绝处理。

---

## 5. 审计链路

- 审计记录由 `plugins/agent-audit` 写入运行目录下的 `audit/tool-calls.jsonl`（**子进程不连数据库**，避免把 DB 凭据交给 Agent 进程）。
- 网关用 `fs.watch` + 轮询 tail 读取 JSONL，落 `agent_tool_audit` 表并推送到管理端。
- 审计记录包含：`id, at, sessionId, runtimeId, agentId, agentVersion, userId, callId, tool, decision, status, argumentsPreview, argumentsDigest, error, durationMs, approvalId`。
- 参数只记录**脱敏摘要 + sha256 指纹**，不落原文（业务工具自行决定是否记录业务参数）。
- 记录在工具**执行前**（决策落定）与**执行后**（结果落定）各写一行，`status` 区分 `started/succeeded/failed/denied`。

---

## 6. 配置落地矩阵（哪些配置项真的生效）

方案 §四 特别强调：不能"只保存 JSON 就认为已经生效"。实现按下表落实，发布时会把未落实项作为 warning 返回前端。

| AgentConfig 字段 | 是否生效 | 落地机制 |
| --- | --- | --- |
| `model.provider` / `model.modelId` | 是 | SDK `initialize` 的 provider/model（运行时校验路由） |
| `model.maxOutputTokens` | 是 | SDK `maxTokens` |
| `model.reasoningEffort` | 是 | SDK `reasoningEffort`（Provider 支持时） |
| `model.temperature` | 取决于 Provider 配置 | 见 `docs/RESEARCH-PROVIDER.md`；若 Provider 不支持按 Agent 配置，发布时给出 warning，**不静默忽略** |
| `prompt.system` | 是 | 受限 Profile 的 system prompt 插件注入（不进用户消息） |
| `prompt.welcome` | 前端 | 仅 UI |
| `capabilities.tools` | 是 | 策略快照 → `agent-policy` 的 allow/deny/ask |
| `capabilities.mcpServers` | 是 | 生成 profile patch 的 MCP 配置（只挂载被授权的服务器） |
| `capabilities.skills` | 是 | 只挂载被授权的 skill 目录 |
| `capabilities.subagents` | 强制 false | 受限 Profile 移除 subagent 插件；配置层直接拒绝开启 |
| `security.shell/fileRead/fileWrite/pluginManagement` | 是（只能 false） | 受限 Profile 移除对应插件；开启请求在发布校验时拒绝 |
| `security.networkAccess` | 部分 | `none` = 无 MCP/无出网工具；`restricted` = 只挂载白名单 MCP；`allowlist` 未实现时降级为 restricted 并 warning |
| `security.dataScope` | 业务 | 透传给业务工具做 L3 校验 |
| `limits.maxTurns` | 是 | 网关在事件流中统计轮次，超限关闭运行时并下发 `run.limit` |
| `limits.maxConcurrentRuns` | 是 | 网关会话级锁 |
| `limits.maxRequestsPerHour` | 是 | 网关按 user+agent 限流（DB 计数） |
| `ui.*` | 前端 | 仅 UI，不影响安全 |

---

## 7. 会话与运行时生命周期

- 业务 `sessionId` 与 DSH `sessionId` **分开存储**（`agent_sessions.dsh_session_id`）。
- 第一版：**一个业务会话一个 DSH 子进程**（隔离最清晰，取消/崩溃影响面最小）。运行时在首次发送消息时懒启动，空闲超时（默认 10 分钟）后回收。
- 恢复历史：`resumeSession(dshSessionId)`；不能只传旧 id 就当历史已恢复。
- 取消：SDK 没有中途取消单轮任务的接口。第一版"停止生成" = **关闭该会话的运行时进程**，并把会话标记为 `idle`，下次发送时重新启动 + resume。
- 运行时池化留给 P3，不在第一版范围。

---

## 8. 事件协议

- 前端只消费 `AgentEvent`（`packages/shared/src/events.ts`）：`run.started / message.delta / tool.started / tool.completed / approval.required / approval.decided / agent.completed / agent.failed / run.limit`。
- DSH 原始通知**绝不**透传；映射在 `DshEventAdapter`。
- 流式粒度以 SDK 实际能力为准（见 `docs/RESEARCH-SDK.md`）：如果 DSH 只能提供"已提交消息"级粒度，就如实按整条消息推送（`mode: 'message'`），**不允许**把最终答案切块冒充逐字流式。

---

## 9. 安全红线（代码评审清单）

1. 策略快照不可由 Agent 进程写；插件不读用户消息/模型输出作为权限来源。
2. 未知工具一律拒绝（`defaultAction = deny`）。
3. 网关的每个查询都必须带上 `user_id` 归属条件（会话、消息、审批、审计）。
4. 运行子进程的环境变量必须是**最小集**：`DSH_HOME`、`AGENT_STUDIO_*`、必要的 Provider 凭据；不继承开发者个人 `DSH_HOME`、不继承 shell 代理配置。
5. 前端传入的任何 `tool/agent/permission` 字段都视为不可信输入，必须过 zod 校验。
6. 审批超时/通道异常/撤销标记存在 → 拒绝。
7. 不允许把 `admin` 才能做的操作（发布、改策略、看审计）暴露给 `role=user`。

---

## 10. 已知风险与未完成项（P3）

| 风险 | 现状 | 缓解 |
| --- | --- | --- |
| DSH 处于 preview，API 可能变更 | 固定 `0.2.1-rc.3` | SDK 契约测试 + 版本升级清单 |
| 无 OS 级沙箱 | 只移除高权限插件 + 独立目录 + 最小环境变量 | 部署文档要求以低权限账户运行 |
| 每会话一个进程，资源占用高 | 第一版接受 | P3 引入按策略分组的运行时池 |
| 无逐字流式（若 SDK 不提供） | 按实际粒度推送 | 前端显示"生成中"状态而非模拟打字 |
| 多用户并发/SLA | 单机 SQLite | P3 换 PostgreSQL + 队列 |

---

## 11. 实现与验证后的修订（实测推翻了哪些假设）

以下条目在端到端验证后确定，**以这里为准**。验证证据见 `docs/VERIFICATION.md`。

### 11.1 流式粒度：确认没有 token 级增量

`0.2.1-rc.3` 的 56 个会话事件里没有任何 `*delta*`，最细粒度是**每个 step 一条已提交的
`assistant/message`**（其 `data.stream` 里是提交后才会出现的逐 delta 回放素材）。
因此网关只发 `message.delta{mode:'message'}`，**不模拟打字机**；前端按整段渲染。
（见 `docs/RESEARCH-SDK.md` §3）

### 11.2 审批：SDK 通道不存在，文件控制通道已验证可用

- 协议层 "Server→client requests are a dead capability"，`HarnessClient` 没有 `notify`；
- `sdk-minimal` 组合里没有任何 answerer，`kind:'ask'` 只会失败；
- 我们的实现：策略插件在 `tools/pre-execute`（异步 waterfall）里**等待决定文件**，
  实测「批准后工具成功 / 拒绝后工具失败 / 超时按拒绝」三条路径全部成立，
  且批准只对本次调用有效（`allowed-once`，不回写策略）。

### 11.3 权限字符串的原型污染风险

策略快照里的工具名来自网关写入的 JSON，插件按名查表时使用 `Set`/`Map` 与显式比对，
不经过原型链；`deny` 优先于 `allow`，且 `deny` 支持尾部通配（防止 `allow mcp__*`
被更细的 `deny` 绕过）。

### 11.4 运行时隔离的两个新增约束

1. **必须覆盖 `sandbox-policy.mode`**：`sdk-minimal` 的 bundle 把沙箱钉死为
   `danger-full-access`，模板里显式改成 `read-only` 并设置 `workspaceRoot`。
   （当前树没有 fs/bash 沙箱消费者，真实约束仍是"没有文件与命令工具"）
2. **宿主环境的 `DSH_PROFILE` 不能沿用**：DSH Desktop 会把该变量设为 `desktop`，
   网关若直接读取会去启动保留名 profile 并失败。网关改用自己的
   `AGENT_STUDIO_DSH_PROFILE`（默认 `studio`），子进程环境从零构造。

### 11.5 系统提示词与 AGENTS.md

- 提示词通过 `system-prompt.personaPrefix` 注入，模板里显式覆盖（不依赖 bundle 默认值），
  每个运行时再由 `runtime/patches/<runtimeId>/agent.cordis.yml` 覆盖为 Agent 配置里的
  `prompt.system`；**提示词不是权限**。
- `includeHarnessIdentity` / `includeRuntimeContext` 只影响 Harness 身份段与运行上下文，
  **不能**阻止读取 `AGENTS.md`/skills；真正的隔离来自 `sdk-minimal` 树里根本没有
  `dsh-agent-instructions` / `dsh-skill*` 插件，另外设置 `DSH_AGENTS_HOME` 指向运行时自己的目录。

### 11.6 补丁语义

- `insert` 只新增；禁用已有条目用 `disabled: true`（没有 remove）。
- 同一 id 的 `config` 是**整段替换**，覆盖时必须写全要保留的字段。
- **补丁行顺序没有加载语义**（服务可用性驱动激活）。因此"策略先于工具加载"不能靠
  insert 顺序保证，必须由 `ctx.tools.guard()` 的单调性保证——这也是实现方式。

### 11.7 凭据

- 解析顺序：托管文件 > 启动环境 > `<cwd>/.env` > `$DSH_HOME/.env`。
- 受限运行时用**环境变量** `DEEPSEEK_API_KEY`，且保证该 home 内没有 `.credentials.yaml`；
  因为受限 Agent 没有 shell 工具，取不到这个环境变量。若将来开 shell，必须改用托管文件。
- `temperature` 在 `0.2.1-rc.3` **无法按 Agent 配置**：发布时返回 warning，不静默忽略；
  `maxOutputTokens` 通过 `initialize.maxTokens` 生效。

### 11.8 审计语义

- 每次工具调用最多两条记录：策略决策行（`decision` + `status=started|denied`）与结果行
  （`status=succeeded|failed`）。
- **被拒绝的调用只保留策略那一行**（`status=denied`）：工具从未执行，再写一条 "failed"
  会在审计里双计并误报成执行失败。结果行只对真正进入执行流水线的调用写入。

### 11.9 配置落地矩阵的修订

上一版 §6 中"`sandbox`/`workspaceRoot` 构成目录限制"的表述**不准确**：
`dsh-fs-local` 的 cwd 不是隔离边界。现阶段的真实约束是"没有注册任何文件/命令工具"，
目录权限必须由部署方在 OS 层收紧。

