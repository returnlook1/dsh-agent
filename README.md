# DSH Agent Service

一个**可配置的 Agent 对话服务**：业务后端按"项目 / 对话"指定要用的 **Skills** 与 **MCP 服务器**，
前端通过统一的 HTTP + SSE 接口调用。模型调用、Agent Loop、Session、Skills、MCP 全部由
DeepSeek Harness（DSH）负责，本服务只做**配置管理 + SDK 适配 + HTTP/SSE 接口 + 一个测试页面**。

不做的事（有意为之）：不做 Agent 管理平台、不做用户/角色/登录、不做审批与审计、
不做 Agent 版本发布。这些属于业务后端，或由 DSH 自己的会话日志承担。

```
业务前端（聊天组件 / GIS 工作台）
   │  REST + SSE（只依赖 5 个业务事件）
   ▼
DSH Agent Service（Node 24 + Fastify 5）
   │  能力清单 · 项目/对话配置 · 运行时池 · 事件适配
   ▼
DSH Runtime（@deepseek-ai/dsh@0.2.1-rc.3）
   └─ 原生 Agent Loop / Session / Provider
      + Skills（dsh-skill + skill-filesystem + tool-skill）
      + MCP（选中服务器各一个 dsh-mcp-client 实例）
      + 业务工具（plugins/agent-tools，示例，可删）
```

## 1. 快速开始

```powershell
# 安装（仓库根目录）
npm install --cache .npm-cache --no-audit --no-fund --ignore-scripts

# 构建 + 生成演示数据
npm run build
npm run data:demo
```

### 离线运行（无需 API Key）

```powershell
# 终端 A：本地 mock 模型（第一次请求会要求调用工具，之后返回文本）
npm run mock:llm

# 终端 B：服务
$env:MOCK_LLM='1'
$env:DEEPSEEK_API_KEY='mock-key'
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:8899/v1'
npm start
```

打开 **http://127.0.0.1:8787** → Agent Playground：左侧选项目、Skills、MCP、模型 → 新建对话 →
发消息，右侧能看到助手回复与工具调用卡片。

### 接入真实模型

```powershell
$env:DEEPSEEK_API_KEY='<你的 key>'
$env:DSH_PROVIDER='deepseek-official'
$env:DSH_MODEL='deepseek-flash'   # 必须以 Provider 实际模型名为准
npm start
```

## 2. 两级能力配置

| 层级 | 存在哪里 | 作用 |
| --- | --- | --- |
| 项目级 | `data/store.json` 的 `projects[projectId]` | 项目默认能力，项目下新对话默认继承 |
| 对话级 | 创建对话时冻结的**配置快照** | 覆盖/扩展项目配置；对话开始后不可改 |

```jsonc
// PUT /api/projects/ocean-project/agent-config
{
  "skills": ["netcdf-analysis", "gis-processing"],
  "mcpServers": ["data-center"],
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "systemPrompt": "你是海洋环境分析助手。"
}
```

合并规则（在 `packages/shared/src/agent-config.ts` 的 `mergeAgentConfig`，有单测）：

- `skills` / `mcpServers`：**并集**（扩展）；
- `provider` / `model` / `systemPrompt`：对话值优先，缺省回落到项目值；
- `inheritProjectConfig: false` 时完全不看项目配置。

**对话开始后配置不可变**：`PUT /api/conversations/:id/config` 只在还没有消息时生效，
否则返回 `409 CONVERSATION_STARTED`。要换能力就新开一个对话——已有会话不会因为配置变更
而"中途换脑子"。

## 3. 模型从哪来（DSH 是唯一事实来源，页面可从 DSH 的清单里选）

provider / model **不在服务里写死**，也不在前端写死：

- 服务启动时用一个**探针插件**在真实 DSH 子进程里问 `ctx.llm.listProviders()` / `listModels()`，
  结果缓存在内存与 `data/models.json`；
- **候选集合与默认值都来自 DSH**：Playground 的两个下拉只列 `/api/models` 里的 provider/model，
  默认值取 DSH 的 `agent-default-model`（设置 `DSH_SOURCE_HOME` 时读源组合）；
- 选了就生效（`routeSource=user-selected`），不选就用 DSH 默认（`dsh-default-model`）；
  选了清单外的值 → `400 MODEL_UNKNOWN`；
- 服务不维护自己的供应商目录、不存 API Key；DSH 默认模型在运行时不可用 →
  创建对话返回 `503 MODEL_UNAVAILABLE`（不悄悄换模型），按提示把 provider 插件装进
  服务 profile：`dsh plugin --profile agent-service add <包名>`；
- 官方端点下模型目录来自 `/models` 列表，自建端点/mock 下来自 adapter 内建目录——
  换 Provider、换 baseURL、升级 DSH 都不需要改代码。

```
GET /api/models
{ "providers": [ { "id": "deepseek-official", "name": "DeepSeek",
                   "models": [ { "id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash" },
                               { "id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro" } ] } ],
  "default": { "provider": "deepseek-official", "model": "deepseek-flash" },
  "source": "live" }
```

## 3b. 复用你现有的 DSH 配置

