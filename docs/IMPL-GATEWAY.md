# Agent Gateway 实现规格（apps/gateway）

本文件是可执行的实现契约。实现必须与 `docs/DECISIONS.md`、`docs/RESEARCH-SDK.md`、
`docs/RESEARCH-PROFILE.md`、`docs/RESEARCH-TOOLS.md` 一致；冲突时以研究文档中的**已核实事实**为准，
并同步修正本文档。

技术栈：Node 24 + TypeScript(ESM, NodeNext) + Fastify 5 + `node:sqlite` + `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3`。
共享契约：`@agent-studio/shared`。禁止引入 ORM、禁止引入 native 依赖。

---

## 0. 目录与模块划分

```
apps/gateway/src/
  server.ts                 启动装配（config → db → repos → services → routes → listen → graceful shutdown）
  config.ts                 env 读取与默认值，启动时打印脱敏配置
  auth/tokens.ts            HMAC-SHA256 无状态令牌：base64url(payload).base64url(sig)
  auth/passwords.ts         scrypt($salt,$N=16384,r=8,p=1) hash / verify（timingSafeEqual）
  auth/guard.ts             Fastify preHandler：authenticate（必选）/ requireRole('admin')
  db/database.ts            DatabaseSync 封装：open、pragma(WAL, foreign_keys, busy_timeout)、迁移、事务
  db/migrations.ts          版本化 DDL（见 §2）
  db/seed.ts                幂等种子：admin/admin123、demo/demo123、示例 MCP（禁用）
  repositories/*.ts         users / agents / agentVersions / sessions / messages / approvals / audit / mcp / runtimes
  api/*.ts                  路由：auth / agents / catalog / mcp / sessions / messages / approvals / audit / health
  runtime/PolicyBuilder.ts  AgentConfig + 工具目录 → PolicySnapshot
  runtime/ToolCatalog.ts    业务工具目录(catalog.json) + DSH 内置 + MCP 工具 → ToolDescriptor[]
  runtime/RuntimeMaterializer.ts  生成 DSH_HOME / profile / patch / policy / control / workspace
  runtime/DshRuntimeManager.ts    每个业务会话一个运行时：ensure / prompt / stop / reap / status
  runtime/DshEventAdapter.ts      DSH 通知 → AgentEvent + 持久化副作用
  runtime/SseHub.ts               按 sessionId 的进程内事件总线（支持迟到订阅回放最近的 run.started）
  runtime/ApprovalBridge.ts       控制通道：tail 审批请求 → 事件 → 写决定 → 超时过期
  runtime/AuditTailer.ts          tail audit/tool-calls.jsonl → agent_tool_audit
  runtime/McpProbe.ts             stdio MCP 客户端（initialize + tools/list）用于工具发现与连通性测试
  services/AgentService.ts        创建/更新/发布/禁用 + 发布校验(warnings)
  services/SessionService.ts      归属校验、限流、并发锁、标题
  services/RunService.ts          发送消息：确保运行时 → prompt → 事件流 → 落库
  http/errors.ts                  统一错误响应 { error: { code, message, details? } }
```

要求：**不允许**在路由里直接 new SDK 对象；所有运行时访问经由 `DshRuntimeManager`。

---

## 1. 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 监听端口（绑定 127.0.0.1） |
| `HOST` | `127.0.0.1` | 默认只监听本机 |
| `DATA_DIR` | `<repo>/data` | SQLite 与日志 |
| `RUNTIME_DIR` | `<repo>/runtime` | `homes/ workspaces/ policies/` |
| `DSH_BIN` | `<repo>/node_modules/@deepseek-ai/dsh/lib/bin.js` | 子进程 CLI 入口 |
| `DSH_PROFILE` | `studio` | 受限 profile 名 |
| `AGENT_STUDIO_PLUGIN_POLICY` | `<repo>/plugins/agent-policy/dist/index.js` | 政策插件绝对路径 |
| `AGENT_STUDIO_PLUGIN_TOOLS` | `<repo>/plugins/agent-tools/dist/index.js` | 业务工具插件 |
| `AGENT_STUDIO_PLUGIN_AUDIT` | `<repo>/plugins/agent-audit/dist/index.js` | 审计插件 |
| `AUTH_SECRET` | 自动生成并落盘 `DATA_DIR/.auth-secret` | 令牌签名密钥 |
| `TOKEN_TTL_HOURS` | `12` | |
| `RUNTIME_IDLE_MS` | `600000` | 空闲回收 |
| `APPROVAL_TIMEOUT_MS` | `120000` | 审批超时（与 policy 快照同值） |
| `DSH_PERMISSION_MODE` | `workspace-write` | 透传给子进程；见 RESEARCH-SDK §5 |
| `MOCK_LLM` | 空 | 非空时启用 mock-LLM patch（离线测试） |
| `WEB_DIST` | `<repo>/apps/web/dist` | 存在则由网关托管静态前端 |

