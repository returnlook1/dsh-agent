# 验证报告

DSH Agent Service 的可复现验证：跑了什么、断言什么、结果如何。
数字来自本机实际执行（Windows，Node `v24.21.0`，DSH `0.2.1-rc.3`）。

- 模型：`@deepseek-ai/dsh-llm-mock-server`（进程内 mock，无网络、无 API Key）
- 技能：`runtime/skills/`（netcdf-analysis、gis-processing、model-analysis）
- MCP：`config/mcp-servers.json` 里的 `data-center`（仓库自带的离线示例服务器）
- 业务工具：`plugins/agent-tools`（4 个）

---

## 1. 总览

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（4 个包） | `npm run typecheck` | ✅ 0 错误 |
| 单元测试 | `npm test` | ✅ 19 文件 / **209 用例** |
| 运行时检查（真实 DSH） | `npm run check:runtime` | ✅ **12 项断言** / 3 个场景 |
| 端到端（真实 HTTP+SSE） | `npm run e2e` | ✅ **72 项断言** / 2 个阶段 |
| 前端构建 | `npm run build:web` | ✅ `dist/`（JS gzip 149 kB，CSS gzip 79 kB） |
| 手工演示 | `npm run demo` | ✅ 选技能 → 发消息 → 工具调用 → 回答（见 §5） |

一次性全跑：`npm run verify`。

---

## 2. 单元测试（211 用例）

| 范围 | 用例 | 覆盖点 |
| --- | --- | --- |
| `apps/gateway/tests/skills/catalog` | 6 | 目录 bundle / 单文件 / 非法 frontmatter / 重名优先级 |
| `apps/gateway/tests/runtime/configKey` | 5 | 数组顺序无关、字段敏感、稳定 |
| `apps/gateway/tests/runtime/skillsView` | 9 | 只复制选中的技能、未知技能报错、单文件技能 |
| `apps/gateway/tests/runtime/mcpOverlay` | 10 | `!!js` 引用渲染、**YAML 不含真实凭据**、`${REPO_ROOT}` 展开、缺变量 fail closed、探测目标 |
| `apps/gateway/tests/store` | 10 | 原子写、损坏备份、并发追加、消息序号 |
| `apps/gateway/tests/events` | 12 | DSH 事件 → 5 个业务事件、`assistant/message` 去重、`turn/end{error}`、工具配对 |
| `apps/gateway/tests/runtime/pool` | 14 | 复用/上限/回收/resume/传输错误广播；**10 并发冷启动只起 1 个运行时**；恢复失败 409；`stop` 与 `RUNTIME_BUSY` |
| `apps/gateway/tests/runtime/capabilityRevision` | 5 | SKILL.md / MCP 定义 / profile 模板变化 → 版本与 configKey 变化 |
| `apps/gateway/tests/dsh/dshSource` | 12 | provider/MCP 导入过滤、`${ENV}` 还原、凭据可用性、dump 失败降级 |
| `apps/gateway/tests/api/service` | 25 | 全部接口与错误码（400/401/404/409/503） |
| `apps/gateway/tests/models/*` | 24 | 探针输出解析、默认路由、`MODEL_UNKNOWN`/`MODEL_UNAVAILABLE`、缓存与降级 |
| `apps/gateway/tests/api/models` | 7 | `GET /api/models`、不传模型落默认路由、未知 provider/model 400 |
| `plugins/agent-tools` | 27 | 参数边界、站点白名单、确定性输出、目录一致性 |
| `apps/web/tests` | 16 | SSE 解析（分块/CRLF/`: ping`/多行 data/`message.failed` 提前终止）、事件归并、409、历史回放 |

---

## 3. 运行时检查（`npm run check:runtime`）

每个场景按服务的方式物化一个快照（独立的 `DSH_HOME` + `skills-view` + 补丁），用 mock 模型
驱动**真实 DSH 子进程**：