设置一个环境变量即可，不用在服务里重新维护 Skills / MCP / Provider：

```powershell
$env:DSH_SOURCE_HOME = "$env:USERPROFILE\.dsh"
$env:DSH_SOURCE_PROFILE = 'desktop'
npm start
```

- **Skills**：直接扫源 home 的 `skills/`、`agents/skills/`；
- **MCP**：把源 profile 复制成临时导入 profile 跑一次 `dsh --dump-config`，解析其中的
  `@deepseek-ai/dsh-mcp-client` 条目（`node_modules` 用 junction 指回源 profile）；
- **Provider**：从同一份组合里挑出 provider 插件（跳过与内置 `llm-deepseek*` 冲突的），
  作为独立 patch 插进运行时快照；`!!js` 表达式原样保留，凭据只从环境或源
  `.credentials.yaml` 读入子进程环境；
- `GET /api/dsh-source` 能看到导入了什么、凭据是否可解析（**只报变量名**）。

> 运行时仍然跑在服务自己的快照 home 里，**不会**共享你的个人 `DSH_HOME` 与其会话/权限。

## 4. Skills 与 MCP 是怎么生效的

`0.2.1-rc.3` 的 SDK 只有 `initialize(provider/model/maxTokens)`，**没有**按会话传
`skills[]` / `mcpServers[]` 的入口；能力只能由 profile + Cordis 插件组合决定。所以：

- **Skills**：服务把被选中的技能**复制**到 `runtime/snapshots/<configKey>/skills-view/`，
  运行时只挂这个目录（`includeDefaultRoots:false`）。没被选中的技能对模型完全不可见
  （实测调用返回 `skill "xxx" is unknown or no longer available`）。
- **MCP**：服务为每个被选中的服务器生成一个 `dsh-mcp-client` 插件条目，模型看到的工具名是
  `mcp__<serverId>__<tool>`。没挂载的服务器，其工具就不存在（调用会失败）。
- **复用**：配置指纹相同 = 同一个 `DSH_HOME` + 同一份 patch = 同一个运行时，可承载多个会话；
  配置不同 = 不同运行时。

技能就是一个目录或单文件（DSH 原生约定）：

```
runtime/skills/
  netcdf-analysis/SKILL.md     # 目录 bundle
  model-analysis.md            # 单文件技能
```

`SKILL.md` 头部的 frontmatter 至少要有 `name` 与 `description`，可选 `whenToUse`：

```markdown
---
name: netcdf-analysis
description: 分析海洋数值模拟与观测的 NetCDF 数据
whenToUse: 需要读取 .nc 文件、计算流场统计量时
---
正文……
```

MCP 服务器定义在 `config/mcp-servers.json`（支持 stdio 与 streamable-http；`${ENV_NAME}` 从服务
进程环境取值，`${REPO_ROOT}` 指向仓库根）。仓库自带一个**离线可运行**的示例服务器
`scripts/mcp-data-center-server.mjs`（`search_dataset` / `get_dataset_meta` / `get_flow_field`）。

## 5. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含 DSH 版本） |
| GET | `/api/models` | **从 DSH 读取**的 Provider / 模型清单（`?refresh=1` 重新探测） |
| GET | `/api/skills` | 可用技能清单 |
| GET | `/api/mcp-servers` | 可用 MCP 服务器（标注来源：配置文件 / DSH Profile） |
| POST | `/api/mcp-servers/:id/test` | 连接测试：握手 + `tools/list`（可能 20s） |
| GET | `/api/mcp-servers/:id/tools` | 工具清单（含参数 Schema） |
| GET | `/api/dsh-source` | 既有 DSH 配置来源诊断（只报变量名，不报凭据） |
| GET / PUT | `/api/projects/:projectId/agent-config` | 项目默认能力 |
| POST | `/api/conversations` | 创建对话（返回 conversationId / sessionId / 配置快照） |
| GET | `/api/conversations?projectId=` | 历史对话列表 |
| GET | `/api/conversations/:id` | 对话详情 |
| GET / PUT | `/api/conversations/:id/config` | 配置快照（仅在未开始时可改） |
| GET | `/api/conversations/:id/messages` | 历史消息 |
| POST | `/api/conversations/:id/messages` | 发送消息 → **SSE** |
| GET | `/api/runtimes` | 运行时排障视图 |

SSE 只发 5 个业务事件，前端**不需要**理解 DSH 的原始通知：

```
message.started    { conversationId, messageId, role }
message.completed  { conversationId, messageId, text }
tool.started       { conversationId, callId, tool, argumentsPreview }
tool.completed     { conversationId, callId, tool, success, error?, durationMs? }
message.failed     { conversationId, message, code? }
```

创建对话 / 发消息：

```bash
curl -X POST http://127.0.0.1:8787/api/conversations \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"ocean-project","skills":["netcdf-analysis"],"mcpServers":["data-center"]}'

curl -N -X POST "http://127.0.0.1:8787/api/conversations/conv-…/messages" \
  -H 'Content-Type: application/json' \
  -d '{"content":"查询长江口今天的流场数据"}'
```