---

## 2. 数据库（`node:sqlite`，WAL）

迁移以 `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)` 记录，启动时顺序应用。
DDL（字段名必须一致）：

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','published','disabled')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  current_version INTEGER NOT NULL DEFAULT 0,
  draft_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_versions (
  agent_id TEXT NOT NULL REFERENCES agents(id), version INTEGER NOT NULL,
  config_json TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, warnings_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE agent_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL,           -- "<agentId>@<version>"
  tool_name TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('allow','deny','ask'))
);
CREATE UNIQUE INDEX ux_agent_permissions ON agent_permissions(version_id, tool_name);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL,
  config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL,
  dsh_session_id TEXT, runtime_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle','running','failed','closed')),
  title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ix_sessions_user ON agent_sessions(user_id, updated_at DESC);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  role TEXT NOT NULL, content TEXT NOT NULL, sequence INTEGER NOT NULL,
  tool_calls_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_messages_seq ON agent_messages(session_id, sequence);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  approval_id TEXT NOT NULL, tool TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  arguments_preview TEXT NOT NULL DEFAULT '', arguments_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','allowed','rejected','expired','cancelled')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by TEXT
);
CREATE INDEX ix_approvals_session ON approvals(session_id, created_at DESC);

CREATE TABLE agent_tool_audit (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL, user_id TEXT NOT NULL,
  call_id TEXT NOT NULL, tool TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL,
  arguments_preview TEXT NOT NULL DEFAULT '', arguments_digest TEXT NOT NULL DEFAULT '',
  error TEXT, duration_ms INTEGER, approval_id TEXT, at INTEGER NOT NULL
);
CREATE INDEX ix_audit_session ON agent_tool_audit(session_id, at DESC);
CREATE INDEX ix_audit_agent ON agent_tool_audit(agent_id, at DESC);

CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL,
  session_id TEXT NOT NULL, profile TEXT NOT NULL, home TEXT NOT NULL,
  workspace TEXT NOT NULL, policy_version INTEGER NOT NULL,
  pid INTEGER, status TEXT NOT NULL, started_at INTEGER NOT NULL, stopped_at INTEGER,
  last_error TEXT
);
```

所有列表查询必须带 `user_id` 条件（管理员按需放开）。JSON 列一律 `JSON.parse` 后过 zod 校验，
解析失败视为数据损坏并记录日志，不要静默降级。

---

## 3. 认证

- 令牌 = `base64url(JSON{sub,role,exp,iat}) + '.' + base64url(HMAC_SHA256(secret, payload))`；
  `timingSafeEqual` 比较；过期或签名错误 → 401。
- `POST /api/auth/login`：查用户 → verify 密码（失败也执行一次假验证以减少时序差异）→ 发令牌。
- 角色：`admin` 可管理 Agent / MCP / 查看审计 / 审批任意会话；`user` 只能看到 `published` 的 Agent、
  自己的会话与审批。
- 限流：`limits.maxRequestsPerHour` 按 (user, agent) 统计最近 1 小时的 `agent_messages.role='user'` 行数，
  超限返回 429 + `run.limit` 语义。
- 并发：同一会话同一时刻只允许一个运行；同一 (user, agent) 并发数超过 `maxConcurrentRuns` 返回 409。

---

## 4. 运行时物化（RuntimeMaterializer）

对每个（业务会话）运行时，在 `RUNTIME_DIR` 下创建：

```
homes/<runtimeId>/
  cordis.patch.yml                 # 可选：home 级 patch（一般为空文件或仅注释）
  profiles/studio/package.json     # { name, private, type: module, dsh: { profile: { bundles: [...] } } }
  profiles/studio/cordis.patch.yml # 插入 policy/tools/audit 插件 + 移除高权限插件（依据 RESEARCH-PROFILE）
  settings/…                       # 若研究文档要求
