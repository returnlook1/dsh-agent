# Agent Studio

基于 **DeepSeek Harness（DSH）** 的受限 Agent 平台。它保留原版 DSH 的 Agent Loop、Provider、
Session、MCP、Skills 能力，自己提供 Agent 管理、权限策略、MCP 管理和聊天界面。

- **不重写 Agent Loop**：推理、上下文、工具调度都用 DSH。
- **不修改 DSH 源码**：能力扩展全部通过独立 Profile + Cordis 插件 + `--patch` 叠加。
- **前端拿不到 DSH 管理权限**：浏览器只访问本项目的 Gateway，DSH 只通过 stdio JSON-RPC 被网关驱动。
- **工具权限由服务端强制执行**：Agent 能做什么不由提示词或按钮决定，而由运行时的策略快照 + 守卫决定。

固定版本：`@deepseek-ai/dsh@0.2.1-rc.3` + `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3`（两者必须同版本）。

---

## 1. 能力清单与完成度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P0 基础接入** | SDK 驱动真实 DSH 运行时、多轮会话、SSE 事件流、消息落库 | ✅ 已实现并端到端验证 |
| **P1 安全控制** | Agent 配置、工具 allow/deny/ask、`ctx.tools.guard()` 强制拒绝、审批通道、运行时隔离、审计、撤销 | ✅ 已实现并端到端验证 |
| **P2 管理平台** | Agent 编辑/发布/版本、工具目录与参数级授权、MCP 管理（stdio 探测）、审计查询、运行时状态 | ✅ 已实现 |
| **P3 平台增强** | 运行时池、多租户、记忆、监控、嵌入组件 | ⛔ 未实现（见 §8） |

已用自动化验证的安全结论（详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)）：

- 未授权工具**确实无法执行**（策略插件在 `tools/pre-execute` + 单调 `guard` 双层拦截）；
- `ask` 工具必须经过**网关 → 控制通道文件 → 插件**的异步审批，批准才执行、拒绝/超时一律不执行；
- 管理员撤销后，后续所有工具调用立即失败（每次调用都检查撤销标记）；
- 普通用户无法读取审计、无法创建 Agent、无法批准他人会话。

---

## 2. 架构

```
浏览器（Vue3 + Semi Design，Pinia + Vite）
   │  REST + SSE（只访问网关，绝不直连 DSH）
   ▼
Agent Gateway（Node 24 + Fastify 5 + node:sqlite）
   │ ① 认证/授权 ② Agent 配置与版本 ③ 会话编排 ④ 审批 ⑤ 审计 ⑥ MCP 探测
   │ stdio JSON-RPC（@deepseek-ai/dsh-sdk-client）
   ▼
DSH Runtime 子进程（每个业务会话一个，独立 DSH_HOME / 工作目录 / 策略）
   │ 原版 Agent Loop · Provider · Session · MCP · 工具注册表
   ├─ plugins/agent-policy   工具白名单 + 单调守卫 + 审批 + 撤销
   ├─ plugins/agent-tools    业务工具（4 个）
   └─ plugins/agent-audit    工具执行审计（JSONL）
   ▼
业务数据（JSON 快照） / MCP Server / SQLite
```

四层权限模型（实现位置）：

| 层 | 作用 | 实现 |
| --- | --- | --- |
| L1 能力 | 允许哪些插件/工具存在 | `runtime/templates/studio/cordis.patch.yml`（移除 shell/fs/web/subagent/PTC） |
| L2 执行策略 | allow / deny / ask | `plugins/agent-policy`（`tools/pre-execute` + `ctx.tools.guard`） |
| L3 用户授权 | 哪个用户能访问哪些数据 | 网关归属校验 + 业务工具内部站点白名单 |
| L4 系统隔离 | 文件/进程/网络/凭据 | 独立 `DSH_HOME`、空工作目录、最小环境变量、独立凭据、`sandbox-policy: read-only` |

---

## 3. 快速开始

前置：Node.js ≥ 22.5（本机 24.21.0），Windows PowerShell 或 bash 均可。

```powershell
# 1) 安装（仓库根目录；用 npm workspaces，见 docs/DECISIONS.md §1）
npm install --cache .npm-cache --no-audit --no-fund --ignore-scripts

# 2) 构建（shared → 三个插件 → 网关 → 前端）
npm run build

# 3) 生成演示业务数据（监测站 + 30 天序列）
npm run data:demo
```

