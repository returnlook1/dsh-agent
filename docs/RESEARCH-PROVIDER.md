# DSH 0.2.1-rc.3 — Provider 路由、凭据解析与离线测试研究报告

> 目标读者：网关（gateway）实现者。目的：为**每个受限 runtime** 物化独立 `$DSH_HOME` 与独立模型凭据，并让 CI 能在**无网络、无凭据**下跑通一次真实 agent 回合。
>
> 所有 `@deepseek-ai/*` 包版本均为 **`0.2.1-rc.3`**（npm dist-tag `next`，已用 `npm view @deepseek-ai/<pkg> dist-tags.next` 逐包核对）。
>
> 本文件只描述机制、文件名与键名，**不含任何真实凭据值**；开发者的 `C:\Users\retur\.dsh\.credentials.yaml` 未被读取。

---

## 结论

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | provider/model 在 `initialize` 时如何注册与校验 | SDK 侧 `initialize` 只做两步：① 查 adapter 是否已注册，否则**只有 `deepseek-official` 会自动兜底挂载 DeepSeek adapter，其他 provider 直接失败**，错误文本 `no adapter registered for provider "<provider>"`（普通 `Error`，无 code）；② 调 `ctx.llm.resolveCallConfig({provider,model,reasoningEffort?,maxTokens?})`，由 adapter 解析 exact model 并校验 reasoning effort（`UNSUPPORTED_REASONING_EFFORT`）。**model id 不做白名单校验**：不在目录里的 id 原样透传（DeepSeek 路由） | `.../dsh-sdk-jsonrpc-server/lib/index.js:120-147`；`.../dsh-llm/lib/index.js:2174-2207,2262-2266` |
| 1b | 出厂自带哪些 provider id / model | 出厂**两个**路由：`deepseek-official`（API key，内建目录 `deepseek-flash`、`deepseek-v4-pro`）与 `deepseek-account`（账号 token `x-dsh-auth-token`，目录只来自账号 `/models` listing）。`llm-pi-ai` 以**零路由**睡眠挂载。base 的默认模型是 `provider: deepseek-official, model: deepseek-flash` | `.../dsh-llm-deepseek/lib/index.js:19-31`；`.../dsh-llm-deepseek-account/lib/index.js`（`PROVIDER = "deepseek-account"`）；`.../dsh-base/cordis.patch.yml`（`agent-default-model`、`llm-pi-ai` 行） |
| 1c | 如何加第三方 OpenAI 兼容 provider | 用 `llm-pi-ai` 的 `config.providers.<route>`：`api: openai-completions` + `baseURL` + `apiKeyEnv` + `models[]`（可加 `compat`）。这是**纯配置**路径，无需写代码 | `.../dsh-llm-pi-ai/README.md`（示例 `acme-gateway`）；`.../dsh-base/cordis.patch.yml` |
| 2 | 凭据解析顺序 | **托管文件 > 启动环境 > `<cwd>/.env` > `$DSH_HOME/.env`**，先命中者胜。**没有 OS keychain**（明确列为 deferred）。文件：`$DSH_HOME/.credentials.yaml`，顶层 `version: 1`、`refs:`（按环境变量名）、`records:`（按 `<owner>/<id>`）。Key 变量名默认 `DEEPSEEK_API_KEY` | `.../dsh-credentials-local/README.md`（"Where keys come from" 表）；`.../dsh-llm-deepseek-api-key/lib/index.js:12,53-64` |
| 2b | 受限 runtime 如何拥有独立凭据 | 三点缺一不可：① `DSH_HOME=<per-runtime 目录>`（覆盖 `~/.dsh`）；② 该 home 内**放自己的** `.credentials.yaml`（或干脆不放，走环境变量——**别两者都放**）；③ 用 `--profile sdk` 时注意 env 只是"文件为空时的兜底"，用 `--profile headless` 时凭据存储根本不挂载。绝不触碰开发者 home。落地步骤见 §2.5 | `.../dsh-credentials-local/README.md`；`.../dsh-home-paths/README.md`（`resolveDshHome`）；`.../dsh-headless/cordis.patch.yml`（`credentials/authorization/deepseek-account` 三行 `disabled: true`）；`.../dsh-sdk-minimal/cordis.patch.yml`（无 credentials 行） |
| 3 | 每 agent 的 `temperature` / 输出上限 | **`temperature` 在本版本没有任何配置键**（provider 插件 Config、`agents[]`、settings 全都没有）。`maxOutputTokens` **有**：`agents[].maxTokens`、SDK `initialize.maxTokens`、adapter `config.maxTokens`。最近的可支持控制点：**写一个 `agent/request` waterfall 插件**返回 `{...config, temperature}`（官方 `dsh-agent` 的 model-selection 就是这么写的） | `.../dsh-llm-deepseek/lib/types/config.d.ts`（无 temperature）；`.../dsh-agent-loop/README.md` 字段表；`.../dsh-agent/lib/types/model-selection.js:61-75`；`.../dsh-agent/lib/types/runtime-types.d.ts:327-332` |
| 4 | 离线/确定性测试 | `dsh-llm-mock-server` **不是插件**，是一个**进程内 Messages HTTP/SSE 服务**：`startMockLlmServer({sequence:['success'],repeatLast:true,successText:'…'})` → 返回 `baseURL`（无 `/v1`）。把 `DEEPSEEK_BASE_URL=<baseURL>/v1` 指向它即可，真实 adapter + 真实 loop 全程本地。`dsh-llm-replay` 是插件，但需要**录制的 session fixture**，CI 从零起步用不上 | `.../dsh-llm-mock-server/README.md`、`.../dsh-llm-mock-server/lib/types/index.d.ts`；`.../dsh-llm-replay/README.md` |
| 4b | 依赖坑 | `dsh-llm-mock-server` / `dsh-llm-replay` / `dsh-sdk-client` 是 `@deepseek-ai/dsh` 的 **devDependencies**，`npm i @deepseek-ai/dsh` **不会**装它们，必须自己显式加同名同版本 | `.../dsh/package.json`（devDependencies 段） |
| 5 | 全新 `$DSH_HOME` 最少需要什么 | **不需要 settings 文件**。`settings.yaml` 只是旧版本一次性导入（导完改名为 `settings.yaml.imported`）；setting 真实落点是 profile 的 `cordis.patch.yml`。`sdk`/`sdk-minimal`/`headless`/`web`/`acp` profile 首次使用会自动从随包模板初始化。**唯一硬坑**：`cordis.patch.yml` 若是空文件/只有注释会 **boot 失败**，要停用该层必须写 `[]` | `.../dsh-settings/README.md`；`.../dsh/README.md`（Entry modes）；`.../dsh-app-boot/README.md`（"Your machine-local preferences" 段） |
| 6 | 实测 | 见 [§6 实测记录](#6-实测记录)。`dsh --version` / `--help` / `--dump-config` 与 mock 冒烟均按下方命令复核 | 本文件 §6 |

---

## 1. Provider / model 路由

### 1.1 运行时里的层次

```
SDK client (stdio JSON-RPC)
   │  initialize { cwd, provider, model, reasoningEffort?, maxTokens? }
   ▼
dsh-sdk-jsonrpc-server        ← 校验路由；只有 deepseek-official 兜底挂载 adapter
   ▼  ctx.llm.resolveCallConfig({provider,model,…})
dsh-llm (LlmRuntime)          ← adapter 注册表 + 可配置 provider 目录 + catalog 解析
   ▼  ctx.llm.stream(options)
provider adapter              ← deepseek-official / deepseek-account / llm-pi-ai 的每个 route
   ▼  HTTPS
供应商 / 网关
```

- `LlmRuntime` 本身**没有任何配置**，它只是注册表（`.../dsh-llm/README.md: "the service itself has no configuration and no provider wire code"`）。
- adapter 通过 `registerConfigurableProviders([...])` 向"可配置 provider 目录"登记 `provider`、`displayName`、`settingsNs`、`settingsPath`；GUI/配置面据此生成表单。`settingsNs` = 该行 Cordis entry 的 id（`.../dsh-llm-deepseek-api-key/lib/index.js:111-116`：`settingsNs: ctx.fiber.entry?.options.id ?? "llm-deepseek-api-key"`）。

### 1.2 `initialize` 的精确行为

`.../dsh-sdk-jsonrpc-server/lib/index.js:120-147`：

```js
async initialize(params) {
  // reasoningEffort 必须是非空字符串，maxTokens 必须是正整数（否则 TypeError）
  if (!this.hasAdapterFor(provider)) {
    if (provider !== "deepseek-official") throw new Error(`no adapter registered for provider "${provider}"`);
    this.llmFiber = await this.ctx.plugin(LlmDeepSeek);   // 兜底
  }
  await this.ctx.get("llm").resolveCallConfig({ provider, model, …reasoningEffort, …maxTokens });
  this.initialized = true;
  return { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } };
}
```

**未知 provider 的精确错误**：

| 位置 | 文本 | 类型/code |
|---|---|---|
| `initialize` 拒绝 | `no adapter registered for provider "<provider>"` | 普通 `Error`（**没有 code**） |
| `LlmRuntime` 内部（loop / `stream()`） | `no adapter registered for provider "<provider>"` | `LlmError`，`code = "NO_ADAPTER"` |
| 重复注册同一路由 | `an adapter for provider "<provider>" is already registered` | `LlmError`，`code = "DUPLICATE_ADAPTER"` |
| reasoning effort 不被该模型支持 | `provider "<p>" model "<m>" does not support reasoning effort "<e>"` | `LlmError`，`code = "UNSUPPORTED_REASONING_EFFORT"` |

来源：`.../dsh-sdk-jsonrpc-server/lib/index.js:128`、`.../dsh-llm/lib/index.js:1872,2191,2195,2264`、`.../dsh-llm/lib/types/error.d.ts`。

**关于 model id 的校验强度**（很重要，别指望它挡错）：

- `resolveCallConfig` 只做两件事：省略 `maxTokens` 时materialize adapter 的默认输出上限；把 `reasoningEffort` 与 exact model 的 efforts 集合比对。**它完全不校验 model id 是否存在、也不校验 `temperature`**（`.../dsh-llm/lib/index.js:2182-2207`）。
- DeepSeek 路由的 design 就是"未列出的 id 原样透传"：`model ids the listing does not name pass through unchanged`（`.../dsh-llm-deepseek-api-key/README.md`）。
- 唯一会在**网络 I/O 之前**被拒的 model 情形：模型出现在官方 listing 里、但当前客户端版本服务不了 → `CLIENT_UPGRADE_REQUIRED` / `MODEL_UNSUPPORTED`（`.../dsh-llm-deepseek/lib/index.js:2737-2738`）。

> 结论：**网关必须自己做 provider/model 白名单**。Runtime 只保证 "provider 有 adapter"，不保证 model 合法。
> **已实测**：`initialize { provider: 'deepseek-official', model: 'totally-made-up-model' }` **成功返回 `serverInfo`**（见 §6.3），即不存在"未知 model 导致握手失败"这层保护。

### 1.3 出厂路由

| provider id | 由谁注册 | 凭据头 | 模型目录 |
|---|---|---|---|
| `deepseek-official` | `@deepseek-ai/dsh-llm-deepseek-api-key`（base 行 id `llm-deepseek`） | `x-api-key`（值来自 `apiKeyEnv` 引用的凭据） | 内建 `deepseek-flash`、`deepseek-v4-pro`；当 baseURL 是官方 origin 且目录未被改写时，改为跟随官方 `GET https://api.deepseek.com/models` listing |
| `deepseek-account` | `@deepseek-ai/dsh-llm-deepseek-account`（base 行 id `llm-deepseek-account`） | `x-dsh-auth-token`（来自 `ctx.deepseekAccount`） | 只来自账号 `/models`；`models` 字段**已不可配置**，只能 `modelOverrides.<id>` |
| （无） | `@deepseek-ai/dsh-llm-pi-ai`（base 行 id `llm-pi-ai`） | 每个 route 的 `apiKeyEnv` | **睡眠**：`providers` 为空时零路由、零选择项 |

证据：`.../dsh-llm-deepseek/lib/index.js:19-31`（`DEFAULT_MODELS`）、`.../dsh-llm-deepseek-api-key/lib/index.js:47`（`PROVIDER = "deepseek-official"`）、`.../dsh-llm-deepseek-account/lib/index.js`（`PROVIDER = "deepseek-account"`、`TOKEN_HEADER = "x-dsh-auth-token"`）、`.../dsh-base/cordis.patch.yml`。

base 的默认模型（`.../dsh-base/cordis.patch.yml`）：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
```

> 注意 `deepseek-flash` 是**内建目录**里的 id；`dsh-llm` README 里的示例写的是 `deepseek-v4-flash`（另一个 id），两者都在内建目录/listing 的合并结果中，实际请求前请以 `--dump-config` 后的 catalog 为准。

### 1.4 加一个第三方 OpenAI 兼容 provider（纯配置）

`llm-pi-ai` 的 `providers` 字典是全部配置面：**键就是请求里 `provider` 的值**（`.../dsh-llm-pi-ai/README.md`）。

```yaml
# 放在 $DSH_HOME/profiles/<name>/cordis.patch.yml（或 $DSH_HOME/cordis.patch.yml，或 --patch 覆盖层）
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY     # 凭据引用，per-request 解析；绝不把密钥写进配置
        api: openai-completions             # 目录里没有该路由时必须显式声明协议
        baseURL: https://gateway.acme.example/v1
        compat:
          thinkingFormat: deepseek
        models:
          - id: acme-think
            name: Acme Think
            contextWindow: 262144
            reasoningEfforts:
              off:
              high: high
```

字段语义（`.../dsh-llm-pi-ai/README.md` 表格）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | 缺省 | 凭据引用，per-request 解析；缺省则交给 pi-ai 的 ambient discovery |
| `api` | catalog 协议 | `openai-completions` / `openai-responses` / `anthropic-messages`；目录未描述的路由**必须**给 |
| `baseURL` | catalog endpoint | 该路由所有模型的端点 |
| `models` | 已安装 catalog | **整体替换**该路由目录 |
| `modelOverrides` | 无 | 只改个别模型；与 `models` 同时设会被拒 |
| `compat` | 自动探测 | 兼容开关（system prompt 走哪个 role、输出上限字段、thinking 字段等） |
| `defaultContextWindow` | `262,144` | 未描述模型的容量兜底 |
| `defaultMaxTokens` | `32,768` | 未描述模型的输出上限兜底 |
| `retryPolicy` | normal / 5 次 | 由 `dsh-llm-retry` 执行 |

失败码（同 README）：`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`UNKNOWN_MODEL`、`UNSUPPORTED_OPTION`（`stop` 被拒）。

**无凭据的本地 server 注意**：pi-ai 的 OpenAI 兼容实现仍要求 key 或 `Authorization` 头，纯 keyless 本地服务需要一个占位 key（`.../dsh-llm-pi-ai/README.md` Known Limitations）。

---

## 2. 凭据：解析顺序、文件名/键名、受限 runtime 的隔离做法

### 2.1 精确解析顺序（先命中者胜）

来源：`.../dsh-credentials-local/README.md` 的 "Where keys come from" 表 + `.../dsh-llm-deepseek-api-key/lib/index.js:53-64`。

| 顺序 | 层 | 位置 | 谁能写 | 备注 |
|---|---|---|---|---|
| 1 | **托管凭据文件** | `$DSH_HOME/.credentials.yaml`（可用 `config.path` 改成任意绝对路径） | `set`/`unset`、GUI Models 页 | **永不被 materialize 进 `process.env`** |
| 2 | **启动环境** | `DEEPSEEK_API_KEY=… dsh`（继承的 process env 快照） | 部署方 | 启动时快照；启动后再 export 无效 |
| 3 | **项目 `.env`** | `<invocation cwd>/.env` | 仓库 | 代理变量（`HTTP_PROXY` 等）**不接受**来自此层 |
| 4 | **home `.env`** | `$DSH_HOME/.env` | 用户机器 | 是本顺序里最弱的一层 |

- `DSH_HOME` 解析：显式配置 > `$DSH_HOME` > `~/.dsh`；空白值视为未设置（`.../dsh-home-paths/README.md`）。
- 环境层是**启动快照**（`@deepseek-ai/dsh-launch-environment`），不是实时的 `process.env`；且 **每一层仍会被复制进 `process.env`**，所以它"快照"但不"隔离子进程"。
- **OS keychain 不存在**。`.../dsh-credentials-local/README.md` Known Limitations：`an OS-keychain provider is deferred`；Dev Note 明确 "none is shipped"。

### 2.2 `.credentials.yaml` 文档结构

```yaml
version: 1

refs:                                  # 按环境变量名存裸值
  DEEPSEEK_API_KEY: <secret>
  OPENAI_API_KEY: <secret>

records:                               # 按 <owner>/<id> 存插件凭据
  llm-pi-ai/openai-codex:
    kind: grant
    payload: { type: oauth, access: …, refresh: …, expires: 1786000000000 }
  llm-pi-ai/amazon-bedrock:
    kind: api-key
    env: { AWS_PROFILE: prod }
```

规则（同 README）：空值被拒（删 key 才叫"没有"）；未知顶层键保留在磁盘但被忽略并告警；非 mapping 根、类型错误、未知 record tag、重复键、坏 YAML 在**启动时直接失败**，热重载则保留上一份好快照并告警；POSIX 上若其他用户可读则拒绝加载（要求 `chmod 600`），Windows 跳过该检查。

### 2.3 相关代码事实

`.../dsh-llm-deepseek-api-key/lib/index.js`：

```js
const PROVIDER = "deepseek-official";
const Config = z.object({
  ...deepSeekConfigFields,
  ...modelListingConfigFields,
  apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY").volatile(),
});
// 解析：先 credentials 服务，没有该服务才读启动环境
const credentials = ctx.get("credentials");
if (credentials !== undefined) {
  const hit = await credentials.resolve(ref);
  if (hit !== undefined) return assertUsableApiKey(hit.value, "llm-deepseek", ref);
} else {
  const ambient = launchEnvironmentOf(ctx).get(ref);
  if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-deepseek", ref);
}
throw new LlmError(`llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
```

> 注意这段逻辑的含义：**只要 composition 挂载了 `credentials` 服务，环境变量就只是"托管文件为空时的兜底"，而不是覆盖。**

### 2.4 推荐：受限 runtime 的 home 与凭据（不碰开发者 home）

**第一步：每个 runtime 一个 home**

```powershell
$env:DSH_HOME = 'E:\…\.tmp\runtimes\<runtime-id>'    # 或进程启动时传 env
```

`dsh-home-paths` 的 `resolveDshHome()` 顺序是 显式配置 > `$DSH_HOME` > `~/.dsh`，所以设了 `DSH_HOME` 就**不会**再读 `C:\Users\retur\.dsh` 下任何东西（`.credentials.yaml`、`.env`、`sessions/`、`storages/`、`profiles/` 全部落在新 home）。

**第二步：选 profile，决定凭据走哪条路**

| 启动方式 | 是否挂载托管凭据库 | 生效的凭据来源 | 适合 |
|---|---|---|---|
| `--profile sdk` | **是**（base 默认） | 文件 > 环境 > cwd/.env > home/.env | **受限 agent 首选**：base 的 `sandbox-policy.mode` 默认 `workspace-write` + approval `ask` |
| `--profile sdk-minimal` | **否** | 只用启动环境（`apiKeyEnv: DEEPSEEK_API_KEY` 写死在 bundle 里） | 树最小，但**它的 `sandbox-policy.mode` 被写死成 `danger-full-access`**，见下方警告 |
| `--profile headless` | **否**（`credentials`/`authorization`/`deepseek-account` 三行被 `disabled: true`） | 启动环境 > cwd/.env > home/.env | CI 冒烟 / 一次性任务 |

证据：`.../dsh-sdk-minimal/cordis.patch.yml`（完整树，无 `credentials`/`settings`/`authorization` 行，`llm-deepseek` 行写死 `apiKeyEnv: DEEPSEEK_API_KEY`，且 `sandbox-policy.config.mode: danger-full-access`）；`.../dsh-headless/cordis.patch.yml`（末尾三行 `disabled: true`，注释 "One-shot jobs use launch-time credentials instead of the interactive store."）；`.../dsh-headless/README.md` §Credentials；`.../dsh-base/cordis.patch.yml`（`sandbox-policy.config.mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`）。

> ⚠️ **`sdk-minimal` 不适合"受限"场景**：它的 bundle 把沙箱模式钉死为 `danger-full-access`（README 自述 "Its danger-full-access policy lets the shell modify any path available to the process"），而且 `tool-fs` 的 `read/write/edit` 全为 `false`（只有 shell）。要既小又受限，应该用 `sdk` profile + patch 收窄，或自己写 bundle。

**第三步（二选一）**

- **A. 环境变量路径（推荐，最简单）**

  ```powershell
  $env:DEEPSEEK_API_KEY = '<key>'
  node node_modules\@deepseek-ai\dsh\lib\bin.js --profile sdk-minimal
  ```

  生效条件：该 composition **没有** `credentials` 服务（sdk-minimal / headless 天然满足）。用 `sdk` profile 时必须确认该 home 内**没有** `.credentials.yaml`，否则文件优先。

- **B. 托管文件路径（更硬的隔离）**

  在**该 runtime 自己的 home** 里写 `.credentials.yaml`：

  ```yaml
  version: 1
  refs:
    DEEPSEEK_API_KEY: <key>
  ```

  并且**不要**把 key 放进环境变量。更好的做法是用 `credentials` 行的 `config.path` 把它指到 home 之外的一个 600 权限文件（`.../dsh-credentials-local/README.md` 配置表：`path` 默认 `<harness home>/.credentials.yaml`，`dshHome` 默认 `$DSH_HOME` 或 `~/.dsh`）。

**两条路的真实安全差异（必须知道）**

| 机制 | 是否进 `process.env` | agent 的 shell 工具能否直接读到 | 证据 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` 环境变量 | **是** | **能**（`env` / `Get-ChildItem env:` 直接打印） | `.../dsh-launch-environment/README.md`："every layer is still copied into `process.env`, so it does not isolate subprocesses" |
| `.credentials.yaml` | **否** | 需要主动去读那个路径（且产品从不把路径交给 agent） | `.../dsh-base/cordis.patch.yml` 注释："the Models page writes only the managed document, which is never materialized into the process environment" |

> 因此：**若 agent 拥有 shell 工具（sdk/sdk-minimal/headless 都有），环境变量里的 key 对它不是秘密。** 需要"agent 拿不到 key"时只有两条路：① 用 B 路径 + 不给 shell 工具；② 在网关侧做代理，runtime 只拿一个受限 token（本版本没有这种东西，属于自建）。

### 2.5 推荐部署配方（网关侧 6 步）

```
<runtimes-root>\
  <runtime-id>\
    home\                      ← DSH_HOME（每 runtime 一个，互不可见）
    workspace\                 ← 该 runtime 的 cwd / 写入沙箱根
    patch\                     ← 网关生成的 patch overlay
```

1. **建目录**：`home/`、`workspace/`、`patch/` 三个目录，权限按 OS 收紧（POSIX 上 `.credentials.yaml` 必须 600，否则 boot 报错要求 `chmod 600`）。
2. **选 profile**：受限 agent 用 **`sdk`**（base 的 `sandbox-policy.mode` 默认 `workspace-write`），不要用 `sdk-minimal`（钉死 `danger-full-access`）。
3. **喂凭据**（二选一，**别同时用**）：
   - 环境变量：子进程 `env` 里只放 `DEEPSEEK_API_KEY`（+ `DSH_HOME`、`PATH` 等必需项），并**保证 `home\` 内不存在 `.credentials.yaml`**，否则文件优先、env 无效；
   - 托管文件：写 `home\.credentials.yaml`（`version: 1` / `refs.DEEPSEEK_API_KEY`），**不放 env**。更硬一点：把 `credentials` 行的 `config.path` 指到 `runtimes\<id>\credential.yaml`（workspace 之外、agent 的沙箱读不到）。
4. **生成 patch overlay**（每次启动传 `--patch`，不写进 profile，避免互相污染）：
   ```yaml
   # <runtimes-root>/<id>/patch/runtime.yml   （注意：必须是 YAML 数组）
   - id: llm-deepseek
     config:
       apiKeyEnv: DEEPSEEK_API_KEY
       maxTokens: 2048                     # 该 runtime 的输出上限基线
   - id: sandbox-policy
     config:
       mode: read-only                     # 或 workspace-write
       workspaceRoot: <runtimes-root>/<id>/workspace
   - id: llm-deepseek-account
     disabled: true                        # 只留一个 provider，拓扑干净
   - id: session-telemetry-otel
     disabled: true
   ```
5. **启动**：`dsh --profile sdk --patch <…>/patch/runtime.yml`，`cwd=<…>/workspace`，`DSH_HOME=<…>/home`；用 `@deepseek-ai/dsh-sdk-client` 的 `HarnessClientOptions.env` 传一个**完整替换**的环境（README：`env` replaces the child environment entirely；`scrubbedParentEnv` from `dsh-subprocess` 是官方推荐的清洗底），这样开发者 shell 里的 `DEEPSEEK_*`、`AWS_*` 之类一个都进不来。
6. **每 agent 参数**：
   - `maxTokens`（**支持**）：`initialize.maxTokens`（覆盖该 agent 及其进程内后代）或 patch 里 `agents[].maxTokens`；
   - `temperature`（**不支持**）：加一个 §3.2 的 `agent/request` 插件行，`config: { temperature: 0.3 }`；同一 runtime 内所有 agent 共享该值。**同一 runtime 要跑不同温度的不同 agent，就得每 agent 一个 runtime**（这正是本方案的形态，成本可接受）。

---

## 3. 生成参数：`temperature` / 输出上限到底在哪一层

### 3.1 唯一存在 `temperature` 的三处

| 位置 | 声明 | 是否可配置 |
|---|---|---|
| `GenerateOptions` | `temperature?: number`（`.../dsh-llm/lib/types/types.d.ts:528`） | 只有**代码调用** `ctx.llm.stream()` 时能传 |
| `LlmCallControls` / `LlmCallConfig` | `temperature?: number`（`.../dsh-llm/lib/types/call-config.d.ts:11-26`） | 同上；也是 `agent/request` waterfall 的返回类型 |
| DeepSeek wire body | `...options.temperature === void 0 ? {} : { temperature: options.temperature }`（`.../dsh-llm-deepseek/lib/index.js:1734`） | 只要上游给了就会发出去 |

**反面证据（决定性的）**：

- DeepSeek adapter 的 Config schema **没有** `temperature`（`.../dsh-llm-deepseek/lib/types/config.d.ts:8-45` / `:71-90`，全部字段见 §5 表）。
- `dsh-agent-loop` 的 `agents[]` 只有这 8 个字段：`id`、`provider`、`model`、`reasoningEffort`、`maxTokens`、`cwd`、`sessionId`、`resumeSessionId`（`.../dsh-agent-loop/README.md` 字段表；运行时 schema 见 `.../dsh-agent-loop/lib/index.js:1555-1561`）。
- `dsh-llm` README 明确把 `temperature` 归入"service 层可传、但**没有 producer**"的一类，且 `top_p`/penalty 根本不存在：`GenerateOptions sampling is temperature/maxTokens/stop only — no tool_choice, top_p, or penalty fields`。
- loop 组装请求时只写 `provider`/`model`/`reasoningEffort`/`maxTokens`（`.../dsh-agent-loop/lib/index.js:1186-1190`）。

> **结论：0.2.1-rc.3 里 `temperature` 不能通过任何配置键按 agent 设置。** SDK `initialize` 的 5 个字段（`cwd`/`provider`/`model`/`reasoningEffort?`/`maxTokens?`，见 `.../dsh-sdk-protocol/lib/types/types.d.ts` 的 `InitializeParams`）里也没有。

### 3.2 官方支持的自定义点：`agent/request` waterfall

`agent/request` 是一个 **waterfall**：`(this: Scoped<Agent>, payload:{agent,turn,step,signal}, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>`（`.../dsh-agent/lib/types/runtime-types.d.ts:327-332`）。它是 **agent-scoped** 的：agent 作用域内的监听器只收到该 agent 的请求（同文件注释 "Scope-filtered dispatch … agent-scoped listeners receive only that agent"）。

loop 的用法（`.../dsh-agent-loop/lib/index.js:1191-1202`）：

```js
const proposedConfig = await this.dispatch.waterfall("agent/request", { turn, step, signal }, () => Promise.resolve(seedConfig));
…
preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal);
```

而 `prepareCall` → `resolveCallWithInfo` **不校验 `temperature`**（只校验 reasoning effort 与 maxTokens 默认值，见 §1.2），`callConfigEquals` 会把 `temperature` 一起比较（`.../dsh-llm/lib/index.js:368`），随后 `header.config` 被冻结成请求的一部分 —— 也就是说**放进去就会被发到 wire 上**。

官方自己的写法可照抄（`.../dsh-agent/lib/types/model-selection.js:61-75`）：

```js
const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
  const resolved = await next()
  return { ...resolved, provider: selected.provider, model: selected.model /* 这里也可以加 temperature */ }
})
```

**网关落地方式**（不改 DSH 源码，只加一个自己的插件包）：

```js
// @agent-studio/dsh-plugin-sampling  (ESM)
// 不需要 inject：只监听当前作用域上的事件（普通插件导出 name + apply 即可）
export const name = 'agent-studio-sampling'
export function apply(ctx, config) {
  // config.temperature / config.maxTokens 来自 patch 行
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    return {
      ...resolved,
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    }
  })
}
```

然后用 patch 把它插进 agent 预设（`insert` 的 name 支持**包名、绝对路径、file URL**，见 `.../dsh-app-boot/README.md`："Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers"）：

```yaml
- insert:
    - id: agent-sampling
      name: '@agent-studio/dsh-plugin-sampling'   # 或 'file:///E:/…/sampling.mjs'
      config:
        temperature: 0.3
        maxTokens: 2048