| 场景 | 模型要求调用 | 期望 | 实际 |
| --- | --- | --- | --- |
| `skill` | `skill{name:"netcdf-analysis"}` | 能加载被选中的技能 | ✅ 工具成功 |
| `skill-hidden` | `skill{name:"gis-processing"}` | 未选中的技能不可见 | ✅ 失败：`skill "gis-processing" is unknown or no longer available` |
| `mcp` | `mcp__data-center__search_dataset` | 被选中的 MCP 工具可调用 | ✅ 工具成功，返回数据集列表 |

这组断言证明了本服务最关键的设计：**能力隔离靠"运行时里有什么"实现**，
不是靠提示词请求模型"不要用"。

---

## 4. 端到端（`npm run e2e`）

真实 Fastify 进程 + 真实 DSH 子进程 + mock 模型，全部通过 HTTP/SSE 驱动。

### 4.1 阶段 A（37 项断言）

- `/api/skills` 返回 3 个技能（含 description 与 roots）；
- `/api/mcp-servers` 返回 `data-center`（enabled）与 `gis-service`（disabled）；
- 项目配置：未保存时 `saved:false` → PUT → GET 回读一致；
- 未知技能/服务器 → `400 SKILL_UNKNOWN` / `400 MCP_UNKNOWN`；
- 创建对话 201，快照**继承项目 skills**、带 `configKey` 与 `inheritedFromProject`；
- 未开始时 `PUT /config` 可改（并再次改回）；**已开始后返回 409 `CONVERSATION_STARTED`**；
- 发消息 SSE 实测序列：`message.started → tool.started → tool.completed → message.completed`，
  工具名 `skill` 且成功；
- 历史消息：user + assistant，assistant 带 `toolCalls`；
- 运行时复用：同配置的第二个对话也跑一轮后，`/api/runtimes` 仍只有 **1 个**运行时，
  `conversationCount = 2`。

### 4.2 阶段 B（11 项断言）

- 选中 `data-center` 的对话：模型调用 `mcp__data-center__search_dataset` 成功；
- `inheritProjectConfig:false` 的对话：`skills` 为空、`configKey` 与前者不同；
- 该对话再请求同一个 MCP 工具 → **失败，错误码 `UNKNOWN_TOOL`**（工具根本不存在）；
- `/api/runtimes` 变为 **2 个**运行时，MCP 运行时的 `mcpServers` 含 `data-center`。

---

## 4.3 模型清单来自 DSH（实测）

`npm run demo` 启动时服务会向真实 DSH 询问模型清单，实际观察：

```
GET /api/models
source: live
default: deepseek-official / deepseek-flash
provider: deepseek-official [DeepSeek] models=deepseek-flash,deepseek-v4-pro
```

- 探针进程在 provider 激活后返回（`providerWaitMs ≈ 160ms`，整体约 1.2s）；
- 项目配置未保存时返回的默认值就是清单里的默认路由；
- 创建对话不传 provider/model → 快照里是 `deepseek-official / deepseek-flash`；
- `model: "gpt-4o"` → `400 MODEL_UNKNOWN`，details 带 `availableModels`；
- `provider: "openai"` → `400 MODEL_UNKNOWN`，details 带可用 provider；
- `GET /api/models?refresh=1` → 重新探测（`source: live`）。

## 5. 手工演示（`npm run demo`，离线）

`scripts/demo.mjs` 一条命令起 mock 模型 + 服务，并给项目 `default` 种一份演示配置
（skills = netcdf-analysis, gis-processing；mcp = data-center）。实际观察：

