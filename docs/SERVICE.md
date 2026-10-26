# DSH Agent Service —— 实现规格

一个**可配置的 Agent 对话服务**：业务后端按项目/对话指定 Skills 与 MCP，前端通过统一
HTTP/SSE 接口调用。它不做 Agent 管理平台、不做鉴权、不做审批与审计。

```
业务前端（聊天组件 / GIS 工作台）
   │  REST + SSE（只依赖 5 个业务事件）
   ▼
DSH Agent Service（Node 24 + Fastify 5）
   │  ① 能力清单（skills / mcp-servers）  ② 项目与对话配置（JSON 文件）
   │  ③ 运行时池（按配置指纹复用）        ④ 对话编排与事件适配
   │ stdio JSON-RPC（@deepseek-ai/dsh-sdk-client）
   ▼
DSH Runtime（@deepseek-ai/dsh@0.2.1-rc.3，profile = agent-service）
   ├─ 原生 Session / Agent Loop / Provider
   ├─ Skills：dsh-skill + dsh-skill-filesystem + dsh-tool-skill
   ├─ MCP：dsh-mcp-client（每个被选中的服务器一个实例）
   └─ 业务工具：plugins/agent-tools（示例，可按需移除）
```

## 1. 范围

| 做 | 不做（交给业务后端/DSH） |
| --- | --- |
| 能力清单发现（skills、mcp-servers） | 用户、角色、登录、租户 |
| 项目级 / 对话级配置与继承 | Agent 版本、发布、草稿 |
| 对话创建、消息、SSE 事件 | 审批、审计（DSH 自己有会话日志） |
| 按配置指纹复用运行时、空闲回收 | 多机调度、队列、SLA |
| 把配置翻译成 DSH profile/patch | Skills 与 MCP 的实现本身 |

**部署边界**：默认监听 `127.0.0.1`，由业务后端调用；如需暴露到内网，设置
`INTERNAL_TOKEN` 后所有 `/api/*` 都要求 `Authorization: Bearer <token>`。这不是用户体系，
只是一个共享密钥。

## 2. 为什么"每个对话选不同 Skills"要落到运行时

`0.2.1-rc.3` 的 SDK 只有 `initialize(provider/model/maxTokens/reasoningEffort)`，**没有**按
会话传 `skills[]` / `mcpServers[]` 的入口；能力只能通过 profile + Cordis 插件组合决定。
因此：

- **Skills 过滤**：`dsh-skill-filesystem` 支持 `customSkillDirs` + `includeDefaultRoots:false`。
  服务为每个配置指纹建一个 `skills-view` 目录，只**复制**被选中的技能（目录 bundle 或单文件），
  运行时只看见这些技能。
- **MCP 挂载**：为每个被选中的服务器生成一个 `dsh-mcp-client` 插件条目（`serverName` 决定
  模型可见工具名 `mcp__<serverName>__<tool>`）。
- **复用**：相同配置指纹 = 相同 `DSH_HOME` + 相同 patch，可以承载多个会话；不同指纹必须
  不同的运行时（不同 home）。

配置指纹：

```
configKey = sha256(canonicalJson({
  skills: [...].sort(), mcpServers: [...].sort(),
  provider, model, systemPrompt
})).slice(0, 16)
```

目录布局（全部按 `configKey` 而不是按对话，才能"回收后还能 resume"）：

```
runtime/snapshots/<configKey>/
  home/                     DSH_HOME（profiles/agent-service、sessions/…）
  skills-view/              只含被选中技能的副本
  workspace/                cwd / 沙箱根 / 业务数据副本
  patches/agent.cordis.yml  系统提示词
  patches/mcp.cordis.yml    被选中 MCP 服务器
```

## 3. 配置

