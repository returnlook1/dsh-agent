# DeepSeek Harness 受限运行时 Profile 研究报告（`0.2.1-rc.3`）

> 目的：给出**网关按 agent 逐个拉起受限 DSH runtime** 所需的全部 profile 知识——
> profile 目录形态、patch 层 YAML 语法、`sdk` / `sdk-minimal` 的真实组装内容、
> 一个只保留"系统提示词 + 模型路由 + 原生工具呈现 + 自有工具 + MCP + 会话持久化"的
> 最小受限树，以及 `dshHome` / SDK 客户端参数的落地方式。
>
> **验证基线**：只用 npm 上 `0.2.1-rc.3` 实际发布的文件。
> - 解包根目录：`E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\pkgs\<pkg>-0.2.1-rc.3\package\`
>   （下文引用写成**包内相对路径**，如 `dsh-base/cordis.patch.yml:138`）。
> - 实际运行用安装树：`E:\Code\OceansLabWeb\dsh_oceanslab\node_modules\@deepseek-ai\dsh\lib\bin.js`。
> - 未验证的地方一律标 **`未验证`**，不做推断式断言。

---

## 1. 结论速查表

| # | 问题 | 结论 | 依据（包内路径:行） |
|---|---|---|---|
| 1a | profile 目录里有什么 | `package.json`（`dsh.profile.bundles` 有序列表 + `dependencies`）、`cordis.patch.yml`（用户 patch 层）、`pnpm-workspace.yaml`（`dsh plugin` 用）、`node_modules`（profile 自有插件）、以及**每次启动被重写的** `cordis.yml` | `dsh-app-boot/lib/index.js` `initProfile()`（写前三者）+ `PROFILE_PATCH_TEMPLATE`；`dsh/lib/types/profile-boot.d.ts:26,47-54` |
| 1b | `cordis.yml` 能不能手写 | **不能/不要**。它是 include 的锚点文件，启动时**无条件重写成空根**；写进去的内容会在下次启动被当补丁行重复插入 | `dsh/lib/types/profile-boot.d.ts:47-54`（"The root is always rewritten…would duplicate every bundle insert on the next boot"） |
| 1c | patch 层的顶层类型 | 顶层 YAML **数组**，元素是 `PatchOptions`（`{id?, insert?, name?, config?, group?, disabled?, inject?, …任意键}`） | `cordis-plugin-include/src/index.ts:129-141`；`dsh-app-boot/lib/index.js` `parsePatchList()` 注释："a top-level YAML array of `PatchOptions` … Every invalid field or value throws" |
| 1d | 怎么 `insert` 新插件 | 顶层无 `id` 的 `- insert: [ {id, name, config}, … ]` → 追加到根条目列表；带 `id` 的 `insert` 表示"插进某个 **group** 条目的 `config` 数组" | `cordis-plugin-include/src/index.ts:79-102` |
| 1e | 怎么 `remove` / 停用已有条目 | **没有 remove**。用定向 patch 写 `disabled: true`（`disabled` 逐键覆盖，写 `false` 可恢复） | `cordis-plugin-include/src/index.ts:120-123`；`cordis-plugin-loader/lib/types/config/entry.d.ts:14-15` |
| 1f | 怎么 `update` 已有条目配置 | `- id: <row-id>` + `config: {…}`。**`config` 是整块替换，不是深合并**——没写的键回落到插件 schema 默认值 | `cordis-plugin-include/src/index.ts:120-123`；`dsh --dump-config-schema` 输出的 `$comment`："A patch config replaces the whole config"；实证见 §7.3 |
| 1g | `id` / `name` / `config` 语义 | `id`：条目在树内的稳定寻址键（定向 patch 靠它）；`name`：**模块说明符**；`config`：传给插件的配置对象 | `cordis-plugin-loader/lib/types/config/entry.d.ts:6-24` |
| 1h | 定向 patch 里的 `name` | 是**断言**：与目标条目 `name` 不相等就 `warn + skip`（不会改名，也不能靠它换实现） | `cordis-plugin-include/src/index.ts:115-118` |
| 1i | 补丁打不中会怎样 | stderr 打一行 `patch: entry "X" not found`，**跳过、非致命、进程继续** | `cordis-plugin-include/src/index.ts:109-113`；实证见 §7.4 |
| 1j | 绝对路径插件怎么写 | `name` 写绝对路径（`E:\…\dist\index.js`）或 `file:///E:/…/dist/index.js` 都行：**inserted 条目**的路径会被自动改写成 `file://` URL；相对路径（`./`、`../`）以**该 patch 文件所在目录**为基准 | `dsh-app-boot/lib/index.js` `anchorInsertedPluginNames()`（"Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch"）；实证见 §7.2、§7.4 |
| 1k | 插件模块导出形态 | 两者都支持。Loader 归一化规则是 `exports.default ?? exports`：①`export default` 一个函数/类插件；②**命名导出** `name` / `inject` / `apply`（+ 可选 `Config`） | `cordis-plugin-loader/src/index.ts:200-209` `unwrapExports()`；`dsh-mcp-client/lib/types/index.d.ts:1-17`（"Namespace plugin (named exports, no default export)"）、`dsh-system-prompt/lib/types/index.d.ts`（`export default SystemPrompt` + `static Config`） |
| 1l | 层顺序 | `dsh.profile.bundles`（按序）→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`（按 argv 顺序） | `dsh/README.zh.md:41-45`；`dsh/lib/types/dump-config.d.ts` `collectConfigDumpLayers()`（"in bundle, profile, home, then argv order"） |
| 1m | 两层碰同一 id | **逐键 last-write-wins**。因为 `config` 是整块替换，上层只写 `personaPrefix` 会把下层写的 `includeRuntimeContext` 一起抹掉 | 实证 §7.3（`sdk-app` 对 `system-prompt` 的 patch 就丢掉了 base 的 `includeHarnessIdentity`/`includeRuntimeContext`） |
| 2 | `sdk` / `sdk-minimal` 各是什么 | `sdk` = `[dsh-base, dsh-sdk-app]`；`sdk-minimal` = `[dsh-sdk-minimal]`（**不叠 base**，单包即完整树） | `dsh-app-boot/lib/index.js:551-557` `PROFILE_TEMPLATES` |
| 2b | 两个 profile 的条目 | 见 §2.2 与 §2.3 全量清单（`sdk` 100 条、`sdk-minimal` 35 条） | 实测 `--dump-config`，见 §7.1 |
| 3 | 受限树从哪起步 | **从 `sdk-minimal` 起步**。它天然没有 shell 以外的危险面：无 subagent、无 skills、无 AGENTS.md、无 plugin-manager、无 PTC runtime、无 web。只需**停 5 条 shell/PTY 行 + 1 条工具行**，再插 2 类条目 | §3 |
| 4a | 系统提示词归谁 | `@deepseek-ai/dsh-system-prompt`（`id: system-prompt`），配置键 `personaPrefix` / `personaSuffix` / `includeHarnessIdentity` / `includeRuntimeContext` / `toolOrder` | `dsh-system-prompt/lib/types/index.d.ts` `Config` |
| 4b | 静态 agent 人设怎么注入 | 直接写 `system-prompt.config.personaPrefix`（字符串，支持严格 `{{变量}}`）。**单 agent 语境**下这才是正解；`dsh-persona` 是 **scope-only**（agent preset 内用），全局挂会与注册表自身注册冲突并 fail loud | `dsh-system-prompt/lib/types/index.d.ts`；`dsh-persona/lib/types/index.d.ts:1-20` |
| 4c | 怎么不吃到开发者的 AGENTS.md / 全局指令 / skills / memory | **最稳的做法是让它根本不在树里**（`sdk-minimal` 已如此）。若从 `base` 起步则：停 `agent-instructions`、`skill`、`skill-filesystem`、`tool-skill`；或 `agent-instructions.config.maxBytes` 设 ≤0（"non-positive or non-finite disables loading"）。注意 `$DSH_AGENTS_HOME` 是**进程级**策略，行配置改不了 → **必须靠独立 home + 独立 `DSH_AGENTS_HOME`** | `dsh-agent-instructions/lib/types/config.d.ts:15-18,39-45`；`dsh-agent-instructions/README.md:40`（"Stray `dshHome` and `agentsHome` row keys are ignored"） |
| 5a | MCP client 怎么配 | 一个 server = 一个 `@deepseek-ai/dsh-mcp-client` 条目实例；`transport` 只有 **`stdio`** 与 **`streamable-http`**（**没有** `sse` / `http` 这两个键值）；工具名 = `mcp__<serverName>__<rawName>` | `dsh-mcp-client/lib/types/index.d.ts` `StdioConfig` / `StreamableHttpConfig`；`dsh-mcp-client/README.md:12,37-58` |
| 5b | 怎么只放开"MCP 服务器/工具的命名子集" | **组合层裁剪才是干净的**：只 insert 需要的 mcp-client 行。插件本身**没有** `tools`/`allow` 过滤键（`Config` 只有 transport/serverName/command/args/env/cwd/toolCallTimeoutMs/failOnStartupError/maxInstructionBytes/reconnect）。细到单个工具只能用 `ctx.tools.restrict({allow|deny})`，而它要**精确工具名**（无通配），必须等 server 发现完工具才知道 → 见 §5.3 | `dsh-mcp-client/lib/types/index.d.ts`（`Config` 联合）；`dsh-tools/lib/types/index.d.ts` `ToolRestriction`（"Empty filters, unknown names … fail"） |
| 6a | home 隔离靠什么 | `DSH_HOME`（优先级：显式配置 > `$DSH_HOME` > `~/.dsh`）；`DSH_AGENTS_HOME`（`~/.agents`）。**两个都要设**，否则 agent-instructions / 共享 skills 会读回开发者目录 | `dsh-home-paths/lib/types/index.d.ts` `resolveDshHome` / `resolveAgentsHome` |
| 6b | 全新 home 启动必须有什么 | **只要** `profiles/<name>/package.json` + `profiles/<name>/cordis.patch.yml`。`cordis.yml` 首启自动生成，`sessions/` 等按需创建，`sdk-minimal` 不读 `.credentials.yaml`（走 `DEEPSEEK_API_KEY`） | 实证 §7.5（只有 2 个文件的 home 能 dump 能 boot） |

---

## 2. `sdk` 与 `sdk-minimal` 到底组装了什么

### 2.1 模板来源（唯一权威）

`dsh-app-boot/lib/index.js:551-557`：

```js
const PROFILE_TEMPLATES = {
  acp:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
  web:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
  headless:     { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
  sdk:          { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] },
  "sdk-minimal":{ bundles: ["@deepseek-ai/dsh-sdk-minimal"] },
};
```

所以：

- **`sdk`** = `dsh-base` 的 88 行 + `dsh-sdk-app` 的 3 处定向 patch + 4 行 insert。
- **`sdk-minimal`** = 单个 bundle，**一个 insert、35 个条目就是整棵树**（`dsh-sdk-minimal/cordis.patch.yml:1-3`
  注释原文："Unlike the ordinary SDK profile, this bundle does not layer over dsh-base:
  this insert is the complete Cordis tree."）。

### 2.2 `sdk` 的组装（`--dump-config` 实测，100 条）

层注释证明它是三层叠加：`dsh-base` → `dsh-base, patched by dsh-sdk-app` → `dsh-sdk-app`。

`dsh-base/cordis.patch.yml` 的条目（按 dump 顺序，节选分组）：

| 组 | 条目 id → `name` |
|---|---|
| 插件管理 | `tool-plugin-manager`→`dsh-plugin-manager/tools`(disabled) · `plugin-manager`→`dsh-plugin-manager` |
| 基础设施 | `timer` · `hmr` · `llm` · `deepseek-llm-api-extensions` · `session` · `session-log-deepseek` · `typert` · `typert-loader` · `typert-gateway` · `remote-access` |
| 标题 | `session-title` · `session-title-llm` |
| Agent 核心 | `user-questions` · `agent` · `agent-default-model` · `jobs` · `llm-retry` |
| 配置/凭据 | `config-editor` · `settings` · `authorization` · `deepseek-account` · `credentials` |
| 模型路由 | `llm-pi-ai` · `llm-deepseek` · `llm-deepseek-account` |
| 持久化 | `session-persistence-jsonl` · `attachment-local` · `session-query-sqlite` |
| 目录/投影/存储 | `working-directory` · `tool-working-directory` · `session-projection` · `storage` · `storage-json` · `storage-domain` · `session-projection-cache` |
| 遥测 | `otel` · `session-telemetry-otel` |
| 沙箱/审批 | `subprocess` · `sandbox` · `sandbox-policy` · `bash-sandbox` · `pwsh-sandbox` · `approval` · `permission` · `shell-env` |
| **shell 工具** | `tool-bash`(win 下 disabled) · `tool-pwsh`(非 win 下 disabled) · `tool-jobs` |
| **文件工具** | `fs-observation-policy` · `tool-fs` · `tool-fs-search` |
| **指令/技能** | `agent-instructions` · `skill` · `skill-filesystem` · `tool-skill` |
| 命令/目标/计划 | `commands` · `command-feedback` · `goal` · `goal-round-driver` · `command-goal` · `plan-mode` |
| 上下文治理 | `token-meter` · `compaction-basic` · `command-compact` · `tool-result-pruner` · `image-offload` · `timeout-policy` · `spill-local` · `spill-policy` · `session-checkpoint-policy` · `repeat-tool-reminder` |
| **subagent** | `subagent` · `subagent-spawn-in-process` · `subagent-fork-in-process` · `tool-subagent-control` · `tool-subagent-list-agents` · `tool-subagent` · `tool-subagent-fork` |
| **PTC** | `ptc-runtime` · `workflow-ptc` · `tool-workflow` |
| todo | `tool-todo` · `tool-goal` |
| **web** | `web` · `web-search-deepseek` · `web-deepseek-api` · `web-fetch-http` · `tool-web` |
| MCP | `mcp-resources`（**只有 resources，没有 client**） |
| 呈现 | `tools` |
| 提示词 | `system-prompt`（被 sdk-app 覆写） |
| 循环 | `agent-loop` · `fs-sandbox` |

`dsh-sdk-app` 层（`dsh-sdk-app/cordis.patch.yml:1-41`）只做 3 件事：

1. 定向 patch `system-prompt.personaPrefix` → `"You are a coding agent powered by the {{model}} model."`
   （**注意副作用**：整块替换 → 丢掉了 base 的 `personaPrefix: ''`，`includeHarnessIdentity` /
   `includeRuntimeContext` 回落到 schema 默认 `true`）；
2. 定向 patch `session-title-llm.disabled: true`、`hmr.disabled: true`；
3. insert `sdk-app-startup`（`@deepseek-ai/dsh-sdk-app`, `config.profile: sdk`）、
   `sdk-jsonrpc-server`（`inject: [sdkAppStartup, loader]`）、`workspace-dependencies`、
   `skill-office`（后两者按 `DSH_PRIMARY_RUNTIME` / `DSH_BUNDLED_*` 环境变量条件 disabled）。

### 2.3 `sdk-minimal` 的组装（35 条，全部来自 `dsh-sdk-minimal/cordis.patch.yml`）

```
sdk-app-startup          @deepseek-ai/dsh-sdk-app                    config.profile: sdk-minimal
sdk-jsonrpc-server       @deepseek-ai/dsh-sdk-jsonrpc-server         inject:[sdkAppStartup,loader]
deepseek-llm-api-extensions
session-log-deepseek
plugin-package-inventory-deepseek
llm-deepseek             @deepseek-ai/dsh-llm-deepseek-api-key       apiKeyEnv: DEEPSEEK_API_KEY
sandbox                  @deepseek-ai/dsh-sandbox-local
filesystem               @deepseek-ai/dsh-fs-local                  ← 非沙箱后端，见 gotcha G6
attachment-local
tool-fs                  config: read:false readImage:true write:false edit:false
working-directory
tool-working-directory
session-projection
token-meter
compaction-basic
image-offload
sandbox-policy           mode: danger-full-access  workspaceRoot: process.cwd()
subprocess
pty                      @deepseek-ai/dsh-terminal
terminal-bash            @deepseek-ai/dsh-terminal-bash             disabled: win32
terminal-pwsh            @deepseek-ai/dsh-terminal-bash             disabled: !win32, shellDialect: pwsh
timer / llm / session / session-title / system-prompt / tools / mcp-resources / agent / llm-retry / jobs
system-prompt            includeHarnessIdentity:false includeRuntimeContext:false
                         personaPrefix: process.env.DSH_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'