### 3.1 离线演示（无需 API Key）

```powershell
# 终端 A：本地 mock 模型（工具调用 + 文本结论循环）
npm run mock:llm

# 终端 B：网关（把模型端点指向 mock）
$env:MOCK_LLM='1'
$env:DEEPSEEK_API_KEY='mock-key'
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:8899/v1'
npm start
```

### 3.2 使用真实模型

```powershell
$env:DEEPSEEK_API_KEY='<你的 key>'
$env:DSH_PROVIDER='deepseek-official'
$env:DSH_MODEL='deepseek-flash'    # 必须以 Provider 实际模型名为准
npm start
```

打开 <http://127.0.0.1:8787>，预置账号：

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `admin123` | 管理员（建 Agent、发布、MCP、审计、审批） |
| `demo` | `demo123` | 普通用户（只能用已发布 Agent 聊天） |

> **部署前必须改掉预置密码**，并设置 `AUTH_SECRET`（不设置时网关会在 `data/.auth-secret` 生成一个）。

典型流程：登录 `admin` → Agent 管理 → 新建 Agent（工具能力页勾选 `query_station` / `search_datasets`，
`export_report` 设为“需审批”）→ 发布 → 进入聊天 → 发消息；触发 `export_report` 时右侧会弹出审批框，
选择“允许一次”后工具才执行。

---

## 4. 目录结构

```
apps/
  gateway/           Fastify 网关：REST + SSE、运行时管理、审批、审计、SQLite
  web/               Vue3 + Semi Design 管理端与聊天端
plugins/
  agent-policy/      工具策略插件（allow/deny/ask、撤销、审批通道）
  agent-tools/       业务工具插件（search_datasets / query_station / map_fly_to / export_report）
  agent-audit/       审计插件（JSONL）
packages/shared/     前后端共用的类型与 zod 契约（AgentConfig / AgentEvent / PolicySnapshot / DTO）
runtime/
  templates/studio/  受限 Profile 模板（package.json + cordis.patch.yml + mcp.cordis.yml）
  tools/             演示业务数据（由 scripts/gen-demo-data.mjs 生成）
  homes/ workspaces/ patches/ policies/   运行时生成（gitignore）
scripts/
  mock-llm-server.mjs  本地 mock 模型
  smoke-run.mjs        5 个安全场景，真实 DSH 子进程
  e2e-gateway.mjs      网关 HTTP/SSE 端到端（allow + approval 两种模式）
  gen-demo-data.mjs    演示数据生成器
docs/                  研究结论、架构决策、实现规格、验证报告
data/                  SQLite（gitignore）
```

---

## 5. 验证

```powershell
npm run typecheck   # 全部包类型检查
npm test            # 150 个单测（不联网、不起子进程）
npm run smoke       # 5 个安全场景，启动真实 DSH 运行时（mock 模型）
npm run e2e         # 51 项 HTTP/SSE 断言，含审批批准与拒绝
npm run verify      # 以上全部
```

最近一次全量结果与逐项证据见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

> 说明：`smoke` / `e2e` 需要启动带管道的子进程（DSH 子进程 + stdio JSON-RPC）。
> 在受限沙箱里（禁止 `spawn` 管道）需要放行进程创建，否则无法运行；单测与类型检查不受影响。

---

## 6. 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 只监听本机 |
| `DATA_DIR` | `<repo>/data` | SQLite 与密钥文件 |
| `RUNTIME_DIR` | `<repo>/runtime` | 运行时 home/workspace/patch/policy |
| `DSH_BIN` | `node_modules/@deepseek-ai/dsh/lib/bin.js` | DSH 运行时入口 |
| `AGENT_STUDIO_DSH_PROFILE` | `studio` | 受限 profile 名（不读宿主的 `DSH_PROFILE`） |
| `DEEPSEEK_API_KEY` | – | Provider 凭据，只注入子进程环境 |
| `DEEPSEEK_BASE_URL` | – | 指向 mock 或私有网关 |
| `MOCK_LLM` | – | 非空表示离线模式（不向真实端点发请求） |
| `AUTH_SECRET` | 自动生成 | 令牌签名密钥 |
| `TOKEN_TTL_HOURS` | `12` | 令牌有效期 |
| `RUNTIME_IDLE_MS` | `600000` | 运行时空闲回收 |
| `APPROVAL_TIMEOUT_MS` | `120000` | 审批超时（超时即拒绝） |
| `WEB_DIST` | `apps/web/dist` | 由网关托管的前端产物 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## 7. 安全边界（部署必读）