### 3.1 服务环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | HTTP |
| `DATA_DIR` | `<repo>/data` | store.json 与消息 JSONL |
| `RUNTIME_DIR` | `<repo>/runtime` | 快照目录（`snapshots/`） |
| `SKILLS_DIRS` | `<repo>/runtime/skills` | 逗号分隔的技能根目录（用于发现与复制） |
| `MCP_CONFIG` | `<repo>/config/mcp-servers.json` | MCP 服务器定义 |
| `DSH_BIN` | `<repo>/node_modules/@deepseek-ai/dsh/lib/bin.js` | DSH CLI |
| `AGENT_SERVICE_DSH_PROFILE` | `agent-service` | profile 名（不读宿主的 `DSH_PROFILE`） |
| `AGENT_SERVICE_PLUGIN_TOOLS` | `<repo>/plugins/agent-tools/dist/index.js` | 业务工具插件 |
| `AGENT_SERVICE_TOOLS_DATA_DIR` | `<repo>/runtime/tools` | 业务工具数据源（复制进快照） |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | – | Provider 凭据（只注入子进程环境） |
| `MOCK_LLM` | – | 非空 = 离线模式（配合 `npm run mock:llm`） |
| `RUNTIME_IDLE_MS` | `300000` | 空闲运行时回收（回收后同配置下次会 resume） |
| `TURN_TIMEOUT_MS` | `600000` | 单轮上限，超时按失败处理并关闭该运行时 |
| `INTERNAL_TOKEN` | – | 设置后 `/api/*` 要求 Bearer |
| `AGENT_SERVICE_MODEL_DISCOVERY` | `on` | `off` = 关闭向 DSH 询问模型清单（仅用缓存） |
| `AGENT_SERVICE_MODEL_PROBE` | gateway 构建产物 | 模型探针插件入口（一般不用改） |
| `DSH_SOURCE_HOME` | – | **既有 DSH home**（如 `C:\Users\me\.dsh`）；设置后启用"复用现有配置" |
| `DSH_SOURCE_PROFILE` | `desktop` | 源 profile 名（CLI 拒绝 dump `desktop`，服务会复制成临时导入 profile 再 dump） |
| `DSH_SOURCE_IMPORT_PROVIDERS` | `on` | 是否把源组合里的 provider 插件导入运行时 |
| `DSH_SOURCE_IMPORT_MCP` | `on` | 是否把源组合里的 MCP 服务器定义导入能力清单 |
| `MAX_RUNTIMES` | `8` | 运行时上限（超出先回收最久空闲） |
| `CORS_ORIGINS` | – | 逗号分隔的允许来源；默认同源 |
| `WEB_DIST` | `<repo>/apps/web/dist` | 测试页面产物 |
| `LOG_LEVEL` | `info` | |

### 3.2 `config/mcp-servers.json`

```json
{
  "servers": [
    {
      "id": "data-center",
      "name": "数据中心",
      "description": "查询数据集目录",
      "transport": "stdio",
      "command": "node",
      "args": ["scripts/mcp-data-center-server.mjs"],
      "env": { "DATA_CENTER_TOKEN": "${DATA_CENTER_TOKEN}" },
      "toolCallTimeoutMs": 30000,
      "enabled": true
    }
  ]
}
```

`${ENV}` 占位在**生成运行时配置时**从服务进程环境解析；解析不到就报错，不写空值。

### 3.2b 模型清单来自 DSH

provider / model **不写死在服务里**。`0.2.1-rc.3` 的 SDK 协议没有"列模型"的方法，
provider 由 Cordis 插件在运行时注册，模型目录由 adapter 提供（官方端点用 `/models`
列表，非官方端点用内建目录）。因此服务启动时：

1. 用同一个 profile 物化一个**探针快照**（`runtime/snapshots/_model-probe`）；
2. 起一个短命的 DSH 子进程，插入探针插件（`runtime/model-probe-plugin`），
   它等 provider 插件激活后调用 `ctx.llm.listProviders()` / `listModels()` 写结果文件；
3. 服务读取结果、写 `data/models.json` 缓存，然后杀掉探针进程（约 1~2s）。

规则：

- **默认路由** = 清单里第一个有模型的 provider 的首个模型；
- 配置里 `provider`/`model` 为空 → 用默认路由补全；
- 显式值不在清单里 → `400 MODEL_UNKNOWN`（附可用清单）；
- 清单不可用且没有显式值 → `503 MODEL_UNAVAILABLE`；有显式值则放行（运行时会给更精确的错误）；
- `GET /api/models?refresh=1` 强制重新发现（换 Provider / baseURL 后不用重启服务）。

### 3.2c 复用既有 DSH 配置（`DSH_SOURCE_HOME`）

设置 `DSH_SOURCE_HOME` 后，服务会**只读**导入你日常 DSH 的配置，不需要在服务里维护第二套：

| 能力 | 导入方式 |
| --- | --- |
| Skills | 直接扫 `<home>/skills`、`<home>/agents/skills`（作为额外技能根） |
| MCP | 把源 profile 的 manifest 复制成临时导入 profile（`<RUNTIME_DIR>/dsh-import/<hash>`，`node_modules` 用 junction 指回源 profile）后 `dsh --dump-config`，解析 `@deepseek-ai/dsh-mcp-client` 条目 |
| Provider | 从同一份组合里挑出 provider 插件条目（`llm-*` / `providers-hub` / `*-go`，跳过与内置冲突的 `llm-deepseek*`），作为独立 patch 插进每个运行时快照 |

- 导入的 provider 条目里若带 `!!js` 表达式，会**原样还原**成表达式（不求值、不落盘）；
- provider 声明的凭据变量优先取服务进程环境，其次取源 DSH 的 `.credentials.yaml` 里的 `refs`；
  两者都没有时只在 `/api/dsh-source` 里标为 `missing`，不阻断启动；
