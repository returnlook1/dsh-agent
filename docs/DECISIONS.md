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

## 5b. provider/model 清单来自 DSH，不写死

早先的实现把 `deepseek-official` / `deepseek-flash` 写成常量（schema 默认值 + 前端常量）。
问题：换 Provider、换 baseURL、升级 DSH 后模型目录会变，常量立刻变成过期知识，而且
"配置里保存了什么"和"运行时实际能用什么"会脱节。

现在的做法：启动时用一个 **探针插件**在真实的 DSH 子进程里调用
`ctx.llm.listProviders()` / `listModels()`，把结果写文件、进程退出；服务读取并缓存
（内存 + `data/models.json`）。

关键实现细节（踩过的两个坑）：

1. **`inject: ['llm']` 不够**：它只保证 LLM 服务就绪，不保证 adapter 插件（`llm-deepseek-api-key`）
   已激活。探针必须轮询 `listProviders()`（实测 161ms 后才有），否则会得到空清单。
2. **默认模型没用 `agent-default-model`**：`sdk-minimal` 组合里没有这个插件，所以默认路由由
   清单决定（第一个有模型的 provider 的首个模型），而不是读某个配置项。

被否决的方案：

- 解析 `--dump-config`：配置里只有 adapter 的 `models` 覆盖项，真正的目录在运行时；
- 直接 `require` provider 包的 `DEFAULT_MODELS`：只覆盖官方内建目录，第三方 Provider 失效；
- 让前端写死候选项：UI 与后端的可用性会长期不一致。

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

---

## 11. 代码评审后的加固（P0/P1）

按外部评审逐项修复，均有回归测试。

### 11.1 并发冷启动竞态（P0-2）

`RuntimePool.acquire()` 原来是"查不到就 await 创建，成功后才登记"，两个请求同时冷启动会
各起一个进程、抢同一个 `DSH_HOME`。现在增加 `pending: Map<configKey, Promise<entry>>`，
同配置的初始化合并到同一个 Promise。回归测试：10 个对话同时首启 → 只有 1 个运行时。

### 11.2 会话恢复失败被吞（P0-4）

原实现在 `resumeSession()` 失败时只记 warning 就继续 `prompt()`，后果是用户以为上文还在，
其实模型拿到了空上下文。现在：

- 恢复发生在任何运行状态登记之前；
- `hasHistory=true` 且恢复失败 → 直接 `409 SESSION_RESTORE_FAILED`，**不**发 prompt；
- 首次消息（`hasHistory=false`）不调用 resume，由 `prompt` 创建会话。

### 11.3 MCP 凭据明文落盘（P0-3）

旧实现的 `McpConfig.resolve()` 把 `${ENV}` 展开成真实值，再序列化进 `mcp.cordis.yml`。
现在：

- `command/args/url` 只展开 `${REPO_ROOT}`；出现 `${ENV}` 直接报错（强制把凭据放 env/headers）；
- `env/headers` 保留为表达式，渲染成 `!!js process.env.X` / 模板字符串，在 DSH 子进程启动时求值；
- 只把**被引用的**环境变量按白名单注入子进程；缺失即报错（fail closed）；
- 回归测试断言生成的 YAML 里不含真实 token，只有 `!!js` 引用。

### 11.4 能力变更没有进入配置指纹（P1-5）

`configKey` 原来只含 skills/mcpServers/provider/model/systemPrompt。改了 `SKILL.md` 内容、
MCP 连接配置或 profile 模板后，名字没变 → key 不变 → 复用旧运行时。现在增加
`capabilityRevision`（技能内容哈希 + MCP 书写态定义 + profile 模板，sha256 前 12 位）并纳入
`configKey`；快照 DTO 也带该字段，便于排查。

### 11.5 复用既有 DSH 配置（P0-1）

新增 `DshSource`：只读导入源 profile 的 Skills 目录、MCP 定义、Provider 插件。
导入时的关键处理：

- CLI 拒绝 dump `desktop` 这类保留名 → 复制 manifest 成临时导入 profile（`node_modules` 用
  junction 指回源 profile）再 `--dump-config`；
- 源组合里的 `!!js` 用自定义 YAML tag 保留成 `{__jsExpr}`，渲染回 patch 时还原成 `!!js`；
- provider 凭据只从服务环境或源 `.credentials.yaml` 的 `refs` 取值注入子进程，**不落盘**；
- `GET /api/dsh-source` 输出导入项与凭据可用性（只报变量名）。

实测（真实 `~/.dsh` + desktop）：导入到 `llm-pi-ai` / `dsh-providers-hub` / `dsh-opencode-go`，
运行时正常启动并完成一轮对话；这些第三方 provider 是否注册出模型取决于其依赖的服务是否齐备，
因此导入是"尽力而为 + 可诊断"，不阻断启动。

### 11.6 新增的运维能力（P1）

- `POST /api/mcp-servers/:id/test` / `GET .../tools`：stdio 与 streamable-http 的真实握手 +
  `tools/list`（分页），返回协议版本、工具与参数 Schema、耗时与错误；