```

> **状态：UNVERIFIED（机制层已核实，端到端未实测）。** 我已核实 ① `agent/request` 的签名与 scope 语义；② loop 会把 waterfall 的返回值交给 `prepareCall`；③ `temperature` 会进 `header.config` 并被 `callConfigEquals` 比较；④ DeepSeek 适配器会把 `temperature` 放进请求体。未实测的是"插件经 patch 插入后真的出现在 wire body 里"。

### 3.3 输出上限（`maxOutputTokens`）—— 这个是支持的

按优先级从"最靠近单次请求"到"最宽"：

| 机制 | 键 | 作用域 | 证据 |
|---|---|---|---|
| 声明式 agent | `agents[].maxTokens` | 该 agent 每个请求 | `.../dsh-agent-loop/README.md` |
| SDK 握手 | `initialize.maxTokens` | 所有 SDK 创建的 root agent 及其**进程内后代** | `.../dsh-sdk-jsonrpc-server/README.md`、`.../dsh-sdk-protocol/lib/types/types.d.ts` |
| provider 插件 | `llm-deepseek.config.maxTokens` | 该 provider 路由的**默认**上限（`default 256000`，模型自身 cap 与显式请求值优先） | `.../dsh-llm-deepseek/lib/types/config.d.ts:15-16,75` |
| pi-ai 路由 | `defaultMaxTokens`（默认 `32768`）/ 模型的 `maxTokens` | 该 route 未描述模型的兜底 | `.../dsh-llm-pi-ai/README.md` |

### 3.4 一个必须知道的"默认值陷阱"

adapter 会 materialize 默认输出上限：`resolveCallWithInfo` 在请求没给 `maxTokens` 时补上 `info.defaultMaxTokens`，并把它记进 `adapterDefaults.maxTokens`；下一轮 waterfall 前 loop 会**删掉**这些 adapter 默认字段以便重新解析（`.../dsh-agent-loop/lib/index.js:719-720`）。所以"显式设的 maxTokens 会持久，adapter 默认值不会"。想真正封顶，**显式设**（`agents[].maxTokens` / `initialize.maxTokens` / 插件），不要依赖默认。

---

## 4. 离线 / 确定性测试

### 4.1 两个包的分工

| 包 | 形态 | 需要什么 | 用途 |
|---|---|---|---|
| `@deepseek-ai/dsh-llm-mock-server` | **进程内 HTTP/SSE 服务**（`startMockLlmServer`），**不是 Cordis 插件** | 只要一个端口 | 让**真实** adapter + 真实 loop 打本地端点；可脚本化故障 |
| `@deepseek-ai/dsh-llm-replay` | **Cordis 插件**（patch 行） | 一份**录制好的 session fixture**（`$DSH_SNAPSHOT_FILE`） | 快照测试；从零起步的 CI 用不上 |

**mock server 的返回**：每个被接受的 `POST …/v1/messages` 消耗**一个**脚本行为。`success` / `slow_success` / `reasoning_success` 会流出一个完整的文本响应；`max_tokens` 以 `length` 结束；`tool_call_success` 以工具调用结束；另有 `rate_limit`、`server_error`、`auth_error`、`context_overflow`、`quota_exceeded`、`stall`、`partial_disconnect`、`malformed_json` 等（`.../dsh-llm-mock-server/README.md` 行为表）。脚本耗尽返回结构化 HTTP 500（`script_exhausted`），除非 `repeatLast: true`。

关键类型（`.../dsh-llm-mock-server/lib/types/index.d.ts`）：

```ts
startMockLlmServer(options: {
  host?, port?,           // port: 0 → OS 分配
  apiKey?,                // 设置了就校验 x-api-key
  sequence: MockLlmBehavior[],
  repeatLast?, randomSeed?, randomWeights?,
  successText?, partialText?, reasoningText?,
  chunkSize?, chunkDelayMs?, disconnectDelayMs?, retryAfterMs?,
  requestId?, toolName?, toolArguments?, onEvent?,
}): Promise<{ baseURL: string; port: number; randomSeed: number; requests: MockLlmRequestRecord[]; close(): Promise<void> }>
```

> `baseURL` 是**不带 `/v1`** 的 origin；真实端点是 `/v1/messages`。

### 4.2 为什么"只改 baseURL"就够

DeepSeek adapter 的端点解析（`.../dsh-llm-deepseek/lib/index.js:441,349`）：

```js
const baseURL = config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? "https://api.deepseek.com/anthropic";
// BASE_URL_ENV = "DEEPSEEK_BASE_URL"
```

而"是否去拉官方 `/models` listing"由 **origin 是否等于官方 origin** 决定（`.../dsh-llm-deepseek-api-key/lib/index.js:33,37`：`listed = new URL(connection.baseURL).origin === OFFICIAL_ORIGIN && isBuiltInCatalog(connection.models)`）。所以把 baseURL 指向 `127.0.0.1` 之后：

1. **不会**发任何 listing 请求（零网络）；
2. 模型目录退回内建 `deepseek-flash` / `deepseek-v4-pro`（`deepseek-flash` 正是 base 的 `agent-default-model`）；
3. 凭据仍然必须存在（adapter 的 `resolveApiKey` 在请求前就会抛 `MISSING_CREDENTIAL`），但**任意非空字符串**都行 —— mock server 用 `apiKey` 选项校验时给同一个值即可。

### 4.3 Mock-LLM patch YAML（copy-paste）

**A. 最小确定性 patch**（推荐放 `$DSH_HOME/profiles/headless/cordis.patch.yml` 或作为 `--patch` overlay；把会发网络的辅助行关掉）

```yaml
# .tmp/patch/mock-llm.cordis.yml
# 目标：headless/sdk 在无网络、无真实凭据下跑一轮。
# 注意：patch 会「整段替换」目标行的 config，所以必须把要保留的字段一并写上。