workspaces/<runtimeId>/            # Agent 的工作目录（空目录，作为 cwd/workspace）
policies/<agentId>@v<version>/<runtimeId>.json   # 不可变策略快照（§5）
```

同时写入 `controlDir = workspaces/<runtimeId>/.studio/control`（含 `approvals/`）与
`auditPath = workspaces/<runtimeId>/.studio/audit/tool-calls.jsonl`。

启动子进程时通过 SDK options 传入：

```ts
{
  dshBin: config.dshBin, profile: 'studio', dshHome: homeDir,
  patches: [profilePatchPath],          // 需要时再叠加 mock-LLM patch
  processCwd: workspaceDir, cwd: workspaceDir,
  provider, model, maxTokens, reasoningEffort,
  requestTimeoutMs: 0（不限，交给上层超时）, initializeTimeoutMs: 20000,
  env: { ...最小环境, DSH_HOME: homeDir, AGENT_STUDIO_POLICY: policyPath,
         AGENT_STUDIO_CONTROL_DIR: controlDir, AGENT_STUDIO_AUDIT_PATH: auditPath,
         AGENT_STUDIO_SESSION_ID, AGENT_STUDIO_USER_ID, AGENT_STUDIO_AGENT_ID,
         AGENT_STUDIO_AGENT_VERSION, DSH_PERMISSION_MODE }
}
```

`env` 必须**从零构造**：`PATH`、`SYSTEMROOT`、`TEMP`、`HOME`/`USERPROFILE`（指向 runtime home）、
Provider 凭据（从网关自己的配置注入，绝不透传开发者个人 `DSH_HOME`）。

---

## 5. 策略快照（PolicyBuilder）

`PolicySnapshot` 见 `packages/shared/src/policy.ts`。生成规则：

1. 仅包含 Agent 版本配置中 `capabilities.tools` 明确 `allow` / `ask` 的工具；其余一律不写（默认 deny）。
2. 任何 `security.shell|fileRead|fileWrite|pluginManagement` 为 true → 发布校验直接拒绝。
3. `capabilities.subagents` 必须为 false。
4. MCP 工具名统一为 `mcp__<serverId>__<toolName>`；允许 `mcp__<serverId>__*` 通配（插件端支持尾部通配）。
5. `ask` 只允许用于**有审批通道**的工具；否则发布时降级为 deny 并返回 warning。
6. `maxTurns` / `approvalTimeoutMs` / `maxToolCalls` 写入快照。
7. 版本号 = `agent.version`；快照文件名含 `runtimeId`，**永不覆盖**已发布的旧快照。

---

## 6. 事件适配（DshEventAdapter）

输入：`HarnessNotification[]`（线序）。按 `docs/RESEARCH-SDK.md` §10 映射：

| DSH 通知 / 事件 | AgentEvent | 落库 |
| --- | --- | --- |
| `session.status{status:'running'}` | `run.started`（每次非 running→running） | 会话置 running |
| `session.event` `turn/start` | 记录轮次计数；超过 `maxTurns` → `run.limit` 并停止运行时 | |
| `session.event` `assistant/message` | `message.delta{mode:'message', text}` | 追加 assistant 消息（按 `data.message.id` 去重） |
| `session.event` `tool/call` | `tool.started{callId,name,argumentsPreview}` | |
| `session.event` `tool/result` | `tool.completed{callId,success}` | 更新该消息的 toolCalls |
| `session.event` `turn/end{reason}` | `error|aborted` → `agent.failed`；`completed` → 等 idle | |
| `session.event` `approval/asked|decided` | 仅日志（不计入业务审批） | |
| `session.status{status:'idle'}` | `agent.completed{text: 最后一条 assistant 文本}` | 会话置 idle、更新 lastMessage |
| 传输错误 / `TransportClosedError` | `agent.failed{code:'runtime-closed'}` | 运行状态 failed |

**不允许**把 `finalResponse` 切块伪装成逐字流式；`message.delta` 的 `mode` 必须如实反映粒度。
`argumentsPreview` 需脱敏（截断 300 字符，键名含 `token|key|secret|password|authorization` 的值替换为 `***`）。

事件同时写入 `SseHub`（内存）与数据库；SSE 断线重连提供 `GET /api/sessions/:id/stream`（只推送新事件，
不重放历史，历史走 messages 接口）。

---

## 7. 审批桥（ApprovalBridge）

- 通过 `fs.watch(controlDir/approvals)` + 500ms 轮询兜底，发现 `*.request.json`：
  1. 校验 zod（`approvalRequestSchema`）；失败则写 `decision = rejected`（fail closed）并记审计；
  2. 落库 `approvals`（status=pending，expires_at 取文件内 `expiresAt` 与 `now+APPROVAL_TIMEOUT_MS` 的较小值）；
  3. 推送 `approval.required`（含 argumentsPreview、expiresAt）。
- `POST /api/approvals/:id/decision`：校验归属（会话属于当前用户或 admin）、状态为 pending、未过期；
  写 `<approvalId>.decision.json`（原子写：先写 `.tmp` 再 rename），落库、推 `approval.decided`。
- 定时扫描过期 pending → 写 `decision = rejected`（不是 allowed）、落库 expired、推事件。
- 网关启动时把遗留 pending 全部置 expired，并写拒绝决定文件（如果对应运行时仍在）。

---

## 8. HTTP API（与 `packages/shared/src/dto.ts` 完全一致）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 公开 | 登录 |
| GET | `/api/auth/me` | 登录 | |
| GET | `/api/health` | 公开 | `HealthResponse` |
| GET | `/api/agents` | 登录 | user 只见 published |
| POST | `/api/agents` | admin | |
| GET | `/api/agents/:id` | 登录 | 草稿仅 admin/owner |
| PUT | `/api/agents/:id` | admin | 更新草稿 |
| POST | `/api/agents/:id/publish` | admin | 生成版本 + warnings + 运行时健康检查 |
| POST | `/api/agents/:id/disable` `/enable` | admin | |
| GET | `/api/agents/:id/tools` | 登录 | 目录 + 当前 action |
| GET | `/api/catalog/tools` | 登录 | 全量工具目录 |
| GET/POST/PUT/DELETE | `/api/mcp[/:id]` | admin | |
| POST | `/api/mcp/:id/test` | admin | 用 McpProbe 列工具 |
| POST | `/api/agents/:id/sessions` | 登录 | 创建会话 |
| GET | `/api/sessions?agentId=` | 登录 | 自己的会话 |
| GET | `/api/sessions/:id` | 归属 | |
| GET | `/api/sessions/:id/messages` | 归属 | |
| POST | `/api/sessions/:id/messages` | 归属 | **SSE 响应**，见 §9 |
| GET | `/api/sessions/:id/stream` | 归属 | 订阅后续事件（重连用） |
| POST | `/api/sessions/:id/stop` | 归属 | 关闭该会话运行时 |
| GET | `/api/sessions/:id/approvals` | 归属 | |
| POST | `/api/approvals/:id/decision` | 归属 | |
| GET | `/api/audit/tool-calls` | admin | 分页筛选 |
| GET | `/api/runtime/status` | admin | |

错误统一 `{ error: { code, message, details? } }`；`code` 用大写下划线（`UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `RUNTIME_ERROR`, `INTERNAL_ERROR`）。