- `GET /api/dsh-source` 返回来源、导入的 provider/MCP 列表、凭据可用性（**只报变量名**）；
- 已验证：用真实 `~/.dsh`（desktop）导入后，运行时能正常启动并完成一轮对话；
  导入的第三方 provider 是否注册出模型取决于它依赖的服务是否齐备（见 `docs/VERIFICATION.md` §6）。

### 3.3 技能目录

```
runtime/skills/
  netcdf-analysis/
    SKILL.md            # YAML frontmatter + Markdown 正文
  gis-processing.md     # 也可以是单文件技能
```

`SKILL.md` 头：

```markdown
---
name: netcdf-analysis
description: 分析 NetCDF 文件中的海洋数值模拟结果
whenToUse: 需要读取 .nc 文件、计算流场或查看变量维度时
---

正文（给模型看的操作说明）……
```

## 4. 存储

没有数据库。

- `data/store.json`：`{ version, projects: { [id]: { config, updatedAt } }, conversations: { [id]: ConversationRecord } }`
  - 写入必须原子（tmp + rename），进程内串行化；
  - 启动时若 JSON 损坏 → 备份为 `store.json.corrupt-<ts>` 并以空状态启动（不静默覆盖）。
- `data/conversations/<id>.jsonl`：一行一条 `MessageDto`（追加写，单行 JSON）。
- `runtime/snapshots/<configKey>/`：运行时快照，可随时整体删除（下次重建）。

## 5. 运行时池

`RuntimePool`：

| 关注点 | 规则 |
| --- | --- |
| 复用键 | `configKey`（含 `capabilityRevision`：技能内容 / MCP 定义 / profile 模板变化都会换 key） |
| 并发冷启动 | 同 key 的初始化合并到同一个 Promise（10 个会话同时首启只会拉起 1 个运行时） |
| 承载 | 同一个运行时承载多个会话（每个对话一个 DSH session） |
| 会话创建 | 首次 `prompt` 时由 DSH 自动创建（SDK 对未知 sessionId 会创建） |
| 恢复 | 运行时被回收后重建（同 home），对已有 `sessionId` 先 `resumeSession()`；**失败一律 409 `SESSION_RESTORE_FAILED`，绝不静默新建空白会话** |
| 停止 | SDK 无单轮取消：`POST /conversations/:id/stop` 关闭承载它的运行时；同运行时上有其它对话在跑时返回 409 `RUNTIME_BUSY` |
| 事件路由 | 一个订阅，按 `notification.params.sessionId` → `conversationId` 反查 |
| 空闲回收 | 每 30s 扫描：`now - lastActiveAt > RUNTIME_IDLE_MS` 且无运行中对话 → `close()` |
| 失败处理 | 传输错误 → 该运行时上所有运行中对话收到 `message.failed`，实例销毁（下次重建） |
| 上限 | `MAX_RUNTIMES`（默认 8）：超出时先回收最久空闲的；无空闲可回收则 503 |

## 6. 事件映射（DSH 通知 → 业务事件）

| DSH | 业务事件 |
| --- | --- |
| 收到用户消息（本地已落库） | `message.started`（role=user） |
| `session.event` `assistant/message` | `message.completed`（`text` = 文本块拼接；同 `message.id` 去重） |
| `session.event` `tool/call` | `tool.started` |
| `session.event` `tool/result` | `tool.completed`（`message.isError` → success=false；文本是 JSON 时附带 `result`，并始终带截断的 `resultText`） |
| `session.event` `turn/end{reason.kind:'error'}` | `message.failed`（code=`TURN_ERROR`） |
| `session.status{status:'idle'}` | 本轮结束（SSE 关闭；若没有任何 assistant 文本则 `message.failed`） |
| 传输关闭 / 超时 | `message.failed`（code=`RUNTIME_CLOSED` / `TIMEOUT`） |

**禁止**伪造逐字流式：`message.completed` 就是一段完整助手文本。

## 7. HTTP API