# 1) 把 DeepSeek 路由指向本地 mock（端点优先级：config.baseURL > $DEEPSEEK_BASE_URL > 官方）
- id: llm-deepseek
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: http://127.0.0.1:PORT/v1
    maxTokens: 2048

# 2) 关掉会额外消耗一次模型调用的标题生成（每多一次调用就多消耗一个 mock 脚本条目）
- id: session-title-llm
  disabled: true

# 3) 关掉遥测出口
- id: session-telemetry-otel
  disabled: true

# 4) 关掉账号路由（没有账号 token 时它只会制造噪声）
- id: llm-deepseek-account
  disabled: true
```

> 也可以完全不写 `baseURL`，改用环境变量 `DEEPSEEK_BASE_URL=http://127.0.0.1:PORT/v1` —— 两者等价，环境变量对网关更省事（patch 里就不必填端口）。

**B. replay 插件 patch（有录制 fixture 时才用）**

```yaml
- insert:
    - id: llm-replay
      name: '@deepseek-ai/dsh-llm-replay'
      config:
        providers:
          - id: deepseek-official
            name: DeepSeek
            retryPolicy:
              mode: normal
              backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
            models:
              - id: deepseek-flash
                contextWindow: 1048576
        # file / overrideFile / childFiles 默认取 $DSH_SNAPSHOT_FILE /
        # $DSH_SNAPSHOT_OVERRIDE / $DSH_SNAPSHOT_CHILD_FILES
```