```
health: {"ok":true,"version":"2.0.0","dshVersion":"0.2.1-rc.3","runtimes":0,"uptimeSec":20}
GET /                     -> 200 (index.html)
GET /c/<id>               -> 200 (SPA 回退到 index.html)
GET /assets/index-…js     -> 200 (435 KB)
POST /api/conversations   -> configKey=1568900ba4f6fbc5 skills=netcdf-analysis,gis-processing mcp=data-center
SSE: message.started -> tool.started -> tool.completed -> message.completed
final: 已完成。这是一段来自本地 mock 模型的示例回答。
messages: 2（user / assistant，assistant.toolCalls = ["skill"]）
runtimes: 1 个（skills=netcdf-analysis/gis-processing, mcp=data-center）
```

---


---

## 6. 评审修复的验证证据

| 修复 | 证据 |
| --- | --- |
| 并发冷启动 | 单测：10 个对话同时 `send()`，`pool.status()` 只有 1 个运行时、`conversationCount=10` |
| 会话恢复失败 | 单测：`resumeSession` 抛错时 `send()` 抛 `SESSION_RESTORE_FAILED`，且 `prompts` 为空（没有偷偷新建会话） |
| MCP 凭据 | 单测：生成的 `mcp.cordis.yml` 含 `!!js process.env.*`，不含 `super-secret` / `secret-token` |
| 能力版本 | 单测：追加 SKILL.md 内容 / 改 MCP args / 改模板 → `capabilityRevision` 与 `configKey` 均变化 |
| 复用既有 DSH 配置 | 真实 `~/.dsh` + `desktop` 实测：`GET /api/dsh-source` 导入 `llm-pi-ai` / `dsh-providers-hub` / `dsh-opencode-go`，`opencode` 账号凭据在 `.credentials.yaml` 中可解析；运行时正常启动并完成一轮对话（mock 模型）。生成快照的 `providers.cordis.yml` 只有变量名、无凭据值 |
| MCP 连接测试 | e2e：`POST /api/mcp-servers/data-center/test` 成功，返回 `protocolVersion` 与 `search_dataset`；`GET .../tools` 同样可用；未知服务器 404 |
| 结构化工具结果 | e2e：`tool.completed` 带 `result`（含 `matches` 数组）与 `resultText` |
| 停止 / 重命名 / 删除 | e2e：空闲对话 `stop` 返回 `runtimeClosed:false`；`PATCH` 改名生效；`DELETE` 返回 204 且再查询 404 |
| 供应商/模型归 DSH | 单测：默认路由可用时采用；默认不可用时报错并提示装插件；无默认用清单第一项；显式选择必须在清单内（`user-selected`），未知 → 400。e2e：清单内选择生效并标记 `user-selected`、清单外 400、未选时快照 `routeSource` 与清单 `defaultSource` 一致 |

> 导入的第三方 provider 是否在 `/api/models` 里出现，取决于它依赖的服务（credentials/settings 等）
> 是否齐备；本次实测这些 bundle 未注册出额外模型，但也没有破坏运行时启动——服务把它当作
> "尽力而为的导入"，并在 `/api/dsh-source` 里如实展示。
## 7. 未验证项

| 项目 | 原因 |
| --- | --- |
| 真实模型调用 | 本次全用 mock 模型；代码路径与真实调用一致（同一 adapter，仅 baseURL 与 key 不同） |
| 真实外部 MCP 服务 | 只用仓库自带 example server（stdio）验证；streamable-http 分支有单测与配置渲染验证，未连真实服务 |
| 浏览器自动化 | 前端做了类型检查、生产构建、SSE/事件归并单测与 SSR 渲染冒烟；没有 Playwright |
| 并发压力 | 单机 JSON 存储 + 每配置一个运行时，未压测 |
| 空闲回收 | 逻辑有单测；没有跑满 `RUNTIME_IDLE_MS`（默认 5 分钟）的实测 |

---

## 8. 复现

```powershell
npm install --cache .npm-cache --no-audit --no-fund --ignore-scripts
npm run build
npm run data:demo
npm run verify        # typecheck + 单测 + 运行时检查 + e2e
npm run demo          # 打开 http://127.0.0.1:8787 手动体验
```