统一前缀 `/api`。错误：`{ error: { code, message, details? } }`，code 用
`VALIDATION_ERROR | NOT_FOUND | CONFLICT | SKILL_UNKNOWN | MCP_UNKNOWN | MODEL_UNKNOWN | MODEL_UNAVAILABLE | SESSION_RESTORE_FAILED | RUNTIME_BUSY | RUNTIME_ERROR | SERVICE_TOKEN_INVALID | INTERNAL_ERROR`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version, dshVersion, runtimes, uptimeSec }` |
| GET | `/api/models` | **从 DSH 读取**的 provider / model 清单（`?refresh=1` 重新探测） |
| GET | `/api/skills` | 可用技能清单 |
| GET | `/api/mcp-servers` | 可用 MCP 服务器（含 `source: config | dsh-profile`） |
| POST | `/api/mcp-servers/:id/test` | MCP 连接测试（握手 + `tools/list`），body 可带 `timeoutMs` |
| GET | `/api/mcp-servers/:id/tools` | MCP 工具清单（同样走一次探测） |
| GET | `/api/dsh-source` | 既有 DSH 配置来源诊断（导入项 + 凭据可用性，只报变量名） |
| GET | `/api/projects/:projectId/agent-config` | 项目默认配置（未保存返回默认值 + `saved:false`） |
| PUT | `/api/projects/:projectId/agent-config` | 保存项目配置（body 为 patch） |
| POST | `/api/conversations` | 创建对话（返回 conversationId / sessionId / config 快照） |
| GET | `/api/conversations` | 历史列表（`?projectId=` 可选、`?limit=` 默认 50） |
| GET | `/api/conversations/:id` | 对话详情 |
| PATCH | `/api/conversations/:id` | 重命名（只改展示标题） |
| DELETE | `/api/conversations/:id` | 删除对话（运行中 409） |
| POST | `/api/conversations/:id/stop` | 停止当前轮次（关闭承载运行时；有其它对话在跑则 409 `RUNTIME_BUSY`） |
| GET | `/api/conversations/:id/config` | 配置快照 |
| PUT | `/api/conversations/:id/config` | 修改快照（**仅当对话还没有消息**，否则 409 `CONVERSATION_STARTED`） |
| GET | `/api/conversations/:id/messages` | 历史消息 |
| POST | `/api/conversations/:id/messages` | 发送消息 → **SSE** |
| GET | `/api/runtimes` | 运行时排障视图 |

创建对话请求/响应：

```jsonc
// POST /api/conversations
{
  "projectId": "ocean-project",
  "skills": ["netcdf-analysis"],          // 可选，与项目配置取并集
  "mcpServers": ["data-center"],          // 可选，与项目配置取并集
  "provider": "deepseek-official",        // 可选，覆盖项目值
  "model": "deepseek-flash",              // 可选，覆盖项目值
  "inheritProjectConfig": true            // 默认 true
}
// 201
{ "conversationId": "conv-…", "sessionId": "dsh-…", "config": { …snapshot } }
```

## 8. SSE 流程（`POST /api/conversations/:id/messages`）

1. 校验对话存在、状态为 `idle`（运行中 → 409 `CONVERSATION_RUNNING`）。
2. 校验 `content` 非空（zod）；落库 user 消息并 `message.started`。
3. 立即返回 `text/event-stream`（`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`）。
4. `RuntimePool.send()`：确保运行时、确保会话、`prompt()`。
5. 事件经 `SseHub` 写给该 SSE；15s 一次 `: ping` 注释帧。
6. 结束条件：`session.status{idle}`、`message.failed`、客户端断开、`TURN_TIMEOUT_MS`。
7. 客户端断开**不**终止运行时，只解绑 SSE（本轮继续跑完并落库，下次刷新可见）。
8. HTTP 状态：已进入流之前出错用 4xx/5xx JSON；进入流之后一律用 `message.failed` 事件。

## 9. 测试要求（vitest）

- `skills/catalog.test.ts`：目录 bundle / 单文件 / 非法 frontmatter / 重名优先级。
- `runtime/configKey.test.ts`：排序无关、字段敏感、稳定。
- `runtime/skillsView.test.ts`：只复制被选中的技能；未知技能报 `SKILL_UNKNOWN`。
- `runtime/mcpOverlay.test.ts`：stdio 与 streamable-http 两种渲染、`${ENV}` 解析、未知服务器报错。
- `store.test.ts`：原子写、损坏恢复、并发追加。
- `events.test.ts`：真实 DSH 事件 payload → 5 个业务事件（含去重、错误分支）。
- `api/*.test.ts`：注入式 HTTP 测试，覆盖上面的接口与错误码。
- `runtime/pool.test.ts`：**10 个同配置对话同时冷启动只拉起 1 个运行时**；恢复失败明确 409；
  `stop` 的唯一运行场景与 `RUNTIME_BUSY` 拒绝。
- `runtime/capabilityRevision.test.ts`：改 SKILL.md / MCP 定义 / profile 模板 → 版本与 configKey 变化。
- `runtime/mcpOverlay.test.ts`：渲染出的 YAML **不含真实凭据**，只有 `!!js process.env.X` 引用。
- `dsh/dshSource.test.ts`：provider/MCP 导入过滤、`${ENV}` 还原、凭据可用性、dump 失败降级。
- 不启动真实 DSH：真实链路由 `scripts/check-runtime.mjs` / `scripts/e2e-service.mjs` 覆盖。