### 4.4 端到端冒烟命令

```powershell
# 0) 依赖（mock server 不在 @deepseek-ai/dsh 的依赖里，必须显式装同版本）
npm install --cache E:\Code\OceansLabWeb\dsh_oceanslab\.npm-cache --no-audit --no-fund `
  "@deepseek-ai/dsh-llm-mock-server@0.2.1-rc.3"

# 1) 一次性 home（不碰 ~/.dsh）
$env:DSH_HOME = 'E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-provider'
$env:DSH_TELEMETRY_DISABLED = '1'

# 2) 跑冒烟脚本 —— 它自己起 mock、起 dsh、断言、退出
Set-Location .tmp\mockdeps
node smoke.mjs
```

> 本仓库已实测通过的脚本在 **`.tmp\mockdeps\smoke.mjs`**（`.tmp\mock-headless.mjs` 是同一份逻辑的早期草稿）。
> 该主机文件沙箱禁止子进程使用 piped stdio（`spawn EPERM`），所以脚本用**普通文件描述符**捕获子进程 stdout/stderr；在普通 CI runner 上把 `stdio` 换成 `['ignore','pipe','pipe']` 即可。**这不是产品限制。**

脚本核心：

```js
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { spawn } from 'node:child_process'

const server = await startMockLlmServer({
  port: 0, apiKey: 'mock-key',
  sequence: ['success'], repeatLast: true,
  successText: 'MOCK_OK',
})
const env = { ...process.env, DSH_HOME: HOME, DEEPSEEK_BASE_URL: `${server.baseURL}/v1`, DEEPSEEK_API_KEY: 'mock-key' }
const child = spawn(process.execPath, [BIN, '--profile', 'headless', 'hello'], { env, stdio: ['ignore', outFd, errFd] })
// …等退出，断言 exit code === 0 && stdout.includes('MOCK_OK')
```

**等价的手工命令**（分两个终端，便于排障）：

```powershell
# 终端 A：mock
node -e "import('@deepseek-ai/dsh-llm-mock-server').then(async ({startMockLlmServer})=>{const s=await startMockLlmServer({port:8765,apiKey:'mock-key',sequence:['success'],repeatLast:true,successText:'MOCK_OK'});console.log('baseURL',s.baseURL)})"