> **没有逐字流式**：DSH 在 `0.2.1-rc.3` 里每个 step 只提交一条 `assistant/message`，
> 所以 `message.completed` 就是"一段完整文本"，前端不要做打字机模拟。

完整契约与错误码见 [docs/SERVICE.md](docs/SERVICE.md)。

## 6. 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 默认只监听本机，由业务后端调用 |
| `DATA_DIR` | `<repo>/data` | `store.json` 与消息 JSONL |
| `RUNTIME_DIR` | `<repo>/runtime` | 运行时快照（`snapshots/<configKey>/`） |
| `SKILLS_DIRS` | `<repo>/runtime/skills` | 技能根目录（逗号分隔） |
| `MCP_CONFIG` | `<repo>/config/mcp-servers.json` | MCP 服务器定义 |
| `DSH_BIN` | `<repo>/node_modules/@deepseek-ai/dsh/lib/bin.js` | DSH 入口 |
| `AGENT_SERVICE_DSH_PROFILE` | `agent-service` | 运行时 profile（不读宿主 `DSH_PROFILE`） |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | – | Provider 凭据，只注入子进程环境 |
| `MOCK_LLM` | – | 非空 = 离线模式 |
| `RUNTIME_IDLE_MS` | `300000` | 空闲运行时回收（回收后同配置下次自动 resume） |
| `TURN_TIMEOUT_MS` | `600000` | 单轮上限 |
| `AGENT_SERVICE_MODEL_DISCOVERY` | `on` | `off` = 关闭向 DSH 探测模型清单（只用缓存） |
| `DSH_SOURCE_HOME` / `DSH_SOURCE_PROFILE` | – / `desktop` | 复用既有 DSH 配置（Skills/MCP/Provider） |
| `DSH_SOURCE_IMPORT_PROVIDERS` / `_MCP` | `on` | 是否导入对应的定义 |
| `INTERNAL_TOKEN` | – | 设置后 `/api/*` 要求 `Authorization: Bearer` |
| `CORS_ORIGINS` | – | 允许的前端来源（逗号分隔），默认同源 |
| `WEB_DIST` | `<repo>/apps/web/dist` | 测试页面产物 |

## 7. 验证

```powershell
npm run typecheck        # 全部包类型检查
npm test                 # 单元测试（不联网、不启动 DSH）
npm run check:runtime    # 真实 DSH 运行时：技能可见性 + MCP 工具
npm run e2e              # 真实 HTTP/SSE：配置继承/复用/MCP 隔离
npm run verify           # 以上全部
```

最近一次结果见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 8. 目录结构

```
apps/gateway/            Agent Service（Fastify + JSON 存储 + 运行时池）
apps/web/                Agent Playground（Vue3 + Semi Design）
packages/shared/         前后端共用契约（配置 / 对话 / 事件 / 消息）
plugins/agent-tools/     示例业务工具（可删除）
runtime/templates/       agent-service profile 模板（DSH 组合，单一事实来源）
runtime/skills/          示例技能（netcdf-analysis / gis-processing / model-analysis）
runtime/tools/           业务工具演示数据
config/mcp-servers.json  MCP 服务器定义
scripts/                 mock 模型、MCP 示例服务器、运行时检查、e2e
docs/                    服务规格、决策记录、DSH 研究结论
```

## 9. 已知边界

| 边界 | 说明 |
| --- | --- |
| 无鉴权 | 默认只监听 `127.0.0.1`；需要内网暴露时设 `INTERNAL_TOKEN`。用户/项目权限由业务后端校验 |
| 单机 | 一个进程 + JSON 存储；没有多机调度与队列 |
| 无逐字流式 | DSH 不提供 token 级增量（见上） |
| 停止语义 | SDK 没有单轮取消接口：`stop` = 关闭承载该对话的运行时；同运行时上还有别的对话在跑时返回 409 `RUNTIME_BUSY`（不误伤） |
| 会话恢复 | 历史会话恢复失败会明确报 409 `SESSION_RESTORE_FAILED`，不会静默开一个空白会话 |
| 配置变更 | 已开始的对话不能换能力；新开对话生效 |
| MCP | 支持 stdio 与 streamable-http；未做 OAuth/凭据托管 |

## 10. 文档

| 文档 | 内容 |
| --- | --- |
| [docs/SERVICE.md](docs/SERVICE.md) | 服务规格：配置、存储、运行时池、事件映射、API、SSE、测试要求 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 决策记录：分层、快照、从平台版精简的原因 |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 验证报告：命令、场景、断言、结果 |
| [docs/RESEARCH-SDK.md](docs/RESEARCH-SDK.md) | DSH SDK 0.2.1-rc.3 实测结论 |
| [docs/RESEARCH-PROFILE.md](docs/RESEARCH-PROFILE.md) | profile/patch 组合与受限树 |
| [docs/RESEARCH-PROVIDER.md](docs/RESEARCH-PROVIDER.md) | 凭据、生成参数、离线 mock 配方 |
| [docs/RESEARCH-TOOLS.md](docs/RESEARCH-TOOLS.md) | 工具 API 实测（`defineTool` / `pre-execute` / `guard`） |