---

## 9. SSE 发送流程（`POST /api/sessions/:id/messages`）

1. 校验归属 / 会话状态（非 idle 返回 409）/ 限流 / 并发。
2. 落库 user 消息（sequence+1），标题首条消息自动生成（截断 40 字）。
3. 立即返回 `text/event-stream`：`Content-Type: text/event-stream; charset=utf-8`、
   `Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
4. `RunService` 启动（或复用）运行时并 `prompt`；所有事件通过 `SseHub` 订阅写入响应。
5. 心跳：每 15s 写 `: ping\n\n` 注释帧；客户端断开则解除订阅（**不要**因此关闭运行时）。
6. 结束时保证推送一个终止事件（`agent.completed` / `agent.failed` / `run.limit`），随后 `res.end()`。
7. 运行时不可用 → 先写 `agent.failed` 再结束，HTTP 状态仍是 200（已经进入流）。

---

## 10. 发布校验（AgentService.publish）

返回 `AgentVersionDto`，其中 `warnings: ConfigWarning[]`。校验项：

- 必填：name、prompt.system 非空、model.provider/modelId 非空。
- 禁止：`security.*` 为 true、`subagents` 为 true、`capabilities.tools` 含未在目录中的工具、
  `mcpServers` 含不存在或 disabled 的服务器、`ask` 用于无审批通道工具（降级 deny + warning）。
- 警告：`temperature` 无法落实（见 RESEARCH-PROVIDER）、`networkAccess='allowlist'` 未实现、
  `skills` 非空但受限 profile 未挂载 skill 插件、`ui.allowAttachments=true` 但网关未实现上传。
- 发布时**不启动**用户会话，但要求：物化 profile + `--dump-config`（或等价检查）确认自定义插件在配置树中；
  失败 → 抛 409 `RUNTIME_ERROR`，版本不落库。

---

## 11. 退出与清理

`SIGINT/SIGTERM`：停止接受新请求 → 结束所有 SSE → 逐个 `close()` 运行时（并发上限 4）→ 关闭数据库 → 退出。
进程崩溃后重启时：`runtime_instances.status='running'` 的记录一律置 `stopped`（孤儿子进程由 SDK 的
dispose ladder 处理；额外做一次按 `pid` 的清理尝试）。

---

## 12. 测试（必须提供）
- `api/auth.test.ts`：登录成功/失败/令牌过期/角色隔离。
- `repositories/*.test.ts`：迁移幂等、会话归属隔离。
- `runtime/PolicyBuilder.test.ts`：通配 MCP 工具、ask 降级、禁止项拒绝。
- `runtime/DshEventAdapter.test.ts`：用**真实 DSH 事件 payload 样例**（从 RESEARCH-SDK 的原文结构构造）验证映射
  与去重；覆盖 `turn/end.error`、`interrupted`、重复 `assistant/message`。
- `services/RunService.test.ts`：用假的 RuntimeManager 验证事件流顺序与终止事件。
- 全部用 vitest，`npm test` 在仓库根可跑。测试不得联网、不得启动真实 DSH（真实链路放到 `scripts/smoke-run.mjs`）。

---

## 13. 实现修订（端到端验证后）

以下三条与本文件前面的契约描述不一致，**以本节为准**（它们让前端与后端的契约保持一致）：

1. `GET /api/auth/me` 直接返回 `UserDto`，不再包一层 `{ user }`（web 端按 `UserDto` 解析）。
2. `GET /api/catalog/tools` 返回 `{ tools: ToolDescriptor[] }`（与方案原文一致），不是 `{ total, items }`。
3. `POST /api/approvals/:id/decision` 的路径参数既接受**数据库审批行 id**，也接受插件生成的
   **`approvalId`**：SSE 事件里给前端的是后者，管理端列表里给的是前者，两者都必须可用。

另外两条实现约定：

- **业务数据快照**：`RuntimeMaterializer` 在物化运行时把 `<repo>/runtime/tools/*.json` 复制到
  `<workspace>/.studio/data`，并通过 `AGENT_STUDIO_TOOLS_DATA_DIR` 指向它。运行时只能看到自己的副本，
  这也是将来按 `security.dataScope` 裁剪数据的落点。
- **宿主环境隔离**：配置项改名为 `AGENT_STUDIO_DSH_PROFILE`（默认 `studio`）。宿主
  （DSH Desktop）会导出 `DSH_PROFILE=desktop`，若沿用会让网关去启动保留名 profile 并失败。

验证结果见 `docs/VERIFICATION.md`。