- `tool.completed` 增加 `result`（文本是 JSON 时解析）与截断的 `resultText`，前端可据此做
  地图动作等结构化交互；
- `POST /api/conversations/:id/stop`：唯一运行中的对话才允许关闭运行时，否则 409 `RUNTIME_BUSY`；
- `PATCH` / `DELETE /api/conversations/:id`：重命名与删除（运行中拒绝）。
---

## 12. 供应商与模型：DSH 定义，服务在 DSH 集合内允许选择

最终语义（对上一版的修正）：

| 项 | 由谁决定 |
| --- | --- |
| Provider 注册、模型清单、凭据 | **DSH** |
| 默认模型（`agent-default-model`） | **DSH** |
| 某个项目/对话用哪个路由 | 业务方在 **DSH 清单内**选择；不选则跟随 DSH 默认 |
| 校验"选的是不是 DSH 报告的" | Agent Service（`400 MODEL_UNKNOWN` / `503 MODEL_UNAVAILABLE`） |

之前一版把这个指令理解成"界面不再选模型"，删掉了两个下拉并且忽略请求里的 provider/model；
这既不符合原始方案的 Playground 设计，也让"按项目选模型"这个实际需求消失。现已改回：

- `agentConfigPatchSchema` / 创建对话 / 改配置重新接受 `provider` + `model`；
- `resolveRoute` 三种来源：显式选择（校验后在清单内，`user-selected`）、DSH 默认
  （`dsh-default-model`）、清单第一项（`catalog-first`）；
- 只给一侧（例如只给 model）时，另一侧用 DSH 默认补全后再整体校验，避免"半个路由"绕过；
- **项目配置不把补全后的默认值写回存储**：否则后续对话会把"继承来的默认"误记成
  `user-selected`（e2e 抓到过这个 bug，已修）；
- 前端恢复 Provider / Model 两个下拉，候选项只来自 `/api/models`，并提示"候选项与默认值由
  DSH 提供"。

安全/一致性上仍然保持：服务不存 provider 凭据、不维护供应商目录、不自行判断模型优劣；
DSH 默认模型不可用时 fail closed，而不是悄悄换成别的模型。
---

## 13. 界面重构：深海观测台 / 三栏工作台

旧页面的问题是"配置优先"：左栏塞满项目、Skills、MCP、模型、提示词，聊天被挤到右侧，
首屏注意力落在表单上而不是对话；视觉上还是浅色 SaaS 模板，和"海洋环境分析"的语境无关。

重构后的选择：

| 决策 | 理由 |
| --- | --- |
| 三栏：左会话 / 中对话台 / 右能力 | 会话是导航、对话是主体、能力是次要但频繁调整的参数；右栏可一键收起 |
| 视觉："深海观测台"（深蓝黑 + 荧光青 + 琥珀） | 与业务语境一致；暗底更适合长时间观测日志；避免通用浅色模板 |
| 空状态做成"任务控制台"卡片 | 直接展示 project / capabilities / route 三项当前选择，并提供主 CTA，比一句占位文案有用 |
| 消息按"日志条目"排版（左侧细竖线区分角色） | 工具调用与文本混排时可扫读；用户=琥珀、助手=青，颜色即来源 |
| 等宽数字 / 大写微标签 / 发丝分割线 | 仪器面板的秩序感；信息密度高但不吵 |
| 主题实现：`body[theme-mode="dark"]` + Semi token 覆写 | 复用 Semi 组件（下拉、弹层、Toast）的暗色能力，避免逐组件重写 |
| 布局断点：<1280 收右栏、<1024 收左栏（顶栏按钮切换） | 保证 1024 宽笔记本上对话区仍有 ~700px 可读宽度 |

顺带修掉一个真实 bug：`McpSelect.vue` 使用了 `Select` 却没有从 `@aifuxi/semi-ui-vue` 导入，
Vue 把它当成原生 `<select>` 渲染（白底空白框）。补上导入后才是真正的多选组件。

验证：用 Edge headless（CDP）在 1488×824 与 1120×800 下截图核对；typecheck / 211 单测 /
12 项运行时检查 / 73 项 e2e 全绿。截图见 `docs/images/`。
### 13.1 后续三项打磨

1. **Markdown 渲染**：接入 `marked`（gfm + breaks），但关闭原始 HTML、链接/图片协议走白名单
   （http/https/mailto/tel/相对路径），`javascript:`/`data:` 降级为纯文本；代码块不引入高亮库，
   只加语言标签（体积换不来收益）。安全用例在 `apps/web/tests/markdown.test.ts`。
2. **会话搜索与状态筛选**：搜索标题/ID/项目，状态筛选带计数；计数为 0 的状态不展示。
   过滤逻辑抽成 `utils/conversation-filter.ts` 纯函数，有 7 个单测。
3. **能力摘要条**：对话标题下直接显示本轮启用的 Skills / MCP（超出用 `+N` 表示），
   悬停看全量；避免"以为没挂技能"的误判。

演示用的 mock 回答也改成一段带标题/列表/表格/代码块的 Markdown（`scripts/demo-answer.mjs`），
这样离线 `npm run demo` 就能看到渲染效果。