# 决策记录（DSH Agent Service）

记录实施过程中的关键判断、被否决的方案与仍然存在的风险。**与本文档冲突的代码是 bug。**

---

## 0. 固定版本

| 项 | 取值 | 说明 |
| --- | --- | --- |
| DSH Runtime | `@deepseek-ai/dsh@0.2.1-rc.3` | 与本机 Desktop 运行时一致；npm `latest` 仍是 `0.2.1-rc.2`，必须显式写版本 |
| DSH SDK | `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3` | 运行时与 SDK 必须同版本 |
| Node.js | ≥ 22.5（实测 24.21.0） | 无原生模块依赖 |
| 包管理 | **npm workspaces** | 见 §1 |
| 服务端 | Fastify 5 + JSON 文件存储 | 无数据库 |
| 前端 | Vue 3 + Semi Design + Pinia + Vite | 单页 Playground |

升级 DSH 时必须同时升级两包，并重跑 `npm run verify`（其中的 `check:runtime` 与 `e2e` 会真实启动运行时）。

---

## 1. 为什么用 npm workspaces 而不是 pnpm

方案原文建议 pnpm workspace。实测在本机（Windows + Node 24 + 只读用户目录）中：

- pnpm 11 的 store 需要 SQLite 索引，默认位于用户目录 → 被沙箱拒绝（`ERR_SQLITE_ERROR`）；
- 即便把 store 指到仓库内，`node-linker=isolated` 用 **Windows junction** 链接包，而 Node 的 ESM
  解析不会把 junction 还原成 realpath，导致包内再引用其它 `@deepseek-ai/*` 时 `ERR_MODULE_NOT_FOUND`
  （已在 `dsh-sdk-client → dsh-sdk-protocol` 上复现）。

改用 **npm workspaces**（真实目录、扁平提升），与 DSH 官方安装方式一致。`pnpm-workspace.yaml`
保留，便于在其它平台使用 pnpm；本仓库的 CI 与文档以 npm 为准。

---

## 2. 从"Agent 管理平台"精简为"Agent Service"

第一版曾实现完整平台：用户/角色/登录、Agent 草稿与版本发布、工具 allow/deny/ask 策略插件、
审批通道、审计表、MCP 管理页。评估后按实际需求删除，理由：

| 原能力 | 为什么删掉 | 现在由谁负责 |
| --- | --- | --- |
| 用户、角色、登录 | 服务由业务后端调用，部署在 `127.0.0.1`；再做一套用户体系只会与业务系统冲突 | 业务后端 |
| Agent 版本/发布 | 需求是"每次对话选能力"，不是"管一堆 Agent 版本"；配置快照已经解决了"发布态"问题 | 配置快照 |
| 工具 allow/deny/ask | 能力边界改由**是否挂载**决定（skills-view / MCP 插件条目），不需要逐工具策略 | 运行时组合 |
| 审批通道 | SDK 没有 server→client 请求通道；没有工具策略后，也就不需要"ask" | — |
| 审计表 | DSH 自己有完整的 session 日志；业务审计应由业务后端做 | DSH session log / 业务后端 |
| SQLite | 单机、数据量小、无并发写压力；JSON 文件足够，且便于业务方直接查看/备份 | `data/store.json` |

保留的部分：Fastify 服务骨架、运行时物化（profile/patch）、SDK 事件适配、SSE、Vue 前端脚手架，
以及**业务工具插件**（`plugins/agent-tools`，作为"如何给 Agent 加业务工具"的示例）。

---

## 3. Skills/MCP 只能通过运行时组合生效（核心约束）

`0.2.1-rc.3` 的 `initialize` 只接受 `cwd / provider / model / reasoningEffort / maxTokens`；
**没有任何按会话传 `skills[]` 或 `mcpServers[]` 的入口**。能力由 profile → Cordis 插件组合决定。

因此本服务的选择是：

- **每个配置指纹一个快照目录**：`runtime/snapshots/<configKey>/{home,skills-view,workspace,patches}`；
- **Skills 用"复制过滤"**：只把选中的技能复制进 `skills-view`，运行时
  `skill-filesystem` 配 `includeDefaultRoots:false` + `customSkillDirs:[skills-view]`。
  实测未选中的技能对模型不可见（`skill "gis-processing" is unknown or no longer available`）。
- **MCP 用"按服务器插插件"**：每个选中服务器一个 `dsh-mcp-client` 条目；未挂载的服务器，
  其工具在注册表里根本不存在（模型调用会失败）。
- **复用**：同 `configKey` 用同一个 `DSH_HOME` 与同一份 patch → 一个运行时承载多个会话；
  配置不同则必须不同运行时（不同 home）。

被否决的方案：

- 写一个 `ctx.skills` 过滤插件：能用，但依赖 `dsh-skill` 的注册表内部 API，升级更脆弱；
- 每次对话一个运行时：隔离最彻底，但会话数一多就浪费；配置指纹复用已经够用；
- 一个进程内动态改 `customSkillDirs`：DSH 没有这个控制通道，而且会破坏"已有会话快照不变"。

---

## 4. 配置快照不可变

创建对话时把项目配置 + 对话覆盖合并成**快照**并计算 `configKey`：

```
configKey = sha256(canonicalJson({ skills 排序, mcpServers 排序, provider, model, systemPrompt })).slice(0,16)
```

`PUT /api/conversations/:id/config` 只在 `messageCount === 0` 时允许，否则 `409 CONVERSATION_STARTED`。

原因：DSH 的会话日志与运行时 home 绑定，换配置意味着换 home，无法把已有会话"搬"过去
（`resumeSession()` 只在同一个 home 内有效）。与其给出一个会悄悄丢历史的实现，不如明确拒绝。

---

## 5. 事件协议：只有 5 个业务事件