# 终端 B：runtime
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-provider'
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:8765/v1'
$env:DEEPSEEK_API_KEY='mock-key'
$env:DSH_TELEMETRY_DISABLED='1'
node node_modules\@deepseek-ai\dsh\lib\bin.js --profile headless "hello"
```

预期：stdout 打印 `MOCK_OK`，exit code 0，stderr 无 `MISSING_CREDENTIAL`。**VERIFIED**（见 §6）。

---

## 5. `dsh-settings` 与"全新 `$DSH_HOME` 最少需要什么"

### 5.1 settings 的真实落点

`.../dsh-settings/README.md`：

> "Forms expose only volatile fields from active, uniquely addressed profile entries. … Changes persist through the active profile's Cordis patch."
> "a `settings.yaml` left in the harness home by earlier releases is imported once … the file is renamed to `settings.yaml.imported` before the first write"

也就是说：

- **没有**"用户级 settings 文件"这一层需要创建。可用可变字段（`.volatile()`）落盘到 **`$DSH_HOME/profiles/<name>/cordis.patch.yml`**。
- `settings.yaml` 只用于**旧版本迁移**，新部署不需要；如果 home 里存在它，首次启动会被导入并改名为 `settings.yaml.imported`。
- 表单写入会被 home patch / CLI overlay 覆盖时会被**拒绝**（"Home patches and command-line overlays take precedence"）。

### 5.2 层叠顺序（决定"谁赢"）

`.../dsh/README.md` + `.../dsh-app-boot/README.md`：

```
每个 bundle 的 patch（按 dsh.profile.bundles 顺序）
  → profile 的 $DSH_HOME/profiles/<name>/cordis.patch.yml
  → home 级 $DSH_HOME/cordis.patch.yml          ← 比 profile 级更强
  → --patch 覆盖层（最后）