1. **审批是异步带外的**：`0.2.1-rc.3` 的 SDK 没有 server→client 请求通道，审批走运行目录下的
   文件控制通道（插件写请求、网关写决定、插件轮询）。超时、通道异常、策略缺失一律**拒绝**。
2. **没有 OS 级沙箱**：L4 只做到"独立 home + 空工作目录 + 最小环境变量 + 移除高危插件"。
   生产部署应以低权限账户运行网关，并收紧 `runtime/` 与 `data/` 的 NTFS/POSIX 权限。
3. **MCP stdio 的 command 由管理员配置**，等同于管理员在该主机上执行命令。只允许受信任的管理员
   配置 MCP；不要把 MCP 管理开放给普通用户。
4. **凭据走环境变量**：受限 Agent 没有 shell 工具，因此取不到 `DEEPSEEK_API_KEY`；若将来给某个
   Agent 开 shell，必须改用托管凭据文件（见 `docs/RESEARCH-PROVIDER.md` §2）。
5. **提示词不是权限**：系统提示词只影响模型行为；真正的限制在插件与 Profile 里。修改工具授权
   必须发布新版本，旧版本策略快照不会被覆盖。

---

## 8. 已知限制（P3 待办）

| 限制 | 现状 | 建议 |
| --- | --- | --- |
| 逐字流式 | SDK 只提供**每个 step 一条已提交消息**，没有 token 级增量。前端如实按整段渲染，不假装打字机 | 等 DSH 提供流式通知 |
| 中途停止 | SDK 无单轮取消接口；"停止"= 关闭该会话运行时，下条消息重新 resume | 运行时池 + 软取消 |
| 每会话一个进程 | 隔离清晰但资源占用高 | 按权限分组做运行时池 |
| `temperature` | 当前版本 Provider 不支持按 Agent 配置；发布时给出 warning，不静默忽略 | 自写 `agent/request` 插件或等上游支持 |
| MCP sse/http 探测 | 只实现 stdio 的 `initialize` + `tools/list`；sse/http 可写进 profile 但无法在 UI 预检 | 补 HTTP/SSE 探测 |
| 单机 SQLite | 多用户并发上限受单机限制 | 换 PostgreSQL + 队列 |
| 前端无 E2E | 构建、类型、SSE 解析均有验证，但没有浏览器自动化 | 接入 Playwright |

---

## 9. 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 架构决策记录：为什么这样分层、为什么用文件控制通道、配置落地矩阵、安全红线 |
| [docs/IMPL-GATEWAY.md](docs/IMPL-GATEWAY.md) | 网关实现规格：模块、数据库 DDL、认证、事件映射、审批桥、API 表、SSE 流程 |
| [docs/IMPL-PLUGINS.md](docs/IMPL-PLUGINS.md) | 三个 Cordis 插件的规格：环境变量、拦截逻辑、审批协议、审计字段 |
| [docs/RESEARCH-SDK.md](docs/RESEARCH-SDK.md) | DSH SDK 0.2.1-rc.3 实测结论：通知、事件、流式粒度、审批缺失、恢复 |
| [docs/RESEARCH-PROFILE.md](docs/RESEARCH-PROFILE.md) | Profile 组合与 patch 语法、受限树、系统提示词、MCP 挂载、沙箱 |
| [docs/RESEARCH-TOOLS.md](docs/RESEARCH-TOOLS.md) | `defineTool`、`tools/pre-execute`、`guard`、`restrict` 的实测语义 |
| [docs/RESEARCH-PROVIDER.md](docs/RESEARCH-PROVIDER.md) | 凭据解析顺序、per-agent 生成参数、离线 mock 模型配方 |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 验证报告：命令、场景、断言与结果 |
| [plugins/README.md](plugins/README.md) | 插件开发与构建说明 |

参考方案原文：[基于 DSH 的受限 Agent 平台实施方案.md](基于%20DSH%20的受限%20Agent%20平台实施方案.md)。