DSH 只有 4 种通知（`session.event` / `session.status` / `subagent.started` / `subagent.finished`），
且 **56 个会话事件里没有任何 delta**——最细粒度是每个 step 一条已提交的 `assistant/message`。

所以对外只定义 5 个事件，且 `message.completed` 就是"一段完整文本"：

```
message.started / message.completed / tool.started / tool.completed / message.failed
```

**不提供 `message.delta`**，也不在前端做打字机模拟——伪造流式会掩盖真实延迟，让前端无法正确
处理"工具调用穿插在文本之间"的情况。

事件映射的硬规则（对应 `TurnEventAdapter`）：

- `assistant/message` 按 `data.message.id` 去重；`text` 只拼接 `type:'text'` 块；
- `tool/call` 与 `tool/result` 用 `callId` 配对，`tool/result.data.message.isError` 决定 success；
- `turn/end{reason.kind:'error'}` → `message.failed`（code=`TURN_ERROR`）；
- `session.status{status:'idle'}` → 本轮结束；若一条 assistant 文本都没有，则 `message.failed`。

---

## 6. 凭据与子进程隔离

- 凭据只通过**子进程环境变量** `DEEPSEEK_API_KEY` 注入（`MOCK_LLM` 时指向本地 mock）；不落盘、不进
  `store.json`、不下发前端。
- 解析顺序（DSH 官方）：托管文件 > 启动环境 > `<cwd>/.env` > `$DSH_HOME/.env`。因此快照 home 内
  **不放** `.credentials.yaml`，避免出现两份来源。
- 采用环境变量的前提：运行时没有 shell / 文件工具（本 profile 已移除）。如果将来给某个配置开
  shell，必须改成托管凭据文件。
- 子进程环境从零构造：`PATH/SYSTEMROOT/TEMP/HOME` + `DSH_HOME` + `DSH_AGENTS_HOME` +
  `DSH_TELEMETRY_DISABLED` + `AGENT_SERVICE_*` + Provider 凭据。绝不继承宿主的 `DSH_HOME`、
  `DSH_PROFILE`、代理变量。
- 服务配置项用 `AGENT_SERVICE_DSH_PROFILE`，因为 DSH Desktop 会把宿主环境里的 `DSH_PROFILE`
  设成 `desktop`，直接沿用会让服务去启动保留名 profile 并失败。

---

## 7. Profile 与补丁语义（实测）

- 基础树 `@deepseek-ai/dsh-sdk-minimal`（39 个条目）：不含 skills / MCP / 文件写入 / 子智能体；
  但它把 `sandbox-policy.mode` 钉死为 `danger-full-access`，所以模板里显式改成 `read-only`。
- 补丁写法：`- id: X` + `disabled: true` 禁用；`- insert: [...]` 新增；
  同一 id 的 `config` 是**整段替换**（不是深合并），覆盖时必须写全要保留的字段。
- **补丁行顺序没有加载语义**（服务可用性驱动激活），不要依赖 insert 先后。
- 自定义插件通过绝对路径插入时会自动规范成 `file://`；profile 内的 `name` 也可以直接用包名
  （先从 dsh 安装目录解析）。
- Skills 插件：`@deepseek-ai/dsh-skill`（注册表）+ `@deepseek-ai/dsh-skill-filesystem`（文件系统源）+
  `@deepseek-ai/dsh-tool-skill`（模型可见的 `skill` 工具）。技能格式：`<root>/<skill>/SKILL.md`
  或 `<root>/<skill>.md`，frontmatter 至少 `name`/`description`。

---

## 8. 存储与并发

- `data/store.json`：项目配置 + 对话元数据。原子写（tmp + rename）、进程内串行化、损坏时备份为
  `store.json.corrupt-<ts>` 并以空状态启动（不静默覆盖）。
- `data/conversations/<id>.jsonl`：一行一条展示消息（追加写）。它是"展示副本"，
  真正的对话上下文在 DSH 的 session 日志里。
- 单进程；同一对话同时只允许一轮（运行中返回 409 `CONVERSATION_RUNNING`）。不同对话可以并行
  （同一个运行时内由 DSH 的按会话调度处理）。

---

## 9. 安全边界

1. 默认监听 `127.0.0.1`；需要内网暴露时设 `INTERNAL_TOKEN`（共享密钥，不是用户体系）。
2. **项目归属与数据权限由业务后端校验**，本服务不做。若直接暴露给浏览器，必须自己加网关鉴权。
3. MCP 的 `command` 由运维在 `config/mcp-servers.json` 配置，等同于在主机上执行命令；
   只允许受信任的人改这个文件。
4. 未选中的 Skills 和 MCP 服务器在运行时**不存在**，不是"提示词里说不要用"。
5. 提示词不是权限：技能正文与系统提示词只影响模型行为，真正的边界是运行时组合。

---

## 10. 剩余风险与 TODO

| 风险 | 现状 | 建议 |
| --- | --- | --- |
| DSH 处于 preview，API 可能变 | 固定 `0.2.1-rc.3` | 升级时重跑 `npm run verify` |
| 无 OS 级沙箱 | 移除 shell/文件工具 + `read-only` 沙箱 + 独立目录 | 低权限账户运行，收紧 `runtime/`、`data/` 权限 |
| 无逐字流式 | 每个 step 一条完整消息 | 等 DSH 提供增量通知 |
| 无中途取消 | 超时关闭运行时；历史保留、下次 resume | 运行时池 + 软取消 |
| 单机 JSON 存储 | 无多机共享、无事务 | 数据量上来后换数据库（接口已隔离在 `store/`） |
| 运行时上限 | `MAX_RUNTIMES` 默认 8，超出回收最久空闲 | 按业务并发调整，或做跨进程池 |