```

且 **patch 是"整段替换该行的 config"，不是深合并** —— 改写一行时必须把想保留的字段全部重述（`.../dsh-base/cordis.patch.yml` 开头注释、`.../dsh-app-boot/README.md`：`replace one entry's whole config (restating the fields you keep)`）。

### 5.3 最少文件清单（以实测的 `.tmp\home-provider` 为准）

`$DSH_HOME` 从**空目录**起步，只跑一次 `dsh --profile headless "hello"` 之后，磁盘上实际生成的就是全部所需文件：

```
.tmp\home-provider\
  .anonymous-user-id                       # 遥测用的随机 UUID（删掉即重置身份）
  profiles\headless\package.json           # { dsh: { profile: { bundles: [dsh-base, dsh-headless] } } }
  profiles\headless\cordis.yml
  profiles\headless\cordis.patch.yml        # 用户补丁层
  profiles\headless\pnpm-workspace.yaml     # 该 profile 的插件用 pnpm 管理（dsh plugin）
  sessions\<workspace-slug>\session-*.jsonl # 会话日志
  storages\session_projcache\…              # 投影缓存
```

自动生成的 `cordis.patch.yml` 内容（**注意模板自带 `[]`**）：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
```

| 文件 | 全新 home 是否需要手工创建 | 说明 |
|---|---|---|
| `profiles/<name>/package.json` | **否** | 首次使用该 profile 时自动从随包模板初始化（`sdk`/`sdk-minimal`/`headless`/`web`/`acp`） |
| `profiles/<name>/cordis.patch.yml` | **否**（自动生成，含 `[]`） | **不要**手工留一个"只有注释、没有 `[]`"的文件，那会 boot 失败 |
| `$DSH_HOME/cordis.patch.yml` | 否 | 只有需要全局覆盖时才建；同样必须写 `[]` 而不是纯注释 |
| `$DSH_HOME/.credentials.yaml` | **否** | 走环境变量凭据时**故意不建**（建了就会压过 env） |
| `$DSH_HOME/.env` | 否 | 最弱的一层环境 |
| `sessions/`、`storages/` | **否** | `session-persistence-jsonl` / `storage-json` 的 root，首次写入时创建 |
| settings 文件 | **否** | 见 §5.1，`settings.yaml` 只用于旧版本一次性迁移 |

### 5.4 相关配置键（`llm-deepseek` / `deepseek-official`，供 patch 使用）

`.../dsh-llm-deepseek/lib/types/config.d.ts`（全部字段，已逐个核对；**没有 `temperature`**）：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com/anthropic` | 必须是 HTTP(S) 根，不能带认证/query/fragment |
| `thinking` | — | `enabled` / `disabled`；`disabled` 时只允许 `reasoningEffort: off` |
| `reasoningEffort` | `high` | `off` / `low` / `high` / `max` |
| `maxTokens` | `256000` | 单请求输出上限（模型自身 cap 与显式请求值优先） |
| `defaultContextWindow` | `1000000` | 无精确容量时使用 |
| `models` | 内建两项 | 改写目录即停止跟随官方 listing |
| `streamIdleTimeoutMs` | `300000` | |
| `maxRequestFilesBytes` / `maxInlineRequestImageBytes` / `maxImagesPerRequest` / `imageOffloadByteQuantum` / `inlineImageOffloadByteQuantum` / `imageOffloadCountQuantum` | 见类型 | 图片预算 |
| `filesApiTimeoutMs` / `fileExpiresAfterSeconds` / `fileRefreshMarginSeconds` / `fileQuotaCleanupBatch` | 见类型 | Files API |
| `retryPolicy` | normal / 5 次 | 由 `dsh-llm-retry` 执行 |
| `apiKeyEnv`（仅 api-key 插件） | `DEEPSEEK_API_KEY` | 凭据引用（`role("credential-ref")`） |
| `modelsTimeoutMs`（仅 api-key 插件） | `5000` | listing 单次超时 |
| `modelsMaxAgeMs`（仅 api-key 插件） | `600000` | listing 刷新年龄 |