agent-loop               agents: []
persistent-bash          @deepseek-ai/dsh-tool-bash-persistent      disabled: win32
persistent-pwsh          @deepseek-ai/dsh-tool-pwsh-persistent      disabled: !win32
sessions                 @deepseek-ai/dsh-session-persistence-jsonl root: dshHomePath('sessions'), compression: none
```

`sdk-minimal/README.md:12` 明确它**排除**：`dsh-base`、Web、settings、managed credentials、
telemetry、text file tools、workspace instructions、skills、jobs、subagents。

### 2.4 能力 → 条目归属（两个 profile 对照）

| 能力 | `sdk` 里的条目 | `sdk-minimal` 里的条目 | 插件包 |
|---|---|---|---|
| **shell / pwsh** | `tool-bash` / `tool-pwsh`（前台、受 sandbox 管）+ `bash-sandbox`/`pwsh-sandbox`/`shell-env` | `pty` + `terminal-bash`/`terminal-pwsh`（PTY 后端）+ `persistent-bash`/`persistent-pwsh`（模型可见工具） | `dsh-tool-bash`, `dsh-tool-pwsh`, `dsh-terminal`, `dsh-terminal-bash`, `dsh-tool-bash-persistent`, `dsh-tool-pwsh-persistent` |
| **文件读写** | `fs-sandbox` + `fs-observation-policy` + `tool-fs`（默认 read/write/edit 全开）+ `tool-fs-search` | `filesystem`(`dsh-fs-local`) + `tool-fs`（四键全关，仅 `readImage`）+ **无** `tool-fs-search` | `dsh-fs-sandbox`, `dsh-fs-local`, `dsh-tool-fs`, `dsh-tool-fs-search` |
| **web fetch/search** | `web` + `web-search-deepseek` + `web-deepseek-api` + `web-fetch-http` + `tool-web` | **完全没有** | `dsh-web`, `dsh-tool-web`, … |
| **subagent** | `subagent` + 2 个 in-process provider + `tool-subagent-control` + `tool-subagent-list-agents` + `tool-subagent` + `tool-subagent-fork` | **完全没有** | `dsh-subagent`, `dsh-tool-subagent`, … |
| **todo** | `tool-todo` | **没有** | `dsh-tool-todo` |
| **skills** | `skill` + `skill-filesystem` + `tool-skill`（+ sdk-app 的 `skill-office`） | **没有** | `dsh-skill`, `dsh-skill-filesystem`, `dsh-tool-skill` |
| **MCP client** | **没有**（两个 profile 都只有 `mcp-resources`） | **没有** | `dsh-mcp-client` 需自己 insert |
| **MCP resources** | `mcp-resources` | `mcp-resources` | `dsh-mcp-resources` |
| **会话持久化** | `session-persistence-jsonl`（`root: dshHomePath('sessions')`，**默认 zstd**）+ `session-query-sqlite` + `storage*` + `session-projection-cache` | `sessions`（`compression: none`）+ `session-projection` | `dsh-session-persistence-jsonl` |
| **系统提示词** | `system-prompt`（被 sdk-app 覆写为 `{{model}}` 人设） | `system-prompt`（`DSH_SYSTEM_PROMPT` 或默认） | `dsh-system-prompt` |
| **provider / 模型路由** | `llm` + `llm-deepseek` + `llm-deepseek-account` + `llm-pi-ai` + `deepseek-llm-api-extensions` + `agent-default-model` | `llm` + `llm-deepseek`（`apiKeyEnv: DEEPSEEK_API_KEY`）+ `deepseek-llm-api-extensions`；模型由 SDK `initialize` 指定 | `dsh-llm`, `dsh-llm-deepseek-api-key`, … |
| **工具呈现模式** | `tools`（无 `config` → schema 默认 `native`） | `tools`（无 `config` → `native`） | `dsh-tools` |

> `native` / `ptc` 的权威定义在 `dsh-tools/lib/types/index.d.ts` `Config.mode`
> （"`native` (default) sends every visible schema; `ptc` sends only `run_code` plus a generated SDK prompt"），
> README 表格同样写 `mode \| native \|`（`dsh-tools/README.md:76-79`）。

---

## 3. 受限业务 agent 的最小树

### 3.1 策略：从 `sdk-minimal` 起步，而不是从 `base`

选择理由（全部来自上面的实测清单）：

1. `sdk-minimal` **已经满足**：系统提示词、provider 路由、`native` 呈现、MCP resources、
   `session-persistence-jsonl`（resume 的前提）、SDK JSON-RPC 服务端。
2. `sdk-minimal` **天然没有**：subagent、skills、`agent-instructions`(AGENTS.md)、plugin-manager、
   PTC runtime(`run_code`)、web 工具、`tool-fs-search`。这些如果从 `base` 起步都要一条条关掉，
   关漏一条就是越权面。
3. 代价：它的 `tool-fs` 关掉了 read/write/edit，`filesystem` 用的是**非沙箱**的 `dsh-fs-local`；
   这两个点见 §3.3 / G6。

### 3.2 必须移除 / 改写的条目（逐条理由）

| 条目 id | 动作 | 为什么必须动 |
|---|---|---|
| `pty` (`dsh-terminal`) | `disabled: true` | PTY 服务本体。留着 PTY = 留着执行通道，即使工具行被关，任何未来插件都能借它起进程 |
| `terminal-bash` (`dsh-terminal-bash`) | `disabled: true` | 阻止平台条件表达式 `!!js process.platform === 'win32'` 决定是否启用——在 Linux 上它是**开**的 |
| `terminal-pwsh` (`dsh-terminal-bash`, `shellDialect: pwsh`) | `disabled: true` | Windows 上它是**开**的；这是本 profile 唯一真实的命令执行面 |
| `persistent-bash` (`dsh-tool-bash-persistent`) | `disabled: true` | 模型可见的 `bash` 工具（Linux/macOS 开） |
| `persistent-pwsh` (`dsh-tool-pwsh-persistent`) | `disabled: true` | 模型可见的 `pwsh` 工具（Windows 开）——**业务 agent 上必须关** |
| `tool-working-directory` | `disabled: true` | 业务 agent 不需要让模型改会话 cwd；`working-directory` **服务**保留（`session/working-directory/*` 协议方法和必填 cwd 上下文依赖它） |
| `tool-fs` | 重写 `config`（四键写全） | 防御性显式化 `write:false, edit:false`，并关掉 `readImage`（它读宿主任意绝对路径，见 G6） |
| `sandbox-policy` | `config.mode: read-only` | `sdk-minimal` 默认是 `danger-full-access`；没有任何写能力时也应把边界收死 |
| `system-prompt` | 重写 `config` | 换成静态业务人设（`config` 整块替换，`includeHarnessIdentity`/`includeRuntimeContext` 必须重写） |
| `tools` | `config.mode: native` | 显式钉死原生呈现，避免有人在上层 patch 里改成 `ptc` 就凭空长出 `run_code` |
| `sessions` | 重写 `config` | 显式钉死 `root` 与 `compression`，确保 resume 落在隔离 home 内 |
| **新增** `biz-tools` | `insert` | 自有工具插件（绝对路径） |
| **新增** `mcp-*` | `insert` | MCP client，每个 server 一行 |

**不需要动的条目**（已核对 `sdk-minimal` 树里本来就没有）：
`dsh-plugin-manager`（无插件管理面）、`dsh-ptc-runtime-node`（无 `run_code` / 任意代码）、
`dsh-subagent*`（无子 agent）、`dsh-skill*`（无技能）、`dsh-agent-instructions`（不读 AGENTS.md）、
`dsh-web*`（无外网工具）、`dsh-tool-fs-search`（无 glob/grep）。

> 保留 `subprocess`(`dsh-subprocess-local`) 与 `jobs`(`dsh-jobs-local`)：两者都**不注册任何模型可见工具**
> （`tool-jobs` 不在树里），但 `sandbox`/`compaction`/MCP stdio 探活依赖它们。是否可安全删除
> → **`未验证`**（本次未做删除后的启动验证）。

### 3.3 `package.json`（`$DSH_HOME\profiles\<name>\package.json`）

```json
{
  "name": "dsh-profile-biz-agent",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-sdk-minimal"
      ]
    }
  }
}
```

- 字段形态由 `initProfile()` 生成（`dsh-app-boot/lib/index.js`），`name` 固定是 `dsh-profile-<目录名>`。
- `dependencies` 留空：本树所有 bundle / 插件都由 **dsh 安装目录**解析（`resolveBundleDir` 先查安装锚点，
  再查 profile 的 `node_modules`，`dsh-app-boot/lib/types/profile.d.ts:222-234`）。
  只有第三方插件（例如社区 MCP 包）才需要写进 `dependencies` 并用 `dsh plugin --profile <name> add` 安装。
- **不要**把 `@deepseek-ai/dsh-base` 加进 `bundles`——那会把 §3.2 的整张表重新打开。

### 3.4 `cordis.patch.yml`（`$DSH_HOME\profiles\<name>\cordis.patch.yml`）

```yaml
# ══════════════════════════════════════════════════════════════════════════
# 受限业务 agent：sdk-minimal + 去 shell / 去文件写 / 原生呈现 / 自有工具 / MCP
# 语法：顶层 YAML 数组，元素为 PatchOptions
#   { id?, insert?, name?, config?, group?, disabled?, inject? }
# 语义：定向 patch 的 config 是【整块替换】，未写的键回落 schema 默认值
# ══════════════════════════════════════════════════════════════════════════

# ── 1. 去掉全部 shell / PTY（这是本 profile 唯一的命令执行面）──────────────
# pty            = PTY 服务本体
# terminal-*     = 前台 shell 服务（按平台表达式二选一启用）
# persistent-*   = 模型可见的 bash / pwsh 工具
- id: pty
  disabled: true

- id: terminal-bash
  disabled: true

- id: terminal-pwsh
  disabled: true

- id: persistent-bash
  disabled: true

- id: persistent-pwsh
  disabled: true

# ── 2. 文件系统：只留只读镜像能力？这里全关，连 read_image 也关 ────────────
# sdk-minimal 的 filesystem 是 dsh-fs-local（非沙箱），read_image 可读任意绝对路径。
# 业务 agent 不需要读宿主文件时，四个开关全 false 最安全。
- id: tool-fs
  config:
    read: false
    readImage: false
    write: false
    edit: false

# ── 3. 不再向模型暴露 working_directory 工具（服务保留，session 协议要用）──
- id: tool-working-directory
  disabled: true

# ── 4. 静态业务人格 ───────────────────────────────────────────────────────
# config 整块替换：三个键必须一起写，否则 includeHarnessIdentity 回落到 true，
# 模型会重新看到 "You are an AI agent powered by DeepSeek Harness." 身份段。
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    personaPrefix: |
      You are a billing support agent for OceansLab.
      Answer only from the tools provided. Never claim to have run code.
      If a tool cannot answer, say so and offer to escalate to a human.

# ── 5. 原生工具呈现（不是 PTC）。显式钉死，防止上层 patch 改成 ptc ─────────
- id: tools
  config:
    mode: native

# ── 6. 沙箱边界收死（sdk-minimal 默认 danger-full-access）─────────────────
- id: sandbox-policy
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()

# ── 7. 会话持久化：resume 的前提 ─────────────────────────────────────────
- id: sessions
  config:
    root: !!js dshHomePath('sessions')
    compression: none

# ── 8. 插入自有工具 + MCP client ─────────────────────────────────────────
- insert:
    # 自有工具插件：inserted 条目的绝对/相对路径会被改写成 file:// URL。
    # 相对路径以【本 patch 文件所在目录】为基准。
    # 模块导出形态：export const name / export const inject / export function apply
    #（或 export default 一个函数/类）。见 §1 速查表的 1k 行。
    - id: biz-tools
      name: 'file:///E:/Code/OceansLabWeb/dsh_oceanslab/plugins/agent-tools/dist/index.js'

    # 一个 MCP server = 一个 mcp-client 条目实例。
    # 工具名会变成 mcp__<serverName>__<rawName>。
    - id: mcp-crm
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: crm
        transport: stdio
        command: node
        args:
          - E:/Code/OceansLabWeb/dsh_oceanslab/plugins/mcp-crm/dist/server.js
        toolCallTimeoutMs: 30000
        failOnStartupError: true      # 生产建议 true：连不上就别装成"能用"

    # Streamable HTTP（不是 "sse"/"http"）
    - id: mcp-kb
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: kb
        transport: streamable-http
        url: http://127.0.0.1:7801/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.KB_MCP_TOKEN}`'
        toolCallTimeoutMs: 30000
        failOnStartupError: true
```

### 3.5 `--patch` 覆盖层（网关按 agent 差异下发，不写进 profile）

同一个文件格式，额外一层，**在 profile patch 之后**应用。适合放"每个 agent 不同"的东西
（人格文本、MCP server 列表、allowlist）。示例 `E:\...\runtime\<agentId>\agent.patch.yml`：

```yaml
# 每个 agent 一份；由网关通过 SDK 客户端 options.patches 传入
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    personaPrefix: !!js '`${process.env.AGENT_PERSONA ?? "You are a helpful business agent."}`'

# 只放开该 agent 需要的那一个 MCP server（其余行不放 = 不暴露）
- id: mcp-crm
  config:
    serverName: crm
    transport: stdio
    command: node
    args: ['E:/Code/OceansLabWeb/dsh_oceanslab/plugins/mcp-crm/dist/server.js']
    toolCallTimeoutMs: 30000
    failOnStartupError: true
```

> 覆盖层里**同样可以只有一部分键**，但那会整块替换 `config`——所以上面把 `mcp-crm` 的
> `config` 写全了。这是最容易踩的坑（G2）。

### 3.6 对照 `runtime/templates/studio/cordis.patch.yml` 的评审

该模板（profile 名 `studio`，`bundles: ["@deepseek-ai/dsh-sdk-minimal"]`）经实测**可以正常 boot**
（`exit=0`、零 warning，见 §7.7）。逐条评审：

**已经正确、不要改的：**

| 行 | 结论 |
|---|---|
| `disabled: pty` + `terminal-bash` + `terminal-pwsh` + `persistent-bash` + `persistent-pwsh` | ✅ 正确且**完整**——这 5 行是 `sdk-minimal` 里 shell 能力的所有入口，缺任何一条都会在某些平台上留下执行面 |
| `disabled: tool-fs` + `tool-working-directory` | ✅ 比"把 `tool-fs` 四键全关"更彻底（连 `read_image` 都没有）。底层 `fs` 服务保留也正确 |
| `disabled: session-log-deepseek` | ✅ 安全（实测），无插件硬依赖它 |
| `tools.config.mode: native` | ✅ 正确；注意要写全 `config`（本行只有一个键，无副作用） |
| `sandbox-policy` → `mode: read-only` + `workspaceRoot: '{{WORKSPACE}}'` | ✅ **schema 合法、实测被采纳**。`read-only` 是 `SandboxMode`，且是该插件自己的 fail-safe 默认值。⚠️ 但见下方第 2 条：`workspaceRoot` 在这里**几乎不起作用** |
| 三条 `insert`（policy / tools / audit） | ✅ 三条都能用 `{{...}}` 绝对路径挂载并生效 |

**需要补的（按重要性排序）：**

1. **`- id: system-prompt` 没有覆盖** → 人格完全依赖进程环境变量
   `DSH_SYSTEM_PROMPT`；不设时模型拿到的是 `sdk-minimal` 写死的
   `'You are a helpful software engineer assistant.'`——对一个"业务 agent"是**错误人设**。
   建议在模板里显式写死，或至少把这条列成"必须由 RuntimeMaterializer 设置 `DSH_SYSTEM_PROMPT`"的硬约束：
   ```yaml
   - id: system-prompt
     config:
       includeHarnessIdentity: false
       includeRuntimeContext: false
       personaPrefix: '{{PERSONA}}'
   ```
   （`config` 整块替换，所以三个键要一起写；`{{PERSONA}}` 由生成器替换成纯文本。
   若走 `!!js process.env.DSH_SYSTEM_PROMPT`，注意 `--dump-config` **不会**求值，校验要靠真实请求。）

2. **`workspaceRoot` 的实际作用被高估了。** 在 `sdk-minimal` 里没有 `fs-sandbox`、
   也没有 `bash-sandbox`/`pwsh-sandbox`，所以 `sandbox-policy.workspaceRoot` 基本没有
   执行者去消费它；`filesystem` 仍是 `dsh-fs-local`，`config.cwd` 不是 containment boundary。
   也就是说**当前"写不出这个目录"的保障并不存在**，真正的保障来自"没有任何文件/shell 工具"。
   如果要让 `workspaceRoot` 真的有约束力，需要额外把 `filesystem` 换成
   `dsh-fs-sandbox`（已验证可 boot，见 §7.7）。
   注释里"即使将来误加了文件工具，也写不出这个目录"这句**建议改掉或补上 fs-sandbox 替换**，
   否则会误导后续开发。

3. **`mcp-resources` 仍在树里** → 会额外暴露 MCP 的资源列举/读取工具。
   如果只想要 `mcp__<server>__<tool>` 这类工具，加 `- id: mcp-resources, disabled: true`
   （安全性收益明确；**停用后是否有硬依赖 `未验证`**）。
   若保留是刻意决定，建议在注释里写明理由。

4. **`jobs`(`dsh-jobs-local`) / `subprocess` 仍在树里** → 不注册模型可见工具，可保留；
   但请在评审记录里注明"它们只提供进程服务、不暴露工具"，避免有人误以为还有执行面。

5. **`mcp.cordis.yml` 模板本身没问题**，但要注意它作为独立覆盖层时：
   ①它应用在 profile patch **之后**，所以想改 profile 里已有 mcp 行的 `config` 必须**整块重写**；
   ②`- insert: []` 是合法 no-op，但生成器若产出空文件，注意不要留下语法不完整的 YAML
   （空文件会解析成 `undefined`，`parsePatchList` 要求顶层数组）。

6. **注释里"policy 必须排在 tools 之前加载"这句需要修正**（G19）：行顺序不决定加载顺序。
   守卫的覆盖面要靠 policy 插件在 `apply()` 里注册 monotonic guard / `pre-execute` 监听来保证。

**建议新增的（可选，与 L2 策略插件配套）：**

- 若确定不需要会话标题的模型调用：`- id: session-title, disabled: true`（`sdk-minimal` 已把
  `session-title-llm` 排除在树外，但 `session-title` 的确定性兜底仍在；保留通常无害）。
- 若业务 agent 不需要图片：`- id: attachment-local, disabled: true` 可再砍掉 `$DSH_HOME/attachments`
  的写入面（**`未验证`** 是否有其他插件软依赖）。


---

## 4. 系统提示词

### 4.1 谁拥有它

- **注册表本体**：`@deepseek-ai/dsh-system-prompt`（`ctx.systemPrompt`，服务 `SystemPrompt`）。
  它按 `order` 拼装 sections / contexts / tools / variables，并提供固定的 section 位置表
  （`HARNESS_IDENTITY: -1000`、`DEPLOYMENT_PERSONA_PREFIX: 0`、`TOOL_*: 1000-3000`、
  `MCP_SERVERS: 3100`、`TOOLS_SDK: 5000`、`DEPLOYMENT_PERSONA_SUFFIX: 10200` 等）。
  （`dsh-system-prompt/lib/types/index.d.ts` `SECTION_ORDERS`）
- **人设内容**：注册表自己的 `Config`：

| 配置键 | 含义 | 默认 |
|---|---|---|
| `includeHarnessIdentity` | 是否在部署人设之前加固定 Harness 身份段 | `true` |
| `includeRuntimeContext` | 是否把可选运行时上下文快照写进模型历史（required 上下文仍保留） | `true` |
| `personaPrefix` | 部署人设**前缀**模板（严格 `{{变量}}` 插值） | `''` |
| `personaSuffix` | 部署人设**后缀**模板 | 空 |
| `toolOrder` | 模型可见工具名顺序，`<unlisted-tools>` 出现且仅出现一次；省略=字典序 | 省略 |

### 4.2 静态 agent 系统提示词怎么注入

**单 agent 场景（网关一个 agent 一个 runtime）：直接写 `system-prompt.config.personaPrefix`。**
见 §3.4 第 4 段。这是唯一"无副作用"的静态注入点。

不要用 `@deepseek-ai/dsh-persona`：它**只能在 agent preset 的 scope 内挂载**
（`dsh-persona/lib/types/index.d.ts:1-20`："Mounted inside an agent preset it shadows the
deployment persona for that one session… mounted globally it collides with the registry's
own registration and fails loud"）。一个 runtime 只跑一个 agent 时，`personaPrefix` 更简单。

**要"整段覆盖"而不是"作为前缀拼接"**：`personaPrefix` 只是 order=0 的一片 section，
后面还有各工具插件注册的引导段（`TOOL_BASH: 1000` … `TOOLS_SDK: 5000`）。
如果业务 agent 要求系统提示词**只有我们的文本**，需要 `complete: true` 语义——那只能靠
`dsh-persona` 的 `config.complete` 或 agent preset 里的 scope 注册；`dsh-system-prompt.config`
没有 `complete` 键（`dsh-persona/lib/types/index.d.ts` `Config.complete`：
"Make the prefix the complete system prompt, suppressing the suffix and every other section"）。
→ **单 agent + 需要 complete 的组合，本次未做启动验证，标 `未验证`**。

### 4.3 不吃开发者的 AGENTS.md / 全局指令 / skills / memory

要分清三种"个人上下文"的来源：

| 来源 | 谁读 | 怎么切断 |
|---|---|---|
| `$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME\|\~/.agents/AGENTS.md`、项目 `AGENTS.md`/`CLAUDE.md`/`AGENTS.local.md` | `@deepseek-ai/dsh-agent-instructions` | ①`bundles` 里不放含它的 bundle（`sdk-minimal` 就没有）；②若从 `base` 起，`- id: agent-instructions, disabled: true` 或 `config.maxBytes: 0`（"non-positive or non-finite disables loading"，`dsh-agent-instructions/lib/types/config.d.ts:15-18`）；③**两个 home 环境变量都要指向隔离目录**——`README.md:40` 明确："The harness home holding the user-global `AGENTS.md` is process policy rather than row configuration… Stray `dshHome` and `agentsHome` row keys are ignored." |
| skills（`~/.dsh/skills`、项目 `.dsh/skills` 之类） | `dsh-skill-filesystem` + `dsh-tool-skill` | 不挂这两个条目（`sdk-minimal` 没挂）。skill 目录只在插件被挂载时才被扫描 |
| 长期 memory | 两个 bundle 里**都没有 memory 插件** | 无插件可关；`$DSH_HOME` 里只有 `sessions/`、`storages/`、`attachments/` 等运行产物。**不要**把开发者的 `$DSH_HOME` 复用给业务 runtime |

补充两条硬隔离：

#### ⚠️ 一个常见误解：那两个 flag **不**负责挡 AGENTS.md / skills

`sdk-minimal` 的 `system-prompt.config` 已经写了
`includeHarnessIdentity: false`、`includeRuntimeContext: false`
（`dsh-sdk-minimal/cordis.patch.yml:113-118`）。这两个键的真实语义很窄：

| 键 | 只管什么 | **不管**什么 |
|---|---|---|
| `includeHarnessIdentity` | 固定 Harness 身份段（`SECTION_ORDERS.HARNESS_IDENTITY = -1000`） | AGENTS.md、skills、memory |
| `includeRuntimeContext` | **可选**运行时上下文快照（`PromptContext` 里非 `required` 的贡献；`required: true` 的仍保留） | AGENTS.md 之类作为 `user/message` 落进历史的指令块 |

**`sdk-minimal` 不吃开发者 `AGENTS.md` / 全局 skills 的原因是"这些插件根本不在树里"**——
`dsh-agent-instructions`、`dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill` 一个都没挂
（对照 §2.3 的 35 行清单）。那两个 flag 即使都设成 `true`，也不会让 AGENTS.md 突然出现。

反过来说：**如果将来有人往 `bundles` 里加一个带 `agent-instructions` 的 bundle，
这两个 flag 拦不住它**。所以隔离必须双保险：
①`bundles` 只放 `sdk-minimal`；②`DSH_HOME` / `DSH_AGENTS_HOME` 指向隔离目录（§6）。

（`required: true` 的上下文——例如 `working-directory` 提供的 current directory——即使用
`includeRuntimeContext: false` 也仍会进模型历史；要连它一起去掉只能不挂 `working-directory`
或 `ctx.systemPrompt.suppressRuntimeContext()`，后者**本次未验证**。）

- `DSH_SYSTEM_PROMPT` 环境变量会**整段替换**人设默认值
  （`personaPrefix: !!js process.env.DSH_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'`，
  `dsh-sdk-minimal/cordis.patch.yml:116-118`）。
  我们显式写死 `personaPrefix` 后就绕过了它；**但不要在进程环境里留这个变量**，
  以免有人后来把 patch 改回默认表达式而"意外"注入自由文本。

---

## 5. MCP

### 5.1 条目与形态

一个 server = 一个条目实例（`dsh-mcp-client` 是 namespace 插件，无 default export，
`lib/types/index.d.ts:1-17`）。配置是 `Config = StdioConfig | StreamableHttpConfig`：

| 键 | 适用 | 必填 | 说明 |
|---|---|---|---|
| `transport` | 全部 | ✅ | **`stdio`** 或 **`streamable-http`**（没有 `sse`，没有 `http`） |
| `serverName` | 全部 | ✅ | `[A-Za-z0-9_-]{1,32}`，同一注册 scope 内唯一；决定工具前缀 |
| `command` / `args` / `env` / `cwd` | stdio | command ✅ | `args` 不做 shell 插值；`env` 叠加在"清洗过的环境"之上 |
| `url` / `headers` | streamable-http | url ✅ | — |
| `toolCallTimeoutMs` | 全部 | ❌ 默认 `60000` | 单次 `tools/call` / resource 请求超时 |
| `maxInstructionBytes` | 全部 | ❌ 默认 `32768` | server instructions 归属文本上限，超限**拒绝连接** |
| `failOnStartupError` | 全部 | ❌ 默认 `false` | `true` = 初次连接或工具同步失败时让插件激活失败 |
| `reconnect.*` | 全部 | ❌ | `enabled`(true) / `initialDelayMs`(500) / `maxDelayMs`(30000) / `maxAttempts`(10) |

工具公开名：`mcp__<serverName>__<rawName>`（例 `mcp__crm__get_invoice`）；不同 server 的同名工具
不会冲突；同一 `serverName` 的第二个条目**加载失败**（`README.md:37-58`）。

### 5.2 只放开"命名的子集"

**推荐（也是唯一可控的）做法：组合层裁剪。** 只 insert 需要的 mcp-client 行；
不 insert 的 server 根本不连接、不发现工具、不加一行 prompt 文本。
`sdk-minimal/README.md:41` 给出了这个语义的正面表述：
"Configure only MCP client entries to add servers… With no server configured in the caller's scope,
MCP contributes no prompt text or tools."

三个层次的"子集"：

1. **server 子集** → 条目的有无（组合层）。最干净，推荐。
2. **按 agent 的子集** → 用 `@deepseek-ai/dsh-agent-preset` 把 mcp-client 行挂在 preset 的
   `plugins` 里（`PresetDefinition = { id, name?, description?, order?, plugins: EntryOptions[] }`，
   `dsh-agent-preset-registry/lib/types/definition.d.ts`），preset 是 scope 级注册，
   "Clients mounted by another provider also count as configured"（`sdk-minimal/README.md:41`）。
   一个 runtime 一个 agent 时这一层可以不用。
3. **按工具的严格子集** → `ctx.tools.restrict({ allow: [...] })` / `{ deny: [...] }`
   （`dsh-tools/lib/types/index.d.ts` `ToolRestriction`）。**限制**：只接受**精确工具名**，
   "Empty filters, unknown names, scope-local names, and reserved transport names fail"——
   没有通配符，且必须在 server 完成工具发现之后才知道要写哪些名字。
   对动态工具集的 server 不实用。→ 需要"精确白名单"时，**在自有工具插件里
   `apply()` 时调用 `ctx.tools.restrict`**，并用 `tools/change` 事件在发现变化后重算，
   或在 MCP 前面套一层自建代理 server 只暴露白名单工具。**本组合方案未做运行验证（`未验证`）**。

### 5.3 MCP + `mcp-resources`

两个 bundle 都挂了 `mcp-resources`（`@deepseek-ai/dsh-mcp-resources`），它提供
"列出/读取 MCP resource"的共享工具，按 server 数量自动出现。业务 agent 如果只要 tools，
可以考虑一并停用 `mcp-resources` 以减少工具面（**未验证**停用后是否有插件硬依赖它）。

---

## 6. runtime home 隔离

### 6.1 目录树（隔离 runtime）

```
$DSH_HOME\                                  ← 每个 agent（或每租户）一个独立目录
├─ cordis.patch.yml                         (可选) home 级 patch 层，作用于该 home 下所有 profile
├─ profiles\
│  └─ biz-agent\                            ← profile 名 = 目录名 = `--profile` 参数
│     ├─ package.json                       ✅ 必须（dsh.profile.bundles）
│     ├─ cordis.patch.yml                   ✅ 必须（用户 patch 层，可写 `[]`）
│     ├─ cordis.yml                         ⛔ 自动生成/每次启动重写，禁止手写
│     ├─ pnpm-workspace.yaml                (initProfile 自动生成，`dsh plugin` 用)
│     └─ node_modules\                      (仅当 profile 有第三方插件依赖时才需要)
├─ sessions\                                (运行时创建：JSONL 会话日志，resume 依赖它)
├─ storages\                                (base 系才有：storage-json 的 KV 落盘)
└─ attachments\                             (运行时创建：v1 图片字节)
```

`~/.dsh` 是 `DSH_HOME` 未设时的默认值（`dsh-home-paths` `DSH_HOME_DIR_NAME = ".dsh"`），
`~/.agents` 是 `DSH_AGENTS_HOME` 未设时的默认值。**两个都要指向隔离目录。**

### 6.2 为什么必须隔离

| 目录/文件 | 被谁读写 | 复用的后果 |
|---|---|---|
| `profiles/` | launcher 解析 + `dsh plugin` | 串 profile、串 bundle 列表 |
| `sessions/` | `dsh-session-persistence-jsonl` | **A 的会话被 B 读到/续上**（`session/resume` 只按 `sessionId` 找） |
| `storages/` | `dsh-storage-json`（base 系） | 投影缓存/会话索引串号 |
| `attachments/` | `dsh-attachment-local` | 图片字节跨 agent 可见 |
| `AGENTS.md` | `dsh-agent-instructions` | **开发者的个人指令进业务 prompt** |
| `.credentials.yaml` | `dsh-credentials-local`（base 系） | 凭据面扩大；`sdk-minimal` **不读**它 |
| `.anonymous-user-id` | `dsh-otel`（base 系） | 遥测身份合并 |

### 6.3 全新 home 的最小形态

**只要两件事**（实测，见 §7.5）：

```
<home>\profiles\biz-agent\package.json
<home>\profiles\biz-agent\cordis.patch.yml
```

- 首启自动生成 `cordis.yml`（空根）。
- `sessions/` 在第一次真正物化会话时才创建；dump/boot 不会创建。
- `sdk-minimal` 的 `llm-deepseek.apiKeyEnv = DEEPSEEK_API_KEY` → **不需要 `.credentials.yaml`**，
  密钥从进程环境读（`dsh-llm-deepseek-api-key` 每次请求时解析）。
- `--from-default-profile` 可以一步生成 `package.json` + 空的 `cordis.patch.yml`（+ `pnpm-workspace.yaml`），
  之后只覆盖 `cordis.patch.yml` 即可。

---

## 7. 验证（命令 + 证据）

环境：`node v24.21.0`，`@deepseek-ai/dsh@0.2.1-rc.3`，CLI 在
`E:\Code\OceansLabWeb\dsh_oceanslab\node_modules\@deepseek-ai\dsh\lib\bin.js`。
**每个命令都先设 `$env:DSH_HOME`**（否则会落到 `~/.dsh`）。

### 7.1 基线：`sdk` / `sdk-minimal` 的完整树

```powershell
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-test'
node node_modules\@deepseek-ai\dsh\lib\bin.js --version
# 0.2.1-rc.3

node node_modules\@deepseek-ai\dsh\lib\bin.js --profile sdk-minimal --dump-config
# → 153 行；层注释只有一行 `# == @deepseek-ai/dsh-sdk-minimal`

node node_modules\@deepseek-ai\dsh\lib\bin.js --profile sdk --dump-config
# → 409 行；层注释四类：
#   # == @deepseek-ai/dsh-base
#   # == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-sdk-app
#   # == @deepseek-ai/dsh-sdk-app
#   # == @deepseek-ai/dsh-base, patched by ...\profiles\sdk\cordis.patch.yml, ...--patch 文件
```

`sdk` 的 patch 证据（证明 `config` 整块替换）：

```yaml
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-sdk-app
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: You are a coding agent powered by the {{model}} model.
```

base 里原本是：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: ''
```

→ `includeHarnessIdentity` / `includeRuntimeContext` 这两个键在 base 与 sdk-app 两层里**都没写**，
所以一直是 schema 默认值 `true`（只有 `sdk-minimal` 显式写了 `false`）。
这个例子说明的是：**上层 patch 只要写 `config`，就必须把整个 `config` 写全**——
没写的键不会保留下层值，而是回落到插件 schema 默认值。

### 7.2 `--from-default-profile` 初始化受限 profile

```powershell
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-test'
node node_modules\@deepseek-ai\dsh\lib\bin.js `
  --profile biz-agent --from-default-profile sdk-minimal --dump-config
```

生成（实测）：

```
.tmp\home-test\profiles\biz-agent\
  cordis.patch.yml      ← 注释 + `[]`
  cordis.yml            ← 空根（自动）
  package.json          ← {"name":"dsh-profile-biz-agent","private":true,"dependencies":{},
                           "dsh":{"profile":{"bundles":["@deepseek-ai/dsh-sdk-minimal"]}}}
  pnpm-workspace.yaml
```

> `--from-default-profile` 的语义：**用模板的 bundle 列表覆盖目标 profile**，会把已有目录整个替换
> （`dsh/lib/types/profile-boot.d.ts:27-45`：先在 `.<name>.staging-*` 组装再 move，成功后才删旧目录）。
> 所以网关流程里它只用于**首次物化**，之后一律写文件、不要在每次启动时带这个 flag。

### 7.3 受限树 dump（**核心证据**）

```powershell
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-min'
node node_modules\@deepseek-ai\dsh\lib\bin.js --profile biz-agent --dump-config
# exit=0，181 行
```

关键片段（原样粘贴，只删了长 description）：

```yaml
# == @deepseek-ai/dsh-sdk-minimal
- id: sdk-app-startup
  name: '@deepseek-ai/dsh-sdk-app'
  config:
    profile: sdk-minimal
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  inject: [sdkAppStartup, loader]
  config:
    maxTokensAsSuccess: false
...
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    read: false
    readImage: true          # ← 探针 patch 之前的原始值
    write: false
    edit: false

# == @deepseek-ai/dsh-sdk-minimal, patched by ...\.tmp\home-min\profiles\biz-agent\cordis.patch.yml
- id: tool-working-directory
  name: '@deepseek-ai/dsh-tool-working-directory'
  disabled: true
# == @deepseek-ai/dsh-sdk-minimal
- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'
...
# == @deepseek-ai/dsh-sdk-minimal, patched by ...\profiles\biz-agent\cordis.patch.yml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()
# == @deepseek-ai/dsh-sdk-minimal
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
# == @deepseek-ai/dsh-sdk-minimal, patched by ...\profiles\biz-agent\cordis.patch.yml
- id: pty
  name: '@deepseek-ai/dsh-terminal'
  disabled: true
- id: terminal-bash
  name: '@deepseek-ai/dsh-terminal-bash'
  disabled: true
  config:
    timeoutMs: 300000
- id: terminal-pwsh
  name: '@deepseek-ai/dsh-terminal-bash'
  disabled: true
  config:
    shellDialect: pwsh
    timeoutMs: 300000
# == @deepseek-ai/dsh-sdk-minimal
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: session
  name: '@deepseek-ai/dsh-session'
- id: session-title
  name: '@deepseek-ai/dsh-session-title'
  config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }
# == @deepseek-ai/dsh-sdk-minimal, patched by ...\profiles\biz-agent\cordis.patch.yml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    personaPrefix: |
      You are a billing support agent for OceansLab.
      Answer only from the tools provided. Never claim to have run code.
      If a tool cannot answer, say so and offer to escalate to a human.
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: native
# == @deepseek-ai/dsh-sdk-minimal
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
- id: agent
  name: '@deepseek-ai/dsh-agent'
- id: llm-retry
  name: '@deepseek-ai/dsh-llm-retry'
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []
```

**末尾是本次 insert 的两行（来自 profile patch 层）：**

```yaml
# == E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-test\profiles\biz-agent\cordis.patch.yml
- id: biz-tools
  name: file:///E:/Code/OceansLabWeb/dsh_oceanslab/.tmp/probe-plugin/index.js
- id: mcp-crm
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: crm
    transport: stdio
    command: node
    args:
      - E:/Code/OceansLabWeb/dsh_oceanslab/.tmp/probe-plugin/mcp-stub.js
    toolCallTimeoutMs: 30000
    failOnStartupError: false
```

→ 证明：①6 条 shell/PTY/工具行变 `disabled: true`；②`tool-fs` / `system-prompt` /
`tools` / `sandbox-policy` 的 `config` 被整块替换成我们写的键；③自有工具 + MCP client
作为新行出现在树的**末尾**，且 `name` 已被规范化为 `file:///…`。

### 7.4 patch 语义逐条实证

**(a) 层顺序 + last-write-wins + 缺失 id 容忍 + 相对路径锚定**

```powershell
# home 级层
@'
- id: system-prompt
  config: { personaPrefix: HOME-PATCH-WINS }
- id: tool-fs
  disabled: true
'@ > $env:DSH_HOME\cordis.patch.yml

node ... --profile biz-agent --dump-config
#   → personaPrefix: HOME-PATCH-WINS        （home 覆盖 profile）
node ... --profile biz-agent --dump-config --patch .tmp\patches\overlay-a.patch.yml
#   → personaPrefix: OVERLAY-PATCH-WINS     （--patch 覆盖 home）
#   stderr: dsh: [...overlay-a.patch.yml] patch: entry "does-not-exist" not found
#           dsh: [...overlay-a.patch.yml] patch: entry "name-mismatch-probe" not found
#   exit=0  ← 打不中只是 warning，不失败
```

覆盖层里 `- id: overlay-rel-plugin / name: '../probe-plugin/index.js'`（overlay 文件在
`.tmp\patches\`）被解析成 `file:///E:/Code/OceansLabWeb/dsh_oceanslab/.tmp/probe-plugin/index.js`
——证明**相对路径以 patch 文件目录为基准**。

**(b) 绝对路径两种写法都行**

```yaml
- insert:
    - id: biz-tools
      name: 'E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\probe-plugin\index.js'   # 反斜杠绝对路径
```

dump 输出被规范化为 `file:///E:/Code/OceansLabWeb/dsh_oceanslab/.tmp/probe-plugin/index.js`，
并且**实际启动后插件生效**（见 (c)）。结论：两种写法等价，底层都走
`anchorInsertedPluginNames()` → `pathToFileURL(resolve(dirname(patchFile), name))`。

**(c) 自有工具插件真的在树里跑起来了（最重要的证据）**

探针插件（`.tmp\probe-plugin\index.js`，命名导出 `name` / `inject: ['tools']` / `apply`）
在 `apply()` 里注册 `probe_echo` 工具并写一个副作用文件：

```powershell
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-min'
Remove-Item .tmp\probe-plugin\apply-ran.txt -ErrorAction SilentlyContinue
$o = (echo '' | node node_modules\@deepseek-ai\dsh\lib\bin.js --profile biz-agent 2>&1 | Out-String)
# boot-exit=0 ; stdout/stderr 均为空
Get-Content .tmp\probe-plugin\apply-ran.txt
# probe-tools applied
# probe_echo registered on ctx.tools
```

（`echo '' |` 是为了让 sdk-app 的 stdin-EOF 触发有界正常退出；`exit=0` 说明整棵树
—— 含 `sdk-jsonrpc-server`、`agent-loop`、`mcp-resources`、我们的 `biz-tools` —— 都成功挂载。）

**(d) schema dump 也认得这两行**

```powershell
node ... --profile biz-agent --dump-config-schema > .tmp\out\schema-biz.json   # exit=0, ~184 KB
```

里面出现：

```json
"const": "biz-tools"
"const": "file:///E:/Code/OceansLabWeb/dsh_oceanslab/.tmp/probe-plugin/index.js"
"const": "mcp-crm"
```

### 7.5 全新 home 的最小形态（实测）

```powershell
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-min'
# 只放两个文件
#   profiles\biz-agent\package.json
#   profiles\biz-agent\cordis.patch.yml
node ... --profile biz-agent --dump-config     # exit=0, 181 行
echo '' | node ... --profile biz-agent         # exit=0，无输出
Get-ChildItem $env:DSH_HOME -Recurse
#   profiles\biz-agent\{package.json, cordis.patch.yml, cordis.yml}
#   → cordis.yml 是首启自动生成；没有 sessions\ 目录（还没物化会话）
```

### 7.6 踩到的错误与解决

| 现象 | 原因 | 解决 |
|---|---|---|
| `Error: Cannot find package '...\node_modules\js-yaml\index.js'` | npm 安装尚未把 hoisted 依赖落盘（`js-yaml` 目录已建但为空） | 等安装完成；`node -e "require.resolve('js-yaml')"` 能解析后再跑 |
| `Error: Cannot find module '...\node_modules\@deepseek-ai\dsh\lib\bin.js'` | 另一个进程正在重装 `node_modules`（目录被临时移走） | 轮询 `Test-Path` 直到稳定；不要并发触发安装 |
| `dsh: warning: N entries did not activate` + 个别插件 `failed to import: ERR_MODULE_NOT_FOUND 'node_modules\yaml\...'` | 安装树缺 hoisted 传递依赖（`yaml`、`diff`），**退出码仍是 0** | 补装依赖；**这条说明"起得来"不等于"工具全在"**（见 G1） |
| `dsh --profile <name> --dump-config` 退出 1 且提示 profile 不存在 | 忘了设 `DSH_HOME`，落到了默认 `~/.dsh` | 每个调用显式设 `$env:DSH_HOME` |
| `--profile sdk-minimal` 无法作为自定义名的 `--from-default-profile` 目标 | 随附 profile 名是保留的 | 自定义名（如 `biz-agent`）+ `--from-default-profile sdk-minimal` |
| ``Error: tool "X" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)``，且 `dsh: warning: 2 entries did not activate`、**exit 仍为 0** | 两个插件注册了同名工具（我用同一个探针插件填了三个 insert 占位符） | 工具名全局唯一。这也是 G1 的真实样本：**一个能力整块没挂上，进程照样成功退出** |

### 7.7 针对实际模板（`runtime/templates/studio/cordis.patch.yml`）的验证

把该模板的 `{{...}}` 占位符替换成真实路径后，在 scratch home 里整树启动：

```powershell
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-studio'
# profiles\studio\package.json  →
#   bundles: ["@deepseek-ai/dsh-sdk-minimal"]
# profiles\studio\cordis.patch.yml → runtime\templates\studio\cordis.patch.yml 替换占位符后的副本
echo '' | node node_modules\@deepseek-ai\dsh\lib\bin.js --profile studio
# boot-exit=0 ; stdout/stderr 均为空（零 warning）
```

由此逐条确认：

| 待确认项 | 结果 | 证据 |
|---|---|---|
| `sandbox-policy` 能否在 `sdk-minimal`（钉死 `danger-full-access`）之上改成 `mode: read-only` | ✅ **可以**，schema 合法且被采纳 | boot `exit=0` 无 warning；`dsh-sandbox-policy` 的 `SandboxMode` 本身就以 `read-only` 为 fail-safe 默认值（`dsh-sandbox-policy/lib/types/index.d.ts:34-41`："`mode: 'read-only'` is the fail-safe default"） |
| `workspaceRoot` 写**字面量路径**而不是 `!!js process.cwd()` | ✅ 可以 | 模板里写 `'{{WORKSPACE}}'`，boot 正常 |
| 停用 `session-log-deepseek`（会话上报） | ✅ 安全 | boot `exit=0` 无 warning，无插件因缺 `sessionLog` 失败 |
| 停用 `tool-fs`（整行） | ✅ 安全 | 同上；`fs` 服务仍由 `filesystem` 行提供，`attachment-local` / `working-directory` 不受影响 |
| 停用 `tool-working-directory` | ✅ 安全 | `working-directory` **服务**保留即可 |
| 三条 `insert` 的自有插件按 `{{...}}` 绝对路径挂载 | ✅ 全部生效 | boot 无 warning（第一轮我误用同一插件填三个占位符，才报 `tool already registered`，见 §7.6 末行） |
| `mcp-client` 用**裸包名**从 profile 解析 | ✅ **可以，无需绝对路径或 node_modules 软链** | 见下方专测 |
| **`insert` 顺序是否等于加载顺序** | ❌ **不等于** | `dsh-base/cordis.patch.yml:11-13`："Row order carries no load semantics (**activation is service-availability driven**); the grouping is for readers." 所以"policy 排在 tools 之前"**不会**保证守卫先于工具注册 |

**`mcp-client` 裸包名解析专测**（用 `failOnStartupError: true` 强制暴露"插件到底跑没跑"）：

```yaml
- insert:
    - id: mcp-proof
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: proof
        transport: stdio
        command: node
        args: ['E:/nonexistent/definitely-not-here.js']
        toolCallTimeoutMs: 5000
        failOnStartupError: true
```

```text
boot-exit=0
dsh: warning: 1 entry did not activate
mcp-proof (@deepseek-ai/dsh-mcp-client): Error: mcp-client(proof):
    initial connection or tool synchronization failed
Error: spawn EPERM
  at ... @modelcontextprotocol/client/dist/stdio.mjs:74:20
```

→ 插件名**确实**从 `@deepseek-ai/dsh-mcp-client` 解析成功并真实执行到了 `spawn`。
（`spawn EPERM` 是本会话沙箱禁止子进程捕获 stdio 的环境限制，**不是配置问题**；
换成可用命令即可。这条同时证明 `failOnStartupError: true` 会让失败**可见**，
而 `false` 时它会变成一条静默的"少了一个 server"。）

**此外还确认了 `filesystem` 后端可替换**（G6 的正解）：

```yaml
- id: filesystem
  disabled: true
- insert:
    - id: fs-sandbox
      name: '@deepseek-ai/dsh-fs-sandbox'
      config:
        cwd: !!js process.cwd()
```

```text
boot-exit=0 ; output=[]
dump:
- id: filesystem
  name: '@deepseek-ai/dsh-fs-local'
  disabled: true
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.cwd()
```


---

## 8. 网关如何物化一个 runtime

### 8.1 输入 → 文件

给定 `(agentId, version, toolAllowlist, mcpServers[])`：

| 顺序 | 写什么 | 路径 | 何时重写 |
|---|---|---|---|
| 1 | runtime home 目录 | `<runtimeRoot>\<agentId>\` → 设 `DSH_HOME` | 创建时 |
| 2 | profile `package.json` | `<home>\profiles\<profile>\package.json` | 仅版本变更时 |
| 3 | profile `cordis.patch.yml` | `<home>\profiles\<profile>\cordis.patch.yml` | 仅**模板**变更时（结构性，全 agent 一致） |
| 4 | agent 覆盖层 | `<runtimeRoot>\<agentId>\agent.patch.yml` | 每次 agent 配置变更 |
| 5 | 自有工具插件 `dist` | 由构建产物提供，patch 里用**绝对路径**引用 | 随发布 |

- **步骤 2/3 是最小公共骨架**（§3.3 / §3.4），一个版本只算一次，可缓存/共享。
- **步骤 4 才是 per-agent 差异**（人格文本、MCP server 列表、allowlist），
  通过 SDK 客户端的 `patches` 传入，**不落进 profile 目录**，避免并发写同一个文件。
- `toolAllowlist` 的落地方式按可行性排序：
  1. **不 insert 对应条目**（MCP server / 工具插件）—— 最强、最简；
  2. 在覆盖层里 `- id: <row>, disabled: true`；
  3. 在自有工具插件里 `ctx.tools.restrict({ allow | deny })`（精确名，见 §5.2 限制）。

### 8.2 SDK 客户端参数（TypeScript）

`HarnessClientOptions`（`dsh-sdk-client/lib/types/types.d.ts`）：

| 参数 | 作用 |
|---|---|
| `dshBin` | dsh CLI 模块路径；省略则用客户端同版本依赖 |
| `profile` | profile 名（默认 `"sdk"`）→ 变成 `--profile <name>` |
| `patches: string[]` | **有序**覆盖层 → 变成重复的 `--patch <abs>`（相对路径按 `callerCwd` 解析） |
| `dshHome` | → 子进程环境变量 `DSH_HOME`（相对路径按 `callerCwd` 解析） |
| `processCwd` | dsh **进程**的 cwd |
| `env` | **完整替换**子进程环境（不是合并）→ 凭据策略由调用方负责；**记得带上 `DSH_AGENTS_HOME`** |
| `initializeTimeoutMs` / `requestTimeoutMs` / `shutdownTimeoutMs` / `disposeEofGraceMs` / `disposeGraceMs` | 超时调优 |

`DeepSeekHarnessOptions` 追加：

| 参数 | 作用 |
|---|---|
| `cwd` | **会话 workspace**（写进每个 SDK 创建的 session 的 origin/effective directory） |
| `provider` | 路由（默认 `deepseek-official`） |
| `model` | 默认 `deepseek-v4-flash` |
| `reasoningEffort` / `maxTokens` | 适配器推理强度 / 单次请求输出上限 |

真实 argv 构造（`dsh-sdk-client/lib/index.js` `resolveDshLaunch()`）：

```js
args: [ ...dshLaunch.nodeArgs, "--profile", profile,
        ...patches.flatMap(p => ["--patch", p]) ],
cwd: options.processCwd === undefined ? undefined : resolve(callerCwd, options.processCwd),
environment: () => ({ ...options.env ?? process.env, ...dshLaunch.environment,
                      ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }) })
```

即：**`--profile` 在最前，`--patch` 按数组顺序跟在后面**；argv 之后的第一个不可识别 token
才属于应用参数（`dsh/lib/types/args.d.ts:1-16`）。

### 8.3 建议的启动序列

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const harness = new DeepSeekHarness({
  dshBin: 'E:/Code/OceansLabWeb/dsh_oceanslab/node_modules/@deepseek-ai/dsh/lib/bin.js',
  profile: 'biz-agent',
  dshHome: `E:/runtime/${agentId}`,                 // 隔离 home（每个 agent 一份）
  patches: [`E:/runtime/${agentId}/agent.patch.yml`], // per-agent 覆盖层
  processCwd: `E:/workspaces/${agentId}`,           // dsh 进程 cwd（sandbox-policy.workspaceRoot 用 process.cwd()）
  cwd: `E:/workspaces/${agentId}`,                  // 会话 workspace
  env: {
    ...process.env,
    DSH_HOME: `E:/runtime/${agentId}`,
    DSH_AGENTS_HOME: `E:/runtime/${agentId}/agents`, // 切断开发者共享 skills / AGENTS.md
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    // 不设 DSH_SYSTEM_PROMPT：人格由 patch 写死
  },
  provider: 'deepseek-official',
  model: 'deepseek-flash',
})
```

要点：

1. **`processCwd` 与 `cwd` 都要给**：`processCwd` 决定 `sandbox-policy.workspaceRoot: !!js process.cwd()`
   与相对路径解析；`cwd` 决定会话归属与 `working-directory` 的初始值。
2. **`DSH_HOME` 与 `dshHome` 双写**：`dshHome` 会被客户端写进环境，但显式 `env` 里再写一次
   可以避免"`env` 整体替换"语义把它覆盖掉。
3. **`patches` 必须绝对路径**（或相对 `callerCwd`），因为覆盖层里的相对插件路径还要再相对
   **覆盖层文件自己的目录**解析。
4. 会话续接走协议 `session/resume { sessionId }`，前提是**同一个 `DSH_HOME` + 同一个
   `sessions` 根**（`sdk-jsonrpc-server/README.md:28`：缺失/不可读/不兼容 → 直接拒绝，不新建替代会话）。

---

## 9. Gotchas

| # | 坑 | 说明 / 对策 |
|---|---|---|
| **G1** | **启动成功 ≠ 工具齐全** | app-boot 对 entries 采用"可选"策略：导入失败的插件只打印 `dsh: warning: N entries did not activate`，**退出码仍为 0**（实测）。网关必须做启动后自检：`initialize` 后核对期望的工具名集合，或看 stderr 是否含 `did not activate` |
| **G2** | 定向 patch 的 `config` **整块替换** | 只写 `personaPrefix` 会清掉 `includeHarnessIdentity`/`includeRuntimeContext`（base→sdk-app 就是这样丢的，实测）。**任何 `config` 都要写全** |
| **G3** | 没有 `remove` | 只能用 `disabled: true`。恢复要显式写 `disabled: false`（逐键覆盖，省略不等于恢复默认） |
| **G4** | 定向 patch 里的 `name` 是断言 | 写错 → `patch: name mismatch for "X" ... skipping`，静默跳过。想换实现只能 `disabled` 旧行 + `insert` 新行，**不能改 `name`** |
| **G5** | 打不中 id 只是 warning | 拼错 id 会让"我以为关掉了 shell"变成空操作。**部署后必须 dump 校验** |
| **G6** | `sdk-minimal` 的 `filesystem` 是 **`dsh-fs-local`（非沙箱）**，`sandbox-policy` 管不住它 | `dsh-fs-local/README.md`："`config.cwd` is a resolution default, **not a containment boundary**: absolute paths and `..` escape it"。所以 `read_image: true` 可读任意绝对路径。**两种解法**：①`tool-fs` 里 `readImage: false`（最省事）；②把后端换成沙箱版——`- id: filesystem, disabled: true` + `insert` 一个 `- id: fs-sandbox, name: '@deepseek-ai/dsh-fs-sandbox'`（**已验证可 boot**，见 §7.7）。注意 patch **不能改已有行的 `name`**，只能 disable + insert |
| **G7** | `terminal-pwsh` 的 `name` 是 `@deepseek-ai/dsh-terminal-bash` | 随包就这样（`shellDialect: pwsh` 区分）。别以为是笔误去"修正"它——改成 `dsh-tool-pwsh-persistent` 之类的包会直接导入失败 |
| **G8** | `cordis.yml` 不能手写 | 每次启动被重写为空根；写进去的行会被当成补丁在下次启动重复插入（`profile-boot.d.ts:47-54`） |
| **G9** | `--from-default-profile` 会**替换** profile | 会删掉旧目录（含 `node_modules` 与用户 patch）。只用于首次物化 |
| **G10** | `!!js` 在 `--dump-config` 里**不求值** | dump 只是原样打印表达式（如 `personaPrefix: !!js process.env.DSH_SYSTEM_PROMPT ?? '…'`）。**不能靠 dump 判断实际人格**，要看真实请求/日志 |
| **G11** | `$DSH_AGENTS_HOME` 是**进程级**策略 | `agent-instructions` 的行配置里写 `dshHome`/`agentsHome` 会被**忽略**（`README.md:40`）。必须靠 `env` |
| **G12** | 共享一个 `$DSH_HOME` = 共享一切 | 会话、投影缓存、附件、`AGENTS.md`、`.credentials.yaml`、`.anonymous-user-id` 全在同一个根下。**一个 agent 一个 home** |
| **G13** | profile bundle 解析**安装锚点优先** | `resolveBundleDir()` 先查 dsh 安装目录，再查 profile 的 `node_modules`（`profile.d.ts:222-234`）。想在 profile 里覆盖 `@deepseek-ai/dsh-base` 这类内置 bundle 是**无效**的——它永远来自安装 |
| **G14** | 一个 `mcp-client` 条目 = 一个 server | 不是"一个数组里的 server 列表"。`serverName` 重复 → 后者加载失败 |
| **G15** | MCP 的 `transport` 只有两个值 | `stdio` / `streamable-http`。**没有** `sse`、`http`（写错会被 schema 拒绝） |
| **G16** | `env` 是**整体替换** | `HarnessClientOptions.env` 传对象时**完全替换**父进程环境，不是合并。凭据、PATH、`DSH_*` 全都要自己带上 |
| **G17** | `failOnStartupError` 默认 `false` | 生产建议 `true`，否则 MCP 连不上时 agent 会"安静地没有工具" |
| **G18** | patch 里的相对插件路径**双重相对** | 先相对 `callerCwd` 定位覆盖层文件，再相对**该文件所在目录**定位插件。跨目录部署时最容易算错，建议全部写绝对路径 |
| **G19** | **`insert` 的书写顺序 ≠ 插件加载/生效顺序** | `dsh-base/cordis.patch.yml:11-13`："Row order carries no load semantics (**activation is service-availability driven**); the grouping is for readers." 想靠"把 policy 行写在 tools 行前面"保证守卫先就位是**无效**的。正确做法：policy 插件在自己的 `apply()` 里注册一个 **monotonic guard**（`ctx.tools.guard()`）或 `tools/pre-execute` 监听——它们在**每次调用**时生效，与注册先后无关 |
| **G20** | 工具名全局唯一，重复注册会让**整个条目**激活失败 | 实测错误：`Error: tool "X" is already registered (for a per-agent variant, register through that agent's `agent.ctx` instead)`，同时 `dsh: warning: 2 entries did not activate`、**exit 0**。多个自有插件共用工具名、或与 MCP 工具重名时都会这样，而且是静默降级 |
| **G21** | 想"默认拒绝未授权工具"时，不要只靠 `tools.restrict` | `restrict` 需要**精确工具名**、无通配，MCP 工具名在发现前不可知。更稳的是在 `tools/pre-execute` 里做 **default-deny**（拿得到完整 `exec.name`，对任何动态名字都成立），或直接不 insert 对应条目 |

---

## 10. 未解决 / 需后续验证

| 项 | 状态 | 说明 |
|---|---|---|
| ~~把 `filesystem` 从 `dsh-fs-local` 换成 `dsh-fs-sandbox`~~ | ✅ **已验证**（见 §7.7） | `- id: filesystem, disabled: true` + `insert` 一个 `fs-sandbox` 行即可；实测 boot `exit=0` 无 warning |
| 删除 `subprocess` / `jobs` 是否安全 | **`未验证`** | 两者不注册模型可见工具，但 `sandbox`/`compaction`/MCP stdio 探活可能软依赖；本次未做删除后启动验证 |
| 停用 `mcp-resources` 是否有硬依赖 | **`未验证`** | 未测试 |
| ~~`sandbox-policy` 能否在 sdk-minimal 之上改成 `read-only`~~ | ✅ **已验证**（见 §7.7） | 接受 `mode: read-only`，树正常 boot |
| ~~`mcp-client` 能否用裸包名从 profile 解析~~ | ✅ **已验证**（见 §7.7） | 裸包名 `@deepseek-ai/dsh-mcp-client` 解析并真实连接 |
| ~~停用 `session-log-deepseek` / `tool-fs` 是否安全~~ | ✅ **已验证**（见 §7.7） | 整树 boot `exit=0` 无 warning |
| 让系统提示词**只有**我们的文本（`complete: true`） | **`未验证`** | `dsh-system-prompt.config` 没有 `complete` 键；需要 `dsh-persona`（scope-only）或 agent preset scope 注册，本次未启动验证 |
| MCP 精确工具白名单（`tools.restrict`）在动态发现下如何稳定 | **`未验证`** | `restrict` 只吃精确名，需要配合 `tools/change` 重算；无通配 |
| `terminal-pwsh` 行使用 `dsh-terminal-bash` 包是否为上游有意设计 | **`未验证`** | 随包如此；未在上游 issue/源码确认意图 |
| 本机安装树的 hoisted 依赖完整性 | **环境问题** | 实测出现过 `yaml` / `diff` / `js-yaml` / `semver` 缺失导致插件静默不激活；属安装侧问题，与 profile 组合无关 |

---

## 11. 实际读过的来源

全部为 `0.2.1-rc.3`（除标注外）。解包根：
`E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\pkgs\`；npm 安装字节相同，另存于
`E:\Code\OceansLabWeb\dsh_oceanslab\node_modules\@deepseek-ai\`。

| 包 | 版本 | 读过的文件 | 用途 |
|---|---|---|---|
| `@deepseek-ai/dsh` | 0.2.1-rc.3 | `README.zh.md`；`lib/types/args.d.ts`、`profile-boot.d.ts`、`dump-config.d.ts`、`dump-config-schema.d.ts`、`plugin.d.ts` | Q1 层顺序、CLI 形态、dump 语义 |
| `@deepseek-ai/dsh-app-boot` | 0.2.1-rc.3 | `lib/index.js`（`PROFILE_TEMPLATES:551-557`、`initProfile()`、`PROFILE_PATCH_TEMPLATE`、`anchorInsertedPluginNames()`、`parsePatchList()`）；`lib/types/profile.d.ts`；`README.md` | profile 形态、模板、路径规范化、bundle 解析锚点 |
| `@deepseek-ai/dsh-base` | 0.2.1-rc.3 | `cordis.patch.yml`（529 行全文） | Q2 `sdk` 的组合内容、能力归属 |
| `@deepseek-ai/dsh-sdk-app` | 0.2.1-rc.3 | `cordis.patch.yml`；`README.md` | Q2 `sdk` app 层 |
| `@deepseek-ai/dsh-sdk-minimal` | 0.2.1-rc.3 | `cordis.patch.yml`（172 行全文）；`README.md`；`package.json` | **Q3 起点**、Q2 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.10 | `src/index.ts`（`applyEntryPatches()`、`PatchOptions`、`entryListSchema`）；`README.md` | **Q1 patch 语法权威** |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.6 | `src/index.ts`（`unwrapExports():200-209`）；`src/config/tree.ts`（`import():111-129`）；`lib/types/config/entry.d.ts` | Q1 `EntryOptions`、导出归一化、模块解析 |
| `@deepseek-ai/dsh-tools` | 0.2.1-rc.3 | `lib/types/index.d.ts`（`Config.mode`、`ToolRestriction`、`ToolDefinition`）；`README.md`（式样 §"Register a tool"、`mode` 表） | Q2 呈现模式、Q3 自有工具、Q5 限制 |
| `@deepseek-ai/dsh-mcp-client` | 0.2.1-rc.3 | `lib/types/index.d.ts`（`StdioConfig`/`StreamableHttpConfig`/`Config`）；`lib/types/transport.d.ts`；`README.md` | Q5 |
| `@deepseek-ai/dsh-mcp-resources` | 0.2.1-rc.3 | `package.json`；`lib/types/index.d.ts` | Q2 MCP 资源侧 |
| `@deepseek-ai/dsh-system-prompt` | 0.2.1-rc.3 | `lib/types/index.d.ts`（`Config`、`SECTION_ORDERS`、`renderPrompt`） | Q4 |
| `@deepseek-ai/dsh-persona` | 0.2.1-rc.3 | `lib/types/index.d.ts`（scope-only 约束、`Config.complete`） | Q4 |
| `@deepseek-ai/dsh-agent-instructions` | 0.2.1-rc.3 | `lib/types/config.d.ts`、`lib/types/index.d.ts`、`README.md:12,30-40,64-73` | Q4 关闭 AGENTS.md |
| `@deepseek-ai/dsh-agent-preset` | 0.2.1-rc.3 | `lib/types/index.d.ts`；`README.md` | Q5 preset 形态 |
| `@deepseek-ai/dsh-agent-preset-registry` | 0.2.1-rc.3 | `lib/types/definition.d.ts`（`PresetDefinition`） | Q5 |
| `@deepseek-ai/dsh-home-paths` | 0.2.1-rc.3 | `lib/types/index.d.ts`（`resolveDshHome`/`resolveAgentsHome`/`dshHomePath`） | Q6 |
| `@deepseek-ai/dsh-sdk-client` | 0.2.1-rc.3 | `lib/types/types.d.ts`（`HarnessClientOptions`/`DeepSeekHarnessOptions`）、`lib/types/launch.d.ts`、`lib/index.js`（`resolveDshLaunch():160-195`） | §8 gateway 参数 |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | 0.2.1-rc.3 | `README.md:12,28-36,52` | Q6 resume、`initialize` 语义 |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.2.1-rc.3 | `lib/types/index.d.ts`（`Config.root` / `compression`） | Q2/Q6 持久化 |
| `@deepseek-ai/dsh-fs-local` | 0.2.1-rc.3 | `README.md`（"`config.cwd` is not a sandbox"） | G6 |
| `@deepseek-ai/dsh-sandbox-policy` | 0.2.1-rc.3 | `lib/types/index.d.ts:34-41`（`Config.mode` 默认 `read-only`、`SandboxMode`） | §7.7 `read-only` 合法性 |
| `runtime/templates/studio/cordis.patch.yml` | 仓库内（非 npm） | 全文 69 行 | §3.6 / §7.7 实际模板评审 |

运行时验证环境：`node v24.21.0`；CLI
`E:\Code\OceansLabWeb\dsh_oceanslab\node_modules\@deepseek-ai\dsh\lib\bin.js`（`--version` = `0.2.1-rc.3`）；
scratch home 位于 `E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-test`、
`.tmp\home-min`、`.tmp\home-fsb`、`.tmp\home-studio`、`.tmp\home-mcp`；dump/schema 产物在 `.tmp\out\`。
**未读取、未引用开发者真实 home（`%USERPROFILE%\.dsh`）的任何内容。**