---

## 6. 实测记录

环境：Windows，node v24.21.0，cwd `E:\Code\OceansLabWeb\dsh_oceanslab`，`DSH_HOME=E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-provider`。

### 6.1 CLI 版本与帮助（VERIFIED）

```powershell
$env:DSH_HOME='E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\home-provider'
node node_modules\@deepseek-ai\dsh\lib\bin.js --version
```
```
0.2.1-rc.3
```

`--help` 实际输出（节选，exit 0）：

```
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

Options:
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  replace a custom profile with a fresh copy of a shipped profile template
  --patch <path>                 extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and patches without mounting
  --dump-default-config          print the profile tree without its user layer or --patch overlays and exit
```

`$DSH_HOME` 由空目录起步时，`headless` profile 自动初始化成功（无需任何手写文件）。

### 6.2 凭据无关的 mock-LLM 冒烟（VERIFIED）

命令（在本沙箱主机上，`spawn` 的 piped stdio 被拒 → 用文件描述符捕获；普通 CI 上 `pipe` 亦可）：

```powershell
Set-Location .tmp\mockdeps          # 该目录内已装 @deepseek-ai/dsh-llm-mock-server@0.2.1-rc.3
node smoke.mjs
```

实际输出：

```
[smoke] mock listening, baseURL=http://127.0.0.1:4830
=== exit code: 0
=== stdout ===
MOCK_OK

=== stderr (tail 30) ===

=== mock requests: 2
  attempt 1 path=/v1/messages behavior=success outcome=completed chunks=6
  attempt 2 path=/v1/messages behavior=success outcome=completed chunks=6
SMOKE: PASS
```

要点：

- **零网络**：端点全部是 `127.0.0.1`；二进制内没有任何官方 endpoint 被访问（因为 `baseURL` 的 origin ≠ 官方 origin，adapter 连 `/models` listing 都不发）。
- **零真实凭据**：`DEEPSEEK_API_KEY='mock-key'` 是假值，mock server 用 `apiKey: 'mock-key'` 接受它。
- **`mock requests: 2` 证实了 gotcha #5**：一次 headless 回合实际发了 **2** 次 Messages 请求（1 次正文 + 1 次会话标题生成）。`repeatLast: true` 让第二个请求也拿到 `success`。
- stdout 只有最终答案 `MOCK_OK`（诊断信息走 stderr）。

### 6.3 SDK 握手：未知 provider 的精确错误（VERIFIED）

用 `--profile sdk`、stdin 来自文件（`initialize` + 一次 `session/prompt`，随后 EOF 关闭）：

```
########## case unknown-provider (profile=sdk) exit=0
{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"SDK server is not initialized"}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"no adapter registered for provider \"bogus-provider\""}}
```

```
########## case official-provider (profile=sdk) exit=0
{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"SDK server is not initialized"}}
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
```

这组结果同时证明了三件事：

1. 未知 provider 的 wire 表现是 **JSON-RPC error `-32603`**，message 就是 §1.2 的 `no adapter registered for provider "<id>"`（无业务 code 字段）。
2. `--profile sdk` 在 **home 内没有 `.credentials.yaml`** 时，`DEEPSEEK_API_KEY` 环境变量足以让 `deepseek-official` 的 `initialize` 成功 —— 即 §2.4 的路径 A 对 `sdk` profile 同样成立（只要别在该 home 里放凭据文件）。
3. `session/prompt` 与 `initialize` 是**并发派发**的：脚本把两帧一次性写进 stdin 时，`prompt` 先于 `initialize` 完成，被 `SDK server is not initialized` 拒绝。**客户端必须 await 握手**（这正是 `dsh-sdk-client` 的 `start()` 做的事）。

**补充实测：未知 model 不会被握手挡住**

```json
// 只发 initialize，params = { cwd, provider: 'deepseek-official', model: 'totally-made-up-model' }
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
```

→ 握手**成功**。model id 完全没有被校验（与 §1.2 的代码结论一致）。白名单只能在网关上做。

### 6.4 空 home patch 的两种写法（VERIFIED）

```powershell
'# only a comment' | Set-Content .tmp\home-provider\cordis.patch.yml
node node_modules\@deepseek-ai\dsh\lib\bin.js --profile headless --dump-config
# exit=1
# Error: dsh: patches E:\…\.tmp\home-provider\cordis.patch.yml must be a top-level YAML array of loader patch entries

'[]' | Set-Content .tmp\home-provider\cordis.patch.yml
node node_modules\@deepseek-ai\dsh\lib\bin.js --profile headless --dump-config
# exit=0
```

### 6.5 组合树（`--dump-config`，VERIFIED）

```powershell
node node_modules\@deepseek-ai\dsh\lib\bin.js --profile headless --dump-config
```

关键行（exit 0，输出 12,314 字节）：

```yaml
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  disabled: true            # ← headless：托管凭据库被关闭，只用启动环境

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'

- id: llm-deepseek-account
  name: '@deepseek-ai/dsh-llm-deepseek-account'

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
```

### 6.6 未验证项（明确标记）

- `agent/request` 注入 `temperature` 的端到端 wire 效果（§3.2）——**UNVERIFIED**（机制链已逐跳核实）。
- `dsh-llm-replay` 需要 fixture，未跑（§4.3 B）——**UNVERIFIED**。
- `deepseek-flash` vs README 里 `deepseek-v4-flash` 的最终映射——离线无法核对官方 listing。

---

## 7. Gotchas

1. **未知 provider 在 `initialize` 抛的是裸 `Error`（无 code）**，而运行期同一句话是 `LlmError` + `NO_ADAPTER`。网关判错不要只依赖 `code`。
2. **model id 不做白名单校验**。`deepseek-official` 会接受任意 id（未在 listing 中的照常透传）。白名单必须由网关做。
3. **`dsh-llm-mock-server` / `dsh-llm-replay` / `dsh-sdk-client` 不在 `@deepseek-ai/dsh` 的 dependencies 里**（是 CLI 的 devDependencies），`npm i @deepseek-ai/dsh` 之后 `import` 会失败。必须显式装 **同版本**，否则会出现两份 `dsh-llm` → `DUPLICATE_ADAPTER`。
4. **mock server 的 `baseURL` 不带 `/v1`**，而 `DEEPSEEK_BASE_URL` 要带 `/v1`（adapter 自己拼 `/messages`）。写错会得到 404，且 404 **不消耗** mock 脚本（只有 `POST …/v1/messages` 才消耗），表现是"卡住不动"而不是"脚本耗尽"。
5. **一次 agent 回合不止一次模型调用**。headless/sdk 若 `session-title-llm` 仍启用，标题生成会多消耗一个脚本条目。CI 里要么 `disabled: true`（见 §4.3 patch）、要么 `repeatLast: true`。
6. **patch 是整段替换 config**。只写 `baseURL` 会把该行原有的 `reasoningEffort`/`maxTokens`/Files API 设置全部抹掉（回到 schema 默认），改动一行必须重述想保留的字段。
7. **`cordis.patch.yml` 只有注释 = boot 失败**。停用 home 层要写 `[]`。
8. **环境变量里的 key 对 agent 的 shell 可见**（每层 `.env`/env 都会被复制进 `process.env`）；`.credentials.yaml` 不会进 env，但"同 UID 可读"——两个机制都不是"agent 拿不到 key"的边界。需要强隔离只能靠网关侧代理 + 不给 shell。
9. **`$DSH_HOME` 空白字符串等于未设**（不会退化成 cwd），但**忘了设**就静默用 `~/.dsh`。网关务必显式传 `DSH_HOME` 并断言其存在。
10. **`credentials` 服务一旦挂载，环境变量只是兜底**：`sdk`/`web` profile 下，若 home 里残留 `.credentials.yaml`，它会**压过** `DEEPSEEK_API_KEY`。`headless`/`sdk-minimal` 没有这个服务，行为相反。
11. **`llm-deepseek-account` 是第二个 provider id（`deepseek-account`），不是 `deepseek-official` 的别名**。想看"只有一个 provider"的干净拓扑，把该行 `disabled: true`。
12. **`dsh-llm-pi-ai` 的 `models` 是"整体替换"不是"增量"**；`modelOverrides` 不能与 `models` 同时出现；`stop` 参数在该路由会被 `UNSUPPORTED_OPTION` 拒绝。
13. **`session` 目录按 home 隔离**：不同 runtime 用不同 `DSH_HOME` 时不会有跨 runtime 的 session 串味，但也意味着**恢复历史必须用相同 home + 相同 workspace**（`dsh-sdk-client` README：`reuse its home and workspace`）。
14. **`temperature` 写进 `agent/request` 后没有任何边界校验**（`resolveCallWithInfo` 不检查）。给了 `2.5` 也会被原样发到 wire，由供应商报错。自己的插件要自己夹逼。
15. **JSON-RPC 请求是并发派发的**：`session/prompt` 在 `initialize` 完成前发出会被 `SDK server is not initialized` 拒绝（已实测）。自己写客户端必须 await 握手，别一次性把两帧灌进 stdin。
16. **`--profile headless` 只关掉 `credentials`/`authorization`/`deepseek-account` 三行**，`llm-deepseek-account`（LLM 路由行）仍在组合里；想彻底干净地只有一个 provider，需要自己再 patch 掉它。
17. **本仓库里 `dsh-sdk-client` 在 `node_modules` 里、`dsh-llm-mock-server` 不在** —— 因为 `apps\gateway\package.json` 显式依赖了 `@deepseek-ai/dsh@0.2.1-rc.3` + `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3`，而 mock server 没有任何 workspace 依赖它。这一对差异正好证明 gotcha #3：**要用 mock server 必须自己往某个 workspace 的 dependencies 里加同版本**。
18. **`sdk-minimal` 是"最小"但不是"受限"**：它的 bundle 把 `sandbox-policy.mode` 钉死为 `danger-full-access`，且 `tool-fs` 的 `read/write/edit` 全关（只有 shell）。想给受限 agent 用，选 `sdk` + patch 收窄。
19. **patch 里写 `baseURL` 会让 `deepseek-official` 停止跟随官方 listing**（origin 变了），模型目录退回内建两项。这在离线测试里正是我们要的，但在生产里如果你依赖 listing 新增模型，就会静默失去它们。

---

## 8. 读过的源码 / 文档（绝对路径 + 版本）

所有包均由 `npm pack @deepseek-ai/<name>@0.2.1-rc.3` 解包至 `.tmp\pkgs\deepseek-ai-<name>-0.2.1-rc.3\package\` 后阅读。

| 包 | 版本 | 路径（下文 README / lib 均在此目录下） |
|---|---|---|
| `@deepseek-ai/dsh` | 0.2.1-rc.3 | `E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\pkgs\deepseek-ai-dsh-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-base` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-base-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-llm` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-llm-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-llm-deepseek` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-llm-deepseek-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-llm-deepseek-api-key` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-llm-deepseek-api-key-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-llm-deepseek-account` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-llm-deepseek-account-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-llm-pi-ai` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-llm-pi-ai-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-llm-mock-server` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-llm-mock-server-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-llm-replay` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-llm-replay-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-credentials` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-credentials-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-credentials-local` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-credentials-local-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-settings` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-settings-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-home-paths` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-home-paths-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-app-boot` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-app-boot-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-launch-environment` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-launch-environment-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-subprocess` | 0.2.1-rc.3 | `…\.tmp\pkgs\dsh-subprocess-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-sdk-app` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-sdk-app-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-sdk-minimal` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-sdk-minimal-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-sdk-jsonrpc-server-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-sdk-protocol` | 0.2.1-rc.3 | `…\.tmp\pkgs\dsh-sdk-protocol-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-sdk-client` | 0.2.1-rc.3 | `…\.tmp\pkgs\dsh-sdk-client-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-headless` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-headless-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-agent` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-agent-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-agent-loop` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-agent-loop-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-agent-default-model` | 0.2.1-rc.3 | `…\.tmp\pkgs\dsh-agent-default-model-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-agent-preset` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-agent-preset-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-authorization` | 0.2.1-rc.3 | `…\.tmp\pkgs\dsh-authorization-0.2.1-rc.3\package\` |
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | 0.2.1-rc.3 | `…\.tmp\pkgs\deepseek-ai-dsh-deepseek-llm-api-extensions-0.2.1-rc.3\package\` |

**未在 npm 上找到的包**：`@deepseek-ai/dsh-providers-hub`、`@deepseek-ai/dsh-providers` —— `npm view "@deepseek-ai/dsh-providers-hub" version` 返回空并 exit 1（404）。本报告中"provider 目录 / hub"对应物是 `@deepseek-ai/dsh-llm` 内置的 **configurable-provider directory**（`ctx.llm.registerConfigurableProviders`），不是独立包。

**未解决 / 未验证**（明确标记）：

1. `agent/request` 插件注入 `temperature` 的**端到端**效果（机制已核实，未实测 wire body）。→ §3.2 标 UNVERIFIED。
2. `dsh-llm-replay` 路径无 fixture，未实测。→ §4.3 B 未实测。
3. `deepseek-flash` 与 `deepseek-v4-flash` 的最终生效 id：内建目录里是 `deepseek-flash`，但 `dsh-llm` README 示例用 `deepseek-v4-flash`；未在官方 listing 上核对两者关系（离线无法核对）。
