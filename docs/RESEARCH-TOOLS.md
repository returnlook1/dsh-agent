# DeepSeek Harness 工具插件 API 研究报告（`0.2.1-rc.3`）

> 目的：为 `plugins/agent-policy`（策略）、`plugins/agent-tools`（业务工具）、`plugins/agent-audit`（审计）
> 三个 Cordis 插件提供**可直接落地**的 API 事实：`defineTool` 精确签名与校验边界、工具注册与模块形状、
> `tools/pre-execute` / `guard` / `restrict` / approval 的语义、钩子里能拿到什么身份、
> 以及审计记录实际可用的字段。
>
> **验证基线**：所有断言只来自 npm 实际发布的 `0.2.1-rc.3` 打包文件（Cordis 为 `4.0.5`）。
> 主读取位置 `E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\pkgs\<pkg>-0.2.1-rc.3\package\`；
> 仓库改用 npm workspaces 平铺布局后，同一文件等价路径为
> `node_modules\@deepseek-ai\<pkg>\lib\types\*.d.ts` / `lib\*.js`。
> 每条断言后面的 `path:line` 指向真实读过的文件。
>
> **验证方式**（不是纯阅读）：
> 1. 两个 skeleton 用真实包做过类型检查：`.tmp\toolcheck`（`typescript@5.9.3`，`tsc --noEmit` **EXIT=0**）。
> 2. 关键运行时语义做过真实跑测：`.tmp\toolcheck\smoke*.mjs`（用 `cordis` + `dsh-system-prompt` +
>    `dsh-tools` 组装一个真 `Context`，注册真工具、真 guard、真 listener，然后真 `ctx.tools.execute()`）。
>    结论中凡标 **运行时已验证** 的都是这样得出的，不是推断。
> 3. 未能验证的地方一律标 `未验证` / `TODO(verify)`。

---

## 1. 结论速查表

| # | 问题 | 结论 | 精确名字 / 依据 |
|---|---|---|---|
| 1a | `defineTool` 的精确签名 | `defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition` | `dsh-tools/lib/types/schema.d.ts:248` |
| 1b | `output.schema` + `output.render` 是否强制 | **两者都强制**（`output` 本身是必填对象，两个字段都是非可选）。`defineTool` 不做运行期检查，但 `register()` 会抛 `TypeError` | `schema.d.ts:186-193`；`dsh-tools/lib/index.js:2977`（运行时已验证：`tool "bad" must declare output { schema, render, presentationMeta? }`） |
| 1c | 参数 DSL 能表达什么 | `type: string/number/integer/boolean/null/array/object/json` + `const` + `enum` + `oneOf`（≥2 分支）+ `description/title/default/examples`；**没有 min/max/maxLength/pattern/format** | `schema.d.ts:9-72` |
| 1d | 数字范围（如 1..30）怎么写 | **DSL 做不到**，必须在 `execute` 里自己校验抛 `Error` | `schema.d.ts:26-36`（`NumberValueSchemaSpec` 只有 `enum`/`const` 注解）；skeleton B 实测 |
| 1e | 可选参数怎么声明 | 省略 `required: true`（`ParameterPropertySpec = ValueSchemaSpec & { required?: true }`）；必填靠**每个属性**上的 `required: true`，不是 JSON Schema 的 `required: []` | `schema.d.ts:73-76` |
| 1f | `render(args, value)` 契约 | 纯函数，返回 `ContentBlock[]`；`ContentBlock` 是 `ContentBlockMap[ContentBlockType]`，模型能读的主要是 `{ type: 'text', text }` | `schema.d.ts:190`；`schema.d.ts:110`（`ToolOutputDefinition.render`）；`dsh-llm/lib/types/types.d.ts`（`ContentBlockMap` / `ContentBlock`） |
| 2a | 谁校验参数 | **`defineTool` 包的 wrapper**，不是 registry。registry 完全不校验入参 | `schema.js:315-320`（`async execute(args, exec) { validate(); throw new ToolArgsError(...) }`） |
| 2b | 坏参数抛什么 | `ToolArgsError extends HarnessError`，`code: 'INVALID_ARGS'`，`name: 'ToolArgsError'`，`.violations: string[]` | `schema.d.ts:165-169`；`schema.js`（构造函数内 `super(..., 'INVALID_ARGS')`） |
| 2c | 手写 `ToolDefinition`（不用 `defineTool`）会校验吗 | **不会**。`register()` 只检查 `output` 形状、`assertSupportedJsonSchema`、`timeoutMs` 正数、`run_code` 保留名 | `dsh-tools/lib/index.js:2974-2983` |
| 2d | 输出会被校验吗 | 会。成功值必须满足 `output.schema`，否则 `ToolOutputError` | `index.d.ts:406-411` |
| 3a | `register()` 的作用域规则 | 作用域取自**调用它的 ctx**：plain `ctx` → 全局层；`agent.ctx` → 该 agent 的层。scoped 覆盖 global；同层重名报错 | `index.d.ts:631-637`；`lib/index.js:2982`（`this.layers.effect(this.ctx, ...)`）；运行时已验证重复名报错串 |
| 3b | 保留名 | `run_code` 不可注册/不可影子，报 `tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed` | `lib/index.js:955, 2981`；运行时已验证 |
| 3c | disposer 语义 | `register()` 返回**精确 disposer**，调用即注销；同时它是 fiber 拥有的 effect，unload 时自动回收 | `index.d.ts:636`；`lib/index.js:2982`；运行时已验证（dispose 后 `ctx.tools.get()` 返回 `undefined`） |
| 3d | 插件必须导出什么 | `name`（fiber 诊断名）、`inject`（服务依赖）、`apply(ctx, config)`，可选 `Config`（schemastery，`z<Config>`）。**没有 `reusable` 字段** | `dsh-tool-todo/lib/index.js:11-12,196`；`cordis/lib/types/registry.d.ts`（`Plugin.Base` 只有 `name/Config/inject/provide/intercept`） |
| 4a | `tools/pre-execute` 的 `next()` | waterfall：每个 listener 包住剩下整条链；调 `next()` = 交给下一个/listener 之后的内建行为（最终 `{kind:'allow'}`）；**不调 `next()` 且直接 return 值 = 短路整条链** | `cordis/lib/types/events.d.ts:20-25,66-79`；`lib/index.js:3321`；短路语义运行时已验证 |
| 4b | listener 可以是 async、可以 await 外部决定吗 | **可以，而且这正是它的设计用途**：registry 用 `await this.ctx.waterfall(...)` 等它 | `lib/index.js:3321`；运行时已验证（listener 里 `await 300ms`，整调用 ≥300ms 通过） |
| 4c | 必须观察 `exec.signal` 吗 | **必须**。registry 在 gate settle 之后才复查取消，**从不中止你的 promise**；不观察 signal 且永不 resolve ⇒ 该次工具调用**永久挂死** | `index.d.ts:37-47`（"the registry rechecks cancellation after they settle but never abandons their promise"）；运行时已验证：永不 resolve 的 listener 让调用 2s 后仍 `STILL-PENDING` |
| 4d | 一直不 resolve 会超时吗 | **不会**。`timeoutMs` 由 `@deepseek-ai/dsh-tool-call-timeout-policy` 在 **`tools/execute`**（pre-execute 的**下游**）实现，管不到 gate | `dsh-tool-call-timeout-policy/lib/index.js:116`（`ctx.on("tools/execute", ...)`）；`dsh-base/cordis.patch.yml:408-409` |
| 4e | 决策种类 | `allow` / `deny{reason, info?}` / `cancel` / `ask{reason?, displayReason?}` | `index.d.ts:445-460` |
| 4f | `guard` 何时跑、能否被后置 listener 翻案 | 在**所有** `tools/pre-execute` listener 之后、工具体之前跑；同步；只有 "deny 原因"，没有 "allow" 返回值 ⇒ 结构上不可能被翻案 | `index.d.ts:514-522,646-656`；`lib/index.js:3337`；运行时已验证 guard 拒绝 |
| 4g | `restrict` 在 plain ctx 上会怎样 | 抛 `Error`：`tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead` | `lib/index.js:2993`；`index.d.ts:645`；运行时已验证原文一致 |
| 4h | `ask` 的"缺 approval 支持就变拒绝"具体是什么 | `ctx.get('approval')` 拿不到 → deny（reason 用 `ask.reason` 或 `... requires approval (not yet supported)`）；`exec.agent === undefined` → deny；`allowed-once` 才 allow，`rejected/cancelled/unavailable` 各自 deny 并给不同文案 | `lib/index.js:3535-3587`；运行时已验证：无常驻 approval 服务时 `ask` 变成 `isError: true, error.message === 'need a human'` |
| 4i | 谁提供 approval 支持 | 服务 = `@deepseek-ai/dsh-user-approval`（`ApprovalService.request()`）；**answerer 是另一个人**：谁注册 `approval/request` waterfall listener 谁才算 | `dsh-user-approval/lib/types/index.d.ts:135`；`dsh-user-approval/lib/types/types.d.ts`（`Events['approval/request']`） |
| 4j | SDK profile 里有 approval 吗 | **`sdk` profile（dsh-base 之上）有服务、没 answerer**（`dsh-base/cordis.patch.yml:259-262` 只组合服务，无任何 `approval/request` listener）；**`sdk-minimal` 连服务都没有**（整棵 Cordis 树里没有任何 approval 行） | `dsh-base/cordis.patch.yml:259-262`；`dsh-sdk-minimal/cordis.patch.yml`（全文；grep `approval` 无命中） |
| 4k | 非交互运行时里 `ask` 有机会被批准吗 | **不能**。没有 answerer ⇒ `unavailable` ⇒ deny。要"等人批"，只能自己在 `pre-execute` 里等外部信号然后返回 `allow/deny`，**不要**返回 `kind:'ask'` | `lib/index.js:3551-3584`；`dsh-user-approval` 的 fail-closed 契约；本报告 §5.4 |
| 4l | `ctx.effect` 精确 API | `effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>`（同步变体返回 `Disposable<Promise<void>>`）；disposer 在 fiber unload 时**逆序**执行，可 async | `cordis/lib/types/fiber.d.ts:157-159`；`fiber.d.ts:36-51` |
| 5a | `ToolExecution` 有哪些字段 | `callId`、`rootCallId`、`name`、`schema?`、`arguments`、`agent?`、`parent?`、`signal`、`token` | `index.d.ts:216-296` |
| 5b | `Agent` 暴露什么 | 公开面只有 `id: SessionId`；运行时 augment 出 `options/session/inbox/status/ctx/cancel/whenIdle/runMaintenance/send/followup/steer/inject` | `dsh-agent/lib/types/types.d.ts:19-22`；`dsh-agent/lib/types/runtime-types.d.ts`（`declare module './types.ts' { interface Agent … }`） |
| 5c | 有业务元数据通道吗（userId / agentVersion） | **没有**。`Agent`/`SessionHeader` 都是封闭字段集，塞不进自定义键。唯一稳定身份 = `agent.session.id` + `header.cwd` + `header.agentPreset` | `dsh-session/lib/types/types.d.ts`（`SessionHeader`）；`dsh-session/lib/types/index.d.ts`（`Session.header`） |
| 5d | 那业务上下文怎么传 | **按 sessionId 落盘的 policy/session 快照文件**（+ 进程级 env 做默认值与总闸）。理由见 §6.3 | 本报告 §6.3 |
| 6a | 能拿到"开始/决策/完成/错误/耗时"吗 | 开始+决策 = `tools/pre-execute`；耗时 = 自己包 `tools/execute`；结果 = `tools/post-execute` / `tools/result`。**没有内建 duration 字段** | `index.d.ts:36-103`；§7 |
| 6b | `tools/result` listener 能抛/能阻塞吗 | **都不能**。它是 `emit` 语义：同步逐个调用；同步 throw 被 catch，返回的 promise 拒绝被 `.catch` 记 `logger.warn`；结果早已冻结 | `index.d.ts:92`（`@mode emit`，"Listener failures are contained"）；`lib/index.js:3505-3521`（`notifyResult`）；运行时已验证（observer 抛错后调用照常成功） |
| 6c | `tool/call` / `tool/result` 是 SDK 可用的持久事件吗 | **是**，都在 `SessionEventMap` 里（payload 精确字段见 §7.3）。但**写它们的是 agent loop，不是 registry** | `dsh-session/lib/types/types.d.ts:355-389` |
| 6d | 策略拒绝会不会掩盖"工具不存在" | **会**。pre-execute 在 `resolveExecution` 之前跑，策略 deny 时未知工具也报策略原因 | `lib/index.js:3321`（gate）vs `:3403`（`resolveExecution`）；运行时已验证 |
| 7a | 两个 skeleton 能编译吗 | **能**：`tsc -p tsconfig.json --noEmit` → `EXIT=0`（`typescript@5.9.3` + 真实 `0.2.1-rc.3` 包） | `.tmp\toolcheck\` |
| 7b | 类型坑 | `output.schema` 推出的数组是**可变** `T[]`；返回类型写成 `readonly T[]` 会报 `TS2719 ... 'readonly' and cannot be assigned to the mutable type` | 实测报错与修复（skeleton B 注释） |

---

## 2. Q1 —— `defineTool(...)` 精确签名与声明方式

### 2.1 签名（原文）

```ts
// dsh-tools/lib/types/schema.d.ts:248
export declare function defineTool<
  const S extends ParameterSchemaSpec,
  const O extends ValueSchemaSpec,
>(options: DefineToolOptions<S, O>): ToolDefinition
```

`const` 泛型参数意味着对象字面量会被深推导成字面量类型，**不需要写 `as const`**（`dsh-tool-todo` 也没写）。

### 2.2 `DefineToolOptions`（原文裁剪，`schema.d.ts:178-240`）

```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    /** Tool name (must be unique). */
    readonly name: string;
    /** Human-readable description sent to the model. */
    readonly description: string;
    /** Per-property parameter schema compiled to an implicit open object root. */
    readonly parameters: S;
    /** Canonical output schema plus pure Native and presentation projections. */
    readonly output: {
        /** Schema enforced against every successful body or policy-replaced value. */
        readonly schema: O;
        /** Pure Native/model rendering of one validated canonical value. */
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        /** Pure replayable presentation metadata for native and nested calls. */
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    readonly deferLoading?: true;
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}
```

要点：

- `output` 是**必填**，`schema` 与 `render` 都**不是可选**。唯一可选的是 `presentationMeta`。
- `execute` 的入参类型由 `parameters` 推导（`InferArgs<S>`），返回值类型由 `output.schema` 推导（`InferValue<O>`）——**签名里没有 `unknown`**，这是 `defineTool` 相对裸 `ToolDefinition` 的最大价值。
- `exec` 是 `ToolRunContext`（= `ToolExecution` + `deferContext()` + `concludeTurn()`，`index.d.ts:305-322`）。
- `presentCall` / `presentResult` 是**回放**用的纯函数；`defineTool` 会给它们套一层"软校验"，参数对不上旧 schema 就返回 `undefined` 退回通用卡片，而不是抛 `ToolArgsError`（`schema.js:328-345`）。

### 2.3 参数 DSL 全貌（`schema.d.ts:9-84`）

```ts
export interface ValueSchemaAnnotations {
    description?: string; title?: string; default?: JsonValue; examples?: JsonValue;
}
export interface StringValueSchemaSpec  extends ValueSchemaAnnotations { type: 'string';  enum?: readonly string[];  const?: string }
export interface NumberValueSchemaSpec  extends ValueSchemaAnnotations { type: 'number';  enum?: readonly number[];  const?: number }
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations { type: 'integer'; enum?: readonly number[];  const?: number }
export interface ArrayValueSchemaSpec   extends ValueSchemaAnnotations { type: 'array';   items?: ValueSchemaSpec }
export interface ObjectValueSchemaSpec  extends ValueSchemaAnnotations {
    type: 'object';
    properties?: ParameterSchemaSpec;
    additionalProperties: boolean;          // ← 必填，强制表态开放/封闭
}
export interface OneOfValueSchemaSpec   extends ValueSchemaAnnotations {
    oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]];   // ← 至少 2 个分支
}
export type ValueSchemaSpec = /* 上面全部 | Boolean | Null | JsonValueSchemaSpec */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true };
export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec; [key: symbol]: never };
```

**关键限制：没有数值/字符串边界。** `NumberValueSchemaSpec` 只有 `enum` / `const`。所以"`days`: 1..30"只能在 `execute` 里断言（skeleton B 就是这么写的，并注释了原因）；ALTERNATIVE 是 `enum: [1,2,...,30]`，但那会把 30 个值全塞进 JSON Schema，不推荐。

### 2.4 五种声明方式的精确写法

```ts
parameters: {
  // ① 必填字符串
  stationId: { type: 'string', required: true, description: 'Station id.' },

  // ② 必填整数（范围在 execute 里自查；DSL 无 min/max）
  days: { type: 'integer', required: true, description: 'Trailing days (1..30).' },

  // ③ 枚举
  granularity: { type: 'string', enum: ['hourly', 'daily'] },

  // ③b 精确一 union（≥2 分支）
  window: {
    oneOf: [
      { type: 'string' },
      { type: 'object', additionalProperties: false,
        properties: { from: { type: 'string', required: true },
                      to:   { type: 'string', required: true } } },
    ],
  },

  // ④ 可选 = 不写 required
  note: { type: 'string', description: 'Optional free text.' },
}
```

推导结果（TS 实测，`InferArgs`）：

```ts
// args: {
//   stationId: string;
//   days: number;
//   granularity?: 'hourly' | 'daily';
//   window?: string | { from: string; to: string };
//   note?: string;
// }
```

对象/数组返回值（`output.schema`）：

```ts
output: {
  schema: {
    type: 'object',
    additionalProperties: false,           // 必填
    properties: {
      stationId: { type: 'string', required: true },
      days:      { type: 'integer', required: true },
      samples: {
        type: 'array', required: true,
        items: { type: 'object', additionalProperties: false,
                 properties: { day: { type: 'string', required: true },
                               value: { type: 'number', required: true } } },
      },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}
```

> **坑（实测）**：`InferValue` 推出的是可变数组 `{...}[]`。如果像正常人那样把返回类型标成 `readonly { readonly day: string ... }[]`，
> `execute` 会报 `TS2719: ... 'readonly' and cannot be assigned to the mutable type`。skeleton B 最终用的是可变数组字段。

### 2.5 `render(args, value)` 的 `ContentBlock[]` 到底该长什么样

`ContentBlock = ContentBlockMap[ContentBlockType]`（`dsh-llm/lib/types/types.d.ts`），词表：

```ts
export interface ContentBlockMap {
    'text': TextBlock;            // { type: 'text'; text: string }        ← 唯一你自己能安全造出来给模型看的
    'reasoning': ReasoningBlock;
    'image': ImageBlock;          // 需要 attachment 服务签发的 ImageAttachmentRef
    'file': FileBlock;            // 需要 FileAttachmentRef
    'tool-call': ToolCallBlock;
    'tool-addition': ToolAdditionBlock;
    'tool-removal': ToolRemovalBlock;
}
export type ContentBlock = ContentBlockMap[ContentBlockType];
```

实践约定（`dsh-tool-todo/lib/index.js:165-168` 与 `defineContentToolFixture`）：

- 业务工具只返回 `[{ type: 'text', text }]`；结构化信息走 `value`（canonical value），不要塞进 content。
- `render` 必须**纯**：不得读文件、不得读时钟、不得有副作用。理由不是风格问题——`output.schema` 被声明为
  "enforced against every successful body **or policy-replaced value**"（`schema.d.ts:187-188`），
  即同一个 canonical value 可能在策略替换后被重新投影，`render` 必须可重入且结果稳定。
- `render` 抛错会冒泡成**该次工具调用的失败结果**（`isError: true`），不是"渲染降级"；
  而返回值不满足 `output.schema` 时抛的是 `ToolOutputError`（`index.d.ts:406-411`）。

---

## 3. Q2 —— 参数校验发生在哪一层

### 3.1 只有 `defineTool` 的 wrapper 校验

```js
// dsh-tools/lib/types/schema.js:315-320
async execute(args, exec) {
    const violations = validate(args);
    if (violations.length > 0)
        throw new ToolArgsError(violations);
    return userExecute(args, exec);
}
```

`validate` 就是把 `parameters` 编译成 JSON Schema 后跑 `validateJsonSchemaValue`（`schema.js`：`const validate = (args) => validateJsonSchemaValue(parameters, args, '')`）。
所以校验的**唯一触发点是"工具体被调用"**——即 pre-execute 通过、guard 通过、`tools/execute` wrapper 也放行之后。

**推论（对策略插件很重要）**：`tools/pre-execute` 拿到的 `exec.arguments` 是未经 schema 校验的原始值。
你在 gate 里读 `exec.arguments` 必须按 `unknown` 处理，不能假设形状。

### 3.2 错误类型

```ts
// dsh-tools/lib/types/schema.d.ts:165-169
export declare class ToolArgsError extends HarnessError {
    readonly violations: string[];       // schema-walk 顺序的路径限定违规串
    constructor(violations: string[]);
}
```

运行时实证：`message = "invalid arguments: <v1>; <v2>"`，`code = 'INVALID_ARGS'`，`name = 'ToolArgsError'`。
`HarnessError` 本体见 `dsh-llm/lib/types/error.d.ts`（`readonly code: string`）。

### 3.3 registry 只校验"注册形状 + 输出值"

```js
// dsh-tools/lib/index.js:2974-2983
register(definition) {
    const output = definition.output;
    if (output === void 0 || typeof output !== 'object' || typeof output.render !== 'function' || ...)
        throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
    assertSupportedJsonSchema(output.schema);
    if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
        throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
    if (name === 'run_code') throw new Error(...);
    return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: 'tools.register()' });
}
```

入参**完全不校验**。手写 `ToolDefinition`（不从 `defineTool` 出来）会跳过所有入参校验，直接进 `execute(args: unknown, ...)`。

---

## 4. Q3 —— 注册、作用域、插件模块形状

### 4.1 `ctx.tools.register(definition)`

```ts
// dsh-tools/lib/types/index.d.ts:631-656
/**
 * Register globally or in the calling agent scope. Scoped tools shadow
 * globals; duplicates within one layer and the reserved `run_code` name fail.
 * @returns the exact disposer that unregisters the tool.
 */
register(definition: ToolDefinition): () => void;
restrict(filter: ToolRestriction): () => void;
guard(guard: ToolGuard): () => void;
```

作用域规则（实现见 `lib/index.js:2982`：`this.layers.effect(this.ctx, ...)`）：

| 调用者 ctx | 落到哪层 | 可见性 |
|---|---|---|
| 普通 plugin ctx（进程级） | **global layer** | 所有 agent，除非被 per-agent `restrict` 屏蔽 |
| `agent.ctx` | 该 agent 的 **scoped layer** | 只有该 agent；**覆盖**同名 global；`restrict` 摘不掉自己层的东西 |

运行时实证（smoke5）：

- 注册 `run_code` → `Error: tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`
- 同层重名 → `Error: tool "dup" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
- 缺 `output` → `TypeError: tool "bad" must declare output { schema, render, presentationMeta? }`
- `dispose()` 之后 `ctx.tools.get('tmp') === undefined`

### 4.2 真实的工具插件模块形状（`@deepseek-ai/dsh-tool-todo`，已解包实读）

`lib/index.js` 的导出（`dsh-tool-todo/lib/index.js:11-12,196`）：

```js
const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
const Config = z.object({ allowParallelInProgress: z.boolean().required() });

function apply(ctx, config) { /* … ctx.tools.register(defineTool({...})) … */ }

export { Config, apply, inject, name };
```

`lib/types/index.d.ts`：

```ts
export declare const name = "tool-todo";
export declare const inject: string[];
export interface Config { allowParallelInProgress: boolean }
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
```

`package.json`（要点）：

```json
{
  "name": "@deepseek-ai/dsh-tool-todo",
  "version": "0.2.1-rc.3",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" } },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/cordis": "~4.0.5"
  }
}
```

Cordis 侧认可的插件字段（`cordis/lib/types/registry.d.ts`，`Plugin.Base`）：

```ts
interface Base<T = any> {
    name?: string;                       // fiber 诊断名 / logger 名
    Config?: StandardSchemaV1<any, T>;   // 启动前校验 config
    inject?: Inject;                     // 必需服务；全部就绪才 load
    provide?: string | string[];         // 服务名
    intercept?: Dict<boolean>;
}
```

**`reusable` 不存在**——`4.0.5` 的 `registry.ts` / `fiber.ts` / `utils.ts` 里没有任何 `reusable`
（grep 全解包目录只命中自然语言散文）。任务书里提到的 `reusable` 在本版本不可用，标 `未验证/不存在`。

### 4.3 HMR / 卸载

- `ctx.on(...)` 返回的监听器、`ctx.tools.register/guard/restrict` 返回的 disposer **都已经是 fiber-owned effect**：
  fiber unload（含 HMR）时自动逆序执行，插件不需要手动收集。
- 只有**不经过 ctx 的资源**（`setInterval`、`fs.watch`、socket、外部进程）需要 `ctx.effect(...)` 包一层（§5.5）。

---

## 5. Q4 —— 策略钩子

### 5.1 `tools/pre-execute`（waterfall）

```ts
// dsh-tools/lib/types/index.d.ts:36-47
/**
 * Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow;
 * `cancel` selects the canonical pre-dispatch cancellation result, and missing
 * approval support turns `ask` into denial. Async gates must observe
 * `exec.signal`; the registry rechecks cancellation after they settle but
 * never abandons their promise.
 * Scope-filtered dispatch (@deepseek-ai/dsh-scope): agent-scoped listeners receive only that agent's calls.
 * @mode waterfall
 */
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
```

```ts
// dsh-tools/lib/types/index.d.ts:445-460
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } };
```

**`next()` 精确语义**（`cordis/lib/types/events.d.ts:66-79`）：

```ts
/**
 * Dispatch an event whose last argument is a `next` continuation.
 * Each listener wraps the rest of the chain: calling `next()` invokes the
 * next listener (finally the built-in behavior); not calling it vetoes.
 */
waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>;
```

registry 传入的最内层 `next` 是 `() => Promise.resolve({ kind: 'allow' })`（`lib/index.js:3321`）。
所以：

- 调 `next()` = 让**后面所有** listener 继续跑，最终结论是它们给出的（默认 allow）。
- 不调 `next()` 直接 return = **短路整条链**，后面的 listener 永远不会执行（运行时已验证）。

**正确写法**：先 `await next()`，只在下游不是 `deny`/`cancel` 时才叠加自己的策略（保证单调）。

**async + 等外部决定：可行，且是官方设计意图。**

```js
// dsh-tools/lib/index.js:3319-3338（原文）
try {
    const carrier = scopeTarget(this, exec.agent);
    const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
    const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : { decision: gate, approvalCancelled: false };
    const { decision } = askResolution;
    if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({ ... toolAbortedBeforeDispatchResult() });
    if (decision.kind === "cancel") return await next({ ... });
    const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
    ...
```

- `await` 是真的 `await`：listener 里等文件/等 HTTP/等 DB 都会被尊重（运行时已验证：300ms 延迟体现在总耗时上）。
- **没有任何超时**：`timeoutMs` 属于 `tools/execute` 那一层（`dsh-tool-call-timeout-policy/lib/index.js:116`），
  在 gate **下游**。所以 gate 必须自己收尾。
- **必须观察 `exec.signal`**：registry 只在你 settle 之后复查 `callerCancelled(exec)`，不会替你 abort。
  运行时已验证：永不 resolve 的 listener → 调用 2 秒后仍 `STILL-PENDING`（即用户看到工具卡死）。
- 拒绝结果的物化形态（`lib/index.js:3339-3353`）：`content = [{type:'text', text:'Error: ' + reason}]`、
  `isError: true`、`error = { message: reason, info? }`。`info` 里的 `reason`（用户向细节）**不进模型内容**。

### 5.2 `ctx.tools.guard(...)`

```ts
// dsh-tools/lib/types/index.d.ts:514-522
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
```

- **同步**（返回 `string | undefined`，不是 Promise）。所以在里面只能做同步 I/O（`readFileSync` 可以，`await` 不行）。
- 顺序：`pre-execute` 全部跑完 → （若 `ask` 走 approval）→ `guardReason(exec)` → 工具体（`lib/index.js:3337-3362`）。
- 幂等/单调：没有任何 "allow" 返回值，晚注册的 guard 只能更严。global guard 先跑，再沿 agent 作用域链从**最远**到最近（`lib/index.js:3024-3032`）。
- 抛错会怎样：`prepareExecution` 整体在 try/catch 里，抛错 → `toolErrorResult(error)`（`lib/index.js:3363-3368`）⇒ 变成 `isError` 结果，不是崩溃；但**别依赖它**（诊断信息会变成一个普通工具错误）。

### 5.3 `ctx.tools.restrict({ allow, deny })`

plain context 上调用，运行时抛出的**原文**：

```
tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead
```

（`dsh-tools/lib/index.js:2993`；smoke4 已验证逐字一致）

其余失败条件（同文件 `2996-3004`）：

| 输入 | 错误 |
|---|---|
| `{}`（allow/deny 都缺） | `tools.restrict({}) is a no-op: pass \`allow\` and/or \`deny\` (an empty filter is almost always a materialized-empty-config bug)` |
| 含 `run_code` | `tools.restrict() cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability tools instead` |
| 未知工具名 | `tools.restrict() names unknown global tool "x"; known global tools: …` |

语义：restrict 只过滤**继承来的**全局层；它自己的 scoped 注册不受影响；多个 restriction 取**交集**。

### 5.4 `ask` 与 approval：为什么不能直接用 `kind:'ask'`

```js
// dsh-tools/lib/index.js:3535-3587（原文裁剪）
async serviceAsk(exec, ask) {
    const approval = this.ctx.get("approval");
    if (approval === void 0) return { decision: { kind: "deny",
        reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` }, approvalCancelled: false };
    if (exec.agent === void 0) return { decision: { kind: "deny",
        reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` }, ... };
    const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, ..., signal: exec.signal });
    switch (outcome) {
        case "allowed-once": return { decision: { kind: "allow" }, ... };
        case "rejected":     return { decision: { kind: "deny", reason: `the user rejected tool "${exec.name}"` }, ... };
        case "cancelled":    return { decision: { kind: "deny", reason: `approval for tool "${exec.name}" was cancelled` }, approvalCancelled: true };
        case "unavailable":  return { decision: { kind: "deny", reason: `tool "${exec.name}" requires approval, but no approval channel is available` }, ... };
    }
}
```

链路事实：

1. **服务**：`@deepseek-ai/dsh-user-approval` 提供 `ctx.approval`（`ApprovalService.request(req): Promise<ApprovalOutcome>`，
   `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，`dsh-user-approval/lib/types/index.d.ts:135`）。
2. **answerer**：只有注册 `approval/request` waterfall listener 的人才会真正回答：
   `'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>`（`dsh-user-approval/lib/types/types.d.ts`）。
   **谁都不注册 ⇒ `next()` 落到 fail-closed 的 `unavailable`。**
3. **profile 事实**：
   - `sdk` profile = `@deepseek-ai/dsh-sdk-app` over `dsh-base`；`dsh-base/cordis.patch.yml:259-262` 只组合了 approval **服务**，
     全文没有任何 `approval/request` listener ⇒ answerer 缺失 ⇒ 恒 `unavailable` ⇒ 恒 deny。
   - `sdk-minimal` 的 Cordis 树是**完整平铺**的（`dsh-sdk-minimal/cordis.patch.yml` 自述 "this insert is the complete Cordis tree"），
     grep `approval` **零命中** ⇒ 连 `ctx.approval` 都没有 ⇒ 走 `serviceAsk` 第一个分支，deny。
4. 因此：**非交互运行时里 `ask` 永远拿不到批准。** 想让"等人批"生效，必须自己在 `tools/pre-execute`
   里等外部信号，然后返回 `allow` / `deny`（skeleton A 的 `awaitVerdict`）。
   这样做的额外好处：获批时是 `allow` 而不是 `allowed-once`，不会把审批职责泄漏给不存在的 UI。

> 顺带：`approval/asked` / `approval/decided` 是**持久审计事件**（`dsh-user-approval/lib/types/types.d.ts`），
> 但它们只有在走 `ApprovalService` 时才产生。自建 fail-closed 审批要自己写审计（§8）。

### 5.5 `ctx.effect(...)` 与 HMR 清理

```ts
// cordis/lib/types/fiber.d.ts:144-159
/**
 * Register a cleanup-aware effect on this fiber.
 *
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
 * already disposed, and `TypeError` if `execute` returns an invalid shape.
 */
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>;
```

```ts
// cordis/lib/types/fiber.d.ts:36-51
export type Disposable<T = any> = () => T;
export type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>;
type SyncEffect<T = any> = Disposable<T> | Iterable<Disposable<T>, void, void>;
type AsyncEffect<T = any> = Promise<Disposable<T>> | AsyncIterable<Disposable<T>, void, void>;
```

`ctx.effect` 来自 `Context extends Pick<Fiber, 'effect'>`（`fiber.d.ts:7-12`）。

用法（skeleton A 的轮询定时器）：

```ts
ctx.effect(() => {
  const timer = setInterval(refresh, 5_000)
  return () => { clearInterval(timer) }        // ← HMR unload / fiber dispose 时自动跑
}, 'agent-policy:snapshot-poll')
```

**不需要**为监听器手写清理：`ctx.on(...)` 的 disposer 已经挂在 fiber 上（`events.d.ts:80-88,190-197`）。
需要 `ctx.effect` 的只有"不是通过 ctx 注册的资源"。

---

## 6. Q5 —— 钩子里能拿到的身份

### 6.1 `ToolExecution`（原文，`index.d.ts:216-296`）

```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly schema?: ToolSchema;           // PTC 内层调用才有，永不入日志
    readonly arguments: unknown;            // 未校验的原始参数
    readonly agent?: Agent;
    readonly parent?: ToolExecutionToken;   // PTC 子派发才有
    readonly signal: AbortSignal;           // 必需，caller-owned
}
export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: ToolCallId;        // 被解析成必填
    readonly token: ToolExecutionToken;     // symbol brand，registry 分配
}
```

`arguments` 在进入 policy 前经过一次 lossless-JSON 物化并被**深冻结**（`index.d.ts:275-281` 注释）。
`token` 是 `symbol & { brand }`：**不可 JSON 序列化**，审计里不要写它，用 `callId` 消歧。

### 6.2 `Agent`（公开面 + 运行时 augment）

```ts
// dsh-agent/lib/types/types.d.ts:19-22
/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
    /** Session-backed Agent identity. */
    readonly id: SessionId;
}
```

```ts
// dsh-agent/lib/types/runtime-types.d.ts —— declare module './types.ts' { interface Agent { … } }（裁剪）
declare module './types.ts' {
    interface Agent {
        readonly options: AgentOptions;      // provider / model / reasoningEffort / maxTokens
        readonly session: Session;           // 该 agent 驱动的活会话（持久事实之源）
        readonly inbox: Inbox;               // nextTurn / nextStep 待处理消息
        readonly status: AgentStatus;        // 'idle' | 'running'
        readonly ctx: Context;               // agent 作用域上下文（restrict/guard/register 走这里）
        cancel(cause: AgentCancelCause, options?: CancelOptions): void;
        whenIdle(): Promise<void>;
        runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
        send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
        followup(message: UserMessage): void;
        steer(message: UserMessage): void;
        inject(message: UserMessage): void;
    }
}
```

`AgentRegistry`（`ctx.agents`）还有 `get(id)` / `list()` / `roots()` / `currentInitiator()`，但**都不是授权依据**
（`dsh-agent/lib/types/index.d.ts:186-253` 明确写："Ambient presence is neither liveness proof nor authorization"）。

### 6.3 业务上下文（userId / agentVersion）怎么传 —— 没有现成通道

**结论：没有自由元数据字段。** 证据：

- `Agent` 是封闭接口，仅有 `id` + 上面那些能力，没有 `meta`。
- `SessionHeader`（`dsh-session/lib/types/types.d.ts`）字段是**封闭集合**，且被 `Session` 构造时验证并深冻结：

```ts
export interface SessionHeader {
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: SessionId;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly isSeeded: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;      // ← 唯一"像业务标签"的字段
}
```

- `Session.append()` 只接受 `SessionEventMap` 里已声明的 `type`（可通过 `declare module` 扩展，但那是**会话事件**，
  不是 agent 元数据，而且无法在建会话之前注入）。

**可用身份三件套**（每个 hook 都有）：`exec.agent?.id`（= sessionId）、`exec.agent?.session.header.cwd`、
`exec.agent?.session.header.agentPreset`。

**推荐方案（按稳健性排序）**：

| 方案 | 可行性 | 说明 |
|---|---|---|
| **① 按 sessionId 落盘的 policy 快照**（推荐） | ✅ | 网关在发起 turn 前写 `<policyDir>\sessions\<sessionId>.json`（含 userId / agentVersion / allow / deny / requireApproval）；插件用 `exec.agent.id` 拼路径同步读。**唯一能真正区分同进程内不同 session 的通道**，因为 sdk profile 一个进程多 session（`session/prompt` 的 `sessionId` 是参数）。 |
| ② 进程级 env（`DSH_POLICY_*`） | ⚠️ 仅作默认值/总闸 | env 是进程级的；一个 runtime 进程可承载多个 session，所以 env 无法表达 per-session 策略。但如果部署模型是"一 agent 一子进程"，env 足够；把它做**兜底默认 + kill switch** 最稳。 |
| ③ per-process 单例 Map | ⚠️ 仅作缓存 | 进程内 `Map<sessionId, Snapshot>`，由 ① 的文件装载填充，避免每次调用都做同步 I/O。不是真相源，HMR reload 会丢。 |
| ④ `SessionHeader.agentPreset` | ⚠️ 语义借用 | 能承载"策略档位名"，但它是**持久化且不可变**的；用来表示会变的 userId 是滥用，且需要改 `session.meta` 的写入方，不在插件职责内。 |

skeleton A 用 ①（`snapshotPath` + `revocationPath` + `approvalDir`），并用 ③ 做读缓存：`ctx.effect` 里每 5s 刷新，
另外 guard 里**每次**都同步重读 revocation 文件（撤销必须立刻生效，不能等缓存）。

---

## 7. Q6 —— 审计：能拿到什么

### 7.1 事件与阶段对照

| 阶段 | 可用钩子 | 能否异步 | 能否改变结果 | 拿到什么 |
|---|---|---|---|---|
| 调用开始 + 决策 | `tools/pre-execute`（waterfall） | ✅ | ✅ 只能 allow/deny/cancel/ask | `exec`（含 `arguments`、`agent`） |
| 最终拒绝（guard） | 无独立钩子；拒绝原因在 `tools/result` 的 `error.message` 里 | — | — | `error.message` 就是 guard 返回的字符串（运行时已验证） |
| 派发前后 / 计时 | `tools/execute`（waterfall，可换 `exec.signal`） | ✅ | ✅ 可包 `next()` 计时/重试/超时 | `ToolDispatchExecution` |
| 结果整形 | `tools/post-execute`（waterfall） | ✅ | ✅ accept/block | `(exec, result, next)` |
| 最终结果（只读） | `tools/result`（**emit**） | ❌ 不等待 | ❌ 完全不能 | 冻结的 `exec` + 冻结的 `result` |
| 持久事实 | 会话日志 `tool/call`、`tool/result` | — | — | 见 §7.3 |

```ts
// dsh-tools/lib/types/index.d.ts:413-435
export interface ToolExecutionSuccess {
    readonly isError: false;
    readonly value: JsonValue;              // 执行期值；"deliberately omitted from durable events"
    readonly content: ContentBlock[];
    readonly error?: never;
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    readonly concludesTurn?: true;
}
export interface ToolExecutionFailure {
    readonly isError: true;
    readonly error: ToolFailure;            // { message: string; info?: { name, code, reason? } }
    readonly value?: never;
    readonly content: ContentBlock[];
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
}
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure;
```

**没有内建 duration**。审计插件要自己计时：在 `tools/execute` 里包 `next()`，或在 `pre-execute` 记 `Date.now()`、
在 `tools/result` 按 `callId` 配对（注意：`tools/result` 只在**结束**时来一次，`pre-execute` 的 deny 也会走到它）。

### 7.2 `tools/result` 是 emit：不能抛、不能阻塞

```ts
// dsh-tools/lib/types/index.d.ts:85-92
/**
 * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
 * @mode emit
 */
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined;
```

```js
// dsh-tools/lib/index.js:3505-3521（原文）
notifyResult(exec, result) {
    Object.freeze(exec);
    const { name: toolName, callId } = exec;
    const reportFailure = (error) => { this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`); };
    const callbacks = this.ctx.events.dispatch("emit", [ scopeTarget(this, exec.agent), "tools/result", exec, result ]);
    for (const callback of callbacks) try {
        const returned = callback(exec, result);
        Promise.resolve(returned).catch(reportFailure);
    } catch (error) { reportFailure(error); }
}
```

运行时实证（smoke3）：

- `tools/result` 在 **allow / deny / 未知工具** 三种情况下**都**触发（3/3）。
- observer 里 `throw` 后，调用方拿到的结果**不受影响**（`allowed: false` 正常返回），只多一条 `logger.warn`。
- `exec` 在 observer 里 `Object.isFrozen(exec) === true`。
- 成功结果 `Object.keys(result)` = `['isError','content','value']`；失败 = `['isError','error','content']`。

⇒ 审计**可以**在 `tools/result` 里做同步写盘，但**不要**在那里做慢 I/O：它是同步 emit，会阻塞整个工具流水线的收尾；
用内存队列 + 异步 flush（flush 失败也只能丢日志，不能反压调用）。

### 7.3 持久会话事件（`SessionEventMap`）

两者都在 `SessionEventMap` 里（`dsh-session/lib/types/types.d.ts:355-389`）：

```ts
'tool/call': {
    turn: number;
    step: number;
    callId: ToolCallId;
    name: string;
    arguments: string;        // ← 模型原始 JSON 字符串（未解析！）
};
'tool/result': {
    turn: number;
    step: number;
    message: ToolResultMessage;   // { role:'tool', toolCallId, isError?, content, source, id, ... }
    error?: { name: string; code: string; reason?: string };   // 仅 isError:true 时允许
    meta?: JsonValue;             // 工具私有展示载荷，必须 JSON 可序列化
};
```

另有两个相关事件：`tool/ptc-dispatch`（PTC 子派发，`known-event-types.js:75`）、
`approval/asked` / `approval/decided`（`dsh-user-approval/lib/types/types.d.ts`）。

**重要区分**：这两个事件由 **agent loop** 在派发前后写入，**不是 tool registry 写的**。
所以：

- 想要"已有审计"⇒ 直接读会话 JSONL，不要重复写 `tool/call`。
- 想要自定义字段 ⇒ ① 写自己的 JSONL，或 ② `declare module '@deepseek-ai/dsh-session/types'` 扩展一个新事件名
  （`Session.append` 的 `T extends SessionEventType` 是 merge-extensible 的），或 ③ 用 `exec.agent?.session.append(...)`
  写一个**已声明**的事件。②③ 都是插件能做但会污染会话日志的选择，本报告推荐 ①。

### 7.4 拒绝优先于"工具不存在"（审计时别误判）

`prepareExecution` 先跑 gate（`lib/index.js:3321`），`resolveExecution`（未知工具判定）在 `dispatchToolBody` 里
（`lib/index.js:3403`）。运行时实证：对一个**根本没注册**的名字返回策略 deny 时，得到的是
`PolicyError/POLICY_DENIED`，而不是 `UNKNOWN_TOOL`。审计记录里要能区分"策略拒绝"和"名字不存在"，
只能靠 `error.info.code`（`UNKNOWN_TOOL` vs 你自己的 code）。

---

## 8. Audit record shape（审计插件应写的 JSONL 字段）

只写**实际拿得到**的字段，不发明。来源标注在每行注释里。

```jsonc
{
  "schemaVersion": 1,                     // 自己维护
  "ts": "2026-10-25T14:31:02.512Z",       // Date.now()，插件本地
  "event": "tool.decision",               // "tool.start" | "tool.decision" | "tool.end"

  // ── 身份：全部来自 exec ─────────────────────────────────────────
  "sessionId": "session-42",              // exec.agent?.id（Agent.id: SessionId）
  "agentPreset": "restricted-analyst",    // exec.agent?.session.header.agentPreset ??
  "cwd": "E:\\work\\demo",                // exec.agent?.session.header.cwd ??
  "callId": "call_abc",                   // exec.callId
  "rootCallId": "call_abc",               // exec.rootCallId（PTC 子调用时不同）
  "parent": true,                         // exec.parent !== undefined（PTC 子派发）
  "tool": "query_station",                // exec.name
  "turn": 3, "step": 1,                   // 只有会话事件里有；钩子里拿不到 → 可省略
                                          //   （标 unverified：tools/* 钩子无 turn/step）

  // ── 参数：已深冻结，DAR 前必须裁剪 ─────────────────────────────
  "args": { "stationId": "ST-001", "days": 7 },   // exec.arguments（未 schema 校验！）
  "argsBytes": 42,
  "argsTruncated": false,                 // 超过阈值就存 "<omitted:NNN bytes>" 并置 true

  // ── 决策 ──────────────────────────────────────────────────────
  "decision": "deny",                     // "allow" | "deny" | "cancel" | "ask-then-allow" | "ask-then-deny"
  "decisionSource": "guard",              // "allowlist" | "guard" | "revocation" | "approval-file" | "upstream"
  "denyCode": "POLICY_DENIED",            // 自己填 ToolErrorInfo.code；guard 拒绝没有 code → null
  "denyReason": "tool is revoked",        // deny.reason / guard 返回值
  "approval": {                           // 仅自建 fail-closed 审批时
    "waitedMs": 4211, "verdict": "timeout", // "allow" | "deny" | "timeout" | "cancelled"
    "file": "…\\approvals\\call_abc.json"
  },

  // ── 结果 ──────────────────────────────────────────────────────
  "isError": true,                        // result.isError
  "errorName": "PolicyError",             // result.error?.info?.name
  "errorCode": "POLICY_DENIED",           // result.error?.info?.code
  "errorMessage": "tool is revoked",      // result.error?.message（模型看到的内容去掉 "Error: " 前缀）
  "contentBytes": 128,                    // JSON.stringify(result.content).length
  "hasMeta": false,                       // result.meta !== undefined
  "durationMs": 4211,                     // 自己在 tools/execute 包 next() 或 start/end 配对
  "aborted": true                         // exec.signal.aborted
}
```

实践约束（都有出处）：

1. **不要写 `exec.token`**：`symbol` brand，JSON 序列化会丢（`index.d.ts:206-210`）。
2. **不要写 `result.value`**：文档明确它是 execution-local，durable 投影里刻意省略（`index.d.ts:415`）。
   要留证据就存 `content` 的字节数/哈希。
3. **参数必须先裁剪**：`exec.arguments` 是模型产出的任意 JSON，可能巨大；且**未经 schema 校验**
   （校验在 `defineTool.execute` 里，晚于 gate）。
4. **`turn`/`step` 在 `tools/*` 钩子里拿不到** —— 它们只在会话事件 `tool/call` / `tool/result` 的 payload 里
   （`dsh-session/lib/types/types.d.ts:355-361`）。要按 turn 归组，就用 `callId` 关联会话日志。
5. **`tools/result` 里只做入队**，同步 emit 会阻塞收尾（`lib/index.js:3505-3521`）。
6. guard 拒绝没有 `ToolErrorInfo`（`prepareExecution` 的 guard 分支只塞 `reason`），所以 `denyCode` 会是 `null`；
   想让审计有稳定 code，就在 `pre-execute` 里 deny 并自带 `info: { name, code }`（smoke3 已验证 `error.info` 会被保留）。

---

## 9. 两个可编译的插件 skeleton

两个文件都已用真实 `0.2.1-rc.3` 包类型检查通过：`tsc -p tsconfig.json --noEmit` → **EXIT=0**（`typescript@5.9.3`）。

### 9.1 落地位置与构建配置（对齐 npm workspaces 平铺布局）

```
plugins/agent-policy/package.json
plugins/agent-policy/tsconfig.json
plugins/agent-policy/src/index.ts
```

`plugins/agent-policy/package.json`（与仓库里已有的草稿一致，只是补 `tsconfig`）：

```json
{
  "name": "@agent-studio/plugin-agent-policy",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "typescript": "^5.9.3"
  }
}
```

`plugins/agent-policy/tsconfig.json`（继承仓库 `tsconfig.base.json`）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

`@deepseek-ai/*` 的类型从根 `node_modules\@deepseek-ai\<pkg>\lib\types\index.d.ts` 解析
（`package.json` 的 `exports.types` 指向它）。npm 平铺布局下**不需要** `paths` 映射。

> 类型检查用的独立 tsconfig（`.tmp\toolcheck\tsconfig.json`）与本 tsconfig 等价，只是把
> `noEmit` 打开、`declaration` 关掉。

### 9.2 Skeleton A —— `plugins/agent-policy/src/index.ts`

编译后**存活**的 import：`node:fs`、`node:path`。
`@deepseek-ai/*` 全部是 `import type`，**编译产物里一条都不剩** ⇒ 不可能误建第二个 Cordis 实例 /
第二个 `ToolRuntime` 镜像。

```ts
/**
 * Skeleton A — `plugins/agent-policy` style plugin.
 *
 * Runtime imports: `node:fs` only. Every `@deepseek-ai/*` import is `import type`,
 * so this file emits no import of cordis / dsh-tools: it can never mint a second
 * Cordis instance or a second `ToolRuntime` mirror.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Plugin display name used by Cordis fiber diagnostics. */
export const name = 'agent-policy'
/** Hard service dependency: the policy is expressed on the tool registry. */
export const inject = ['tools']

/** Deployment config, resolved from the Cordis profile row. */
export interface Config {
  /** Path to the policy JSON snapshot. Defaults to `DSH_POLICY_SNAPSHOT`. */
  readonly snapshotPath?: string
  /** Path to the revocation JSON file, re-read on every decision. Defaults to `DSH_POLICY_REVOCATION`. */
  readonly revocationPath?: string
  /** Work directory where per-call approval verdicts are dropped. Defaults to `DSH_POLICY_APPROVAL_DIR`. */
  readonly approvalDir?: string
  /** Fail-closed wait for one approval verdict, in milliseconds. */
  readonly approvalTimeoutMs?: number
}

/** One immutable policy snapshot on disk. */
interface PolicySnapshot {
  readonly version: 1
  /** Tool names permitted to run. Everything else is denied by the guard. */
  readonly allow: readonly string[]
  /** Tool names denied outright, even when allowlisted. */
  readonly deny?: readonly string[]
  /** Tool names that additionally need an out-of-band human verdict. */
  readonly requireApproval?: readonly string[]
}

/** Revocation payload written by an admin. */
interface Revocation {
  /** Hard kill switch: deny every tool call in this process. */
  readonly all?: boolean
  /** Tools revoked from this moment on. */
  readonly tools?: readonly string[]
}

/** Verdict file written by the approval channel. */
interface Verdict {
  readonly decision: 'allow' | 'deny'
  readonly reason?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 200

/** Read + parse a JSON file, or `undefined` when absent/unreadable/malformed. */
function readJson<T>(path: string | undefined): T | undefined {
  if (path === undefined || !existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Abortable delay: resolves early when `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Resolve a name against the allow/deny lists. Deny always wins. */
function allowlisted(snapshot: PolicySnapshot, toolName: string): boolean {
  if (snapshot.deny?.includes(toolName) === true) return false
  return snapshot.allow.includes(toolName)
}

/**
 * Await one out-of-band verdict with a hard local deadline.
 *
 * The registry awaits this promise and never abandons it, so this function owns
 * both the timeout and `signal` observation; without them a missing verdict
 * would hang the tool call forever.
 */
async function awaitVerdict(
  approvalDir: string,
  exec: Readonly<ToolExecution>,
  timeoutMs: number,
): Promise<{ readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string }> {
  const verdictPath = join(approvalDir, `${exec.callId}.json`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (exec.signal.aborted) return { kind: 'deny', reason: 'the call was cancelled while awaiting approval' }
    const verdict = readJson<Verdict>(verdictPath)
    if (verdict?.decision === 'allow') return { kind: 'allow' }
    if (verdict?.decision === 'deny') {
      return { kind: 'deny', reason: verdict.reason ?? `tool "${exec.name}" was rejected by the operator` }
    }
    if (Date.now() >= deadline) {
      return { kind: 'deny', reason: `tool "${exec.name}" requires approval and none arrived within ${timeoutMs} ms` }
    }
    await sleep(POLL_INTERVAL_MS, exec.signal)
  }
}

/**
 * Install the global guard, the async approval gate, and the disposal chain.
 * @param ctx - plugin context carrying `ctx.tools`.
 * @param config - deployment paths and the fail-closed approval deadline.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const snapshotPath = config.snapshotPath ?? process.env['DSH_POLICY_SNAPSHOT']
  const revocationPath = config.revocationPath ?? process.env['DSH_POLICY_REVOCATION']
  const approvalDir = config.approvalDir ?? process.env['DSH_POLICY_APPROVAL_DIR']
  const timeoutMs = config.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS

  /** Last successfully parsed snapshot; a missing/garbled file keeps the previous one. */
  let cached: PolicySnapshot = { version: 1, allow: [] }
  const refresh = (): PolicySnapshot => {
    const next = readJson<PolicySnapshot>(snapshotPath)
    if (next !== undefined && Array.isArray(next.allow)) cached = next
    return cached
  }
  refresh()

  // Monotonic guard: runs AFTER every `tools/pre-execute` listener, is synchronous,
  // and cannot be re-allowed by any later listener. It returns a denial reason.
  ctx.tools.guard((exec) => {
    const revocation = readJson<Revocation>(revocationPath)
    if (revocation?.all === true) return 'all tool use is revoked for this deployment'
    if (revocation?.tools?.includes(exec.name) === true) return `tool "${exec.name}" is revoked for this deployment`
    const snapshot = refresh()
    if (!allowlisted(snapshot, exec.name)) return `tool "${exec.name}" is not permitted by the agent policy snapshot`
    return undefined
  })

  // Extensible gate: reorderable, async, and allowed to await an external decision.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const downstream = await next()
    // A downstream veto is authoritative: never soften deny/cancel into allow.
    if (downstream.kind !== 'allow') return downstream

    const snapshot = refresh()
    if (snapshot.requireApproval?.includes(exec.name) !== true) return downstream
    if (approvalDir === undefined) {
      return { kind: 'deny', reason: `tool "${exec.name}" requires approval but no approval directory is configured` }
    }
    const verdict = await awaitVerdict(approvalDir, exec, timeoutMs)
    if (verdict.kind === 'allow') return downstream
    return { kind: 'deny', reason: verdict.reason, info: { name: 'PolicyError', code: 'POLICY_DENIED' } }
  })

  // Anything that is NOT a ctx-registered effect must be disposed explicitly.
  // `ctx.effect()` collects the disposer and runs it on HMR unload / fiber disposal.
  ctx.effect(() => {
    refresh()
    const timer = setInterval(refresh, 5_000)
    return () => {
      clearInterval(timer)
    }
  }, 'agent-policy:snapshot-poll')
}

/** Optional helper so other plugins can read the effective snapshot shape. */
export type PolicyDefinition = ToolDefinition
```

设计说明（每条都对得上 §5 的证据）：

- **guard 装 allowlist 全集**：guard 是唯一"不能被翻案"的位置，所以 deny-all-by-default 必须放这里。
- **`pre-execute` 只叠加审批**：先 `await next()` 接受下游结论；下游 deny/cancel 一律原样返回。
- **不返回 `kind:'ask'`**：非交互运行时必然 deny（§5.4）。
- **`awaitVerdict` 自己管超时 + `exec.signal`**：registry 不会替你收尾（§5.1，运行时已验证会永久挂起）。
- **revocation 每次同步重读**：`revoked.json` 的存在即生效，不受 5s 缓存影响。
- **`ctx.effect` 只包 `setInterval`**：`ctx.on` / `ctx.tools.guard` 的 disposer 已由 fiber 拥有。

### 9.3 Skeleton B —— `plugins/agent-tools/src/index.ts`

编译后**存活**的 import：`@deepseek-ai/dsh-tools` 的 `defineTool`（必须，它是值）。
`@deepseek-ai/cordis` 只有 `import type { Context }`，编译后消失。

```ts
/**
 * Skeleton B — `plugins/agent-tools` style plugin.
 *
 * Runtime import: the `defineTool` value from `@deepseek-ai/dsh-tools`
 * (the plugin must register a real definition). Everything else is type-only.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Context } from '@deepseek-ai/cordis'

/** Plugin display name. */
export const name = 'agent-tools'
/** The plugin cannot register without the tool registry. */
export const inject = ['tools']

/** Deployment config. */
export interface Config {
  /** Upstream station base URL; absent = offline fixture mode. */
  readonly baseUrl?: string
}

/**
 * Canonical value of one `query_station` call.
 *
 * Deliberately MUTABLE arrays: `output.schema` inference yields `T[]`, so a
 * `readonly T[]` annotation on the return type is rejected by `execute`'s
 * `Promise<InferValue<O>>` contract.
 */
interface StationReading {
  readonly stationId: string
  readonly days: number
  samples: { day: string; value: number }[]
  readonly source: string
}

const MIN_DAYS = 1
const MAX_DAYS = 30

/**
 * Register the business tools on `ctx.tools`.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - deployment options.
 * @returns nothing; the registration is a fiber-owned effect.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const baseUrl = config.baseUrl ?? process.env['DSH_STATION_BASE_URL'] ?? 'fixture://local'

  ctx.tools.register(defineTool({
    name: 'query_station',
    description: 'Query one station time series. `days` is a whole number of days in [1, 30].',
    parameters: {
      // Required string.
      stationId: {
        type: 'string',
        required: true,
        description: 'Opaque station identifier, e.g. "ST-001".',
      },
      // Required integer; the schema DSL has no numeric bounds, so `execute` checks them.
      days: {
        type: 'integer',
        required: true,
        description: 'How many trailing days to return (1..30).',
      },
      // Optional enum argument (omit `required` to make it optional).
      granularity: {
        type: 'string',
        enum: ['hourly', 'daily'],
        description: 'Sampling granularity; defaults to "daily".',
      },
      // Optional exact-one union argument.
      window: {
        oneOf: [
          { type: 'string', description: 'A calendar day, "YYYY-MM-DD".' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string', required: true },
              to: { type: 'string', required: true },
            },
          },
        ],
        description: 'Optional explicit window instead of trailing days.',
      },
    },
    output: {
      // Object-rooted canonical value with a nested array.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stationId: { type: 'string', required: true },
          days: { type: 'integer', required: true },
          samples: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                day: { type: 'string', required: true },
                value: { type: 'number', required: true },
              },
            },
          },
          source: { type: 'string', required: true },
        },
      },
      // `render` must be pure and return model-facing content blocks.
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    execute(args, exec): Promise<StationReading> {
      const stationId = args.stationId.trim()
      if (stationId.length === 0) throw new Error('`stationId` must be a non-empty string')
      if (!Number.isInteger(args.days)) throw new Error('`days` must be an integer')
      if (args.days < MIN_DAYS || args.days > MAX_DAYS) {
        throw new Error(`\`days\` must be between ${MIN_DAYS} and ${MAX_DAYS} (got ${args.days})`)
      }
      if (exec.signal.aborted) throw new Error('cancelled')
      const now = Date.now()
      const samples = Array.from({ length: args.days }, (_, index) => ({
        day: new Date(now - (args.days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
        value: Math.round(Math.sin(index / 3) * 1000) / 10,
      }))
      return Promise.resolve({ stationId, days: args.days, samples, source: baseUrl })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Query station ${args.stationId}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}
```

`plugins/agent-tools/package.json` 与 A 相同，仅 `name` / `description` 不同
（`@agent-studio/plugin-agent-tools`），依赖同样是 `@deepseek-ai/dsh-tools@0.2.1-rc.3`。

---

## 10. Gotchas（踩过的，按坑的严重程度排）

1. **`tools/pre-execute` 没有超时，永不 resolve = 永久挂死。**
   `timeoutMs` / `dsh-tool-call-timeout-policy` 都在 `tools/execute`（下游）。
   实测：listener 返回永不 settle 的 promise，2 秒后调用仍 `STILL-PENDING`。
   任何"等人/等文件/等 HTTP"的 gate 必须自带 deadline **并且**观察 `exec.signal`。
2. **`exec.signal` 是 caller-owned，registry 不会替你 abort。**
   `index.d.ts:37-47`：*"the registry rechecks cancellation after they settle but never abandons their promise"*。
   同理，工具体里长任务必须 `throw`/透传 `exec.signal`。
3. **guard 是同步的。** 返回 `string | undefined`，不能 `await`，不能返回 Promise。
   需要异步策略 ⇒ 放 `pre-execute`；需要"不可翻案" ⇒ 放 guard。二者职责不能互换。
4. **`restrict` 必须有 agent 作用域。** plain ctx 直接抛错（原文见 §5.3）。
   进程级"全局黑名单"要用 `guard`，不是 `restrict`。
5. **`ask` 在非交互运行时等于 deny。** 没有 `ApprovalService` → deny；有服务没 answerer → `unavailable` → deny；
   没有 agent → deny。**不要**指望 `kind:'ask'`，自己实现 fail-closed 等待。
6. **deny 会掩盖 `UNKNOWN_TOOL`。** pre-execute 早于 `resolveExecution`（实测）。
   审计里要区分"被策略拒绝"和"工具根本不存在"，只能靠 `error.info.code`。
7. **`tools/result` 是 emit：不能抛、不能阻塞、不能改结果。**
   同步 throw 被 catch 成 `logger.warn`；返回的 promise 拒绝也只是 warn。
   审计别在那里做同步慢 I/O（会拖慢流水线收尾）。
8. **disposer 必须走 `ctx.effect`（或明确返回）。**
   `ctx.on` / `register` / `guard` / `restrict` 的 disposer 已由 fiber 拥有，HMR 自动清理；
   `setInterval`/`fs.watch`/socket **不会** —— 不包 `ctx.effect` 就是 HMR 泄漏。
9. **`output.schema` 没有数值边界。** `days: 1..30` 必须在 `execute` 里断言；DSL 只有 `enum`/`const`。
   （`enum: [1..30]` 能行但把 30 个字面量塞进 schema，模型侧成本高。）
10. **推断出的返回值类型是可变数组。** 返回 `readonly T[]` 会 `TS2719`。别给 `execute` 标 `readonly` 返回类型。
11. **`output.schema` + `output.render` 都是必填。** 忘写不是类型警告，是 `TypeError`（`register()` 抛）。
12. **`run_code` 是保留名。** 注册它、`restrict` 提到它，都直接抛错（PTC 模式传输占用）。
13. **手写 `ToolDefinition` 会丢全部入参校验。** 只有 `defineTool` 的 wrapper 校验参数；
    registry 不校验入参、只校验输出值（`ToolOutputError`）。
14. **`exec.token` 是 symbol**，`JSON.stringify` 会静默丢掉 → 审计请用 `callId` 归组。
15. **`result.value` 不应进持久审计**：文档明说它是 execution-local、durable 投影刻意省略。
16. **`ctx.on('tools/pre-execute')` 不调 `next()` 会短路后面所有 listener**（包括 guard？不会，guard 不是 listener，仍在后面跑）。
    多个策略插件共存时，这个短路会让别人静默失效 —— 一律"先 `await next()` 再叠加"。
17. **`sdk-minimal` 连 `ctx.approval` 都没有**；`sdk` profile 有服务无 answerer。
    写策略插件时不要 `inject: ['approval']`（会永远等不到）；用 `ctx.get('approval')` 探测式读取。
18. **插件模块里没有 `reusable` 字段**（Cordis `4.0.5`）。任务书提到的这个字段在本版本不存在，标 `未验证/不存在`。

---

## 11. 实际读过的源码清单

版本：全部 `0.2.1-rc.3`，Cordis `4.0.5`，TypeScript `5.9.3`。
路径前缀 `P = E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\pkgs`（解包自 npm 上的发布包）；
仓库切到 npm workspaces 后等价路径为 `E:\Code\OceansLabWeb\dsh_oceanslab\node_modules\@deepseek-ai\<pkg>\...`。

| 文件（绝对路径） | 读了什么 |
|---|---|
| `P\deepseek-ai-dsh-tools-0.2.1-rc.3\package\lib\types\schema.d.ts` | `DefineToolOptions`(178-240)、`defineTool`(248)、`ValueSchemaSpec` 全族(9-84)、`ToolArgsError`(165-169)、`validateArgs`(176) |
| `P\deepseek-ai-dsh-tools-0.2.1-rc.3\package\lib\types\index.d.ts` | `Events` 全部钩子(36-103)、`ToolDefinition`(115-191)、`ToolExecution`(216-296)、`ToolRunContext`(305-322)、`PreToolDecision`(445-460)、`PostToolDecision`(465-479)、`ToolGuard`(514-522)、`ToolRuntime`(527-851)、`ToolOutputError`(406-411) |
| `P\deepseek-ai-dsh-tools-0.2.1-rc.3\package\lib\index.js` | `register`(2974-2983)、`restrict`(2991-3006)、`guard`(3017-3022)、`guardReason`(3024-3032)、`prepareExecution`(3310-3370)、`dispatchToolBody`(3390-3415)、`notifyResult`(3505-3521)、`serviceAsk`(3525-3587)、`RUN_CODE_NAME`(955) |
| `P\deepseek-ai-dsh-tools-0.2.1-rc.3\package\lib\types\schema.js` | `ToolArgsError` 构造、`validateArgs`、`defineTool` 全实现（execute wrapper 在 315-320，presenter 软校验 328-345） |
| `P\deepseek-ai-dsh-tools-0.2.1-rc.3\package\README.md` | §"Restrict tools per agent"、"Anatomy/Pipeline"、"Known limitations"（`pre-execute` 明确不能改 `exec.arguments`） |
| `P\deepseek-ai-dsh-tool-todo-0.2.1-rc.3\package\lib\index.js` + `lib\types\index.d.ts` + `package.json` | 真实工具插件模块形状（`name`/`inject`/`Config`/`apply`）、`defineTool` 实战写法、`render` 返回 text 块 |
| `P\deepseek-ai-dsh-agent-0.2.1-rc.3\package\lib\types\types.d.ts` | `Agent { id }`(19-22) |
| `P\deepseek-ai-dsh-agent-0.2.1-rc.3\package\lib\types\runtime-types.d.ts` | `declare module './types.ts' { interface Agent { options/session/inbox/status/ctx/... } }` |
| `P\deepseek-ai-dsh-agent-0.2.1-rc.3\package\lib\types\index.d.ts` | `AgentRegistry`（`get`/`list`/`roots`/`currentInitiator`，以及"ambient presence 不是授权"） |
| `P\deepseek-ai-dsh-session-0.2.1-rc.3\package\lib\types\types.d.ts` | `SessionEventMap` 的 `tool/call`(355-361) / `tool/result`(375-389)、`SurfaceEventType`(443)、`SessionHeader` |
| `P\deepseek-ai-dsh-session-0.2.1-rc.3\package\lib\types\index.d.ts` | `Session.header` / `Session.id` / `Session.append` 签名 |
| `P\deepseek-ai-dsh-llm-0.2.1-rc.3\package\lib\types\types.d.ts` | `ContentBlockMap` / `ContentBlock`、`ToolSchema`、`TextBlock` |
| `P\deepseek-ai-dsh-llm-0.2.1-rc.3\package\lib\types\error.d.ts` | `HarnessError`（`code`） |
| `P\deepseek-ai-dsh-llm-0.2.1-rc.3\package\lib\types\brand.d.ts` | `ToolCallId` |
| `P\deepseek-ai-dsh-llm-0.2.1-rc.3\package\lib\types\message.d.ts` | `ToolResultMessage` / `createToolResultMessage` |
| `P\deepseek-ai-cordis-4.0.5\package\lib\types\context.d.ts` | `Context` 基座（`events`/`logger`/`reflect`/`registry`） |
| `P\deepseek-ai-cordis-4.0.5\package\lib\types\events.d.ts` | `DispatchMode`(20-25)、`waterfall`(66-79)、`on`(80-97)、`EventsService.register/unregister`(168-197) |
| `P\deepseek-ai-cordis-4.0.5\package\lib\types\fiber.d.ts` | `effect`(144-159)、`Disposable`/`Effect`(36-51)、`CordisError.INACTIVE_EFFECT`(76-90) |
| `P\deepseek-ai-cordis-4.0.5\package\lib\types\registry.d.ts` | `Plugin.Base`（`name`/`Config`/`inject`/`provide`/`intercept`）、`Plugin.Object.apply` |
| `P\deepseek-ai-cordis-4.0.5\package\src\registry.ts` | 插件形状判定 `isApplicable()`、`Inject.resolve`、fiber 创建 |
| `P\deepseek-ai-dsh-scope-0.2.1-rc.3\package\lib\types\index.d.ts` | `Scoped<T>`、`scopeOf`、`scopeTarget`、`createScope` |
| `P\deepseek-ai-dsh-user-approval-0.2.1-rc.3\package\lib\types\index.d.ts` | `ApprovalService.request`(135)、`ApprovalPolicy`、`approval/policy` 事件 |
| `P\deepseek-ai-dsh-user-approval-0.2.1-rc.3\package\lib\types\types.d.ts` | `ApprovalOutcome`、`approval/asked` / `approval/decided`、`approval/request` waterfall |
| `P\deepseek-ai-dsh-base-0.2.1-rc.3\package\cordis.patch.yml` | `approval`(259-262)、`permission`(264-276)、`timeout-policy`(408-409) |
| `P\deepseek-ai-dsh-sdk-minimal-0.2.1-rc.3\package\cordis.patch.yml` | 完整 Cordis 树；**无任何 approval 行** |
| `P\deepseek-ai-dsh-sdk-app-0.2.1-rc.3\package\cordis.patch.yml` | sdk profile = sdk-app over dsh-base |
| `P\deepseek-ai-dsh-tool-call-timeout-policy-0.2.1-rc.3\package\lib\index.js` | `ctx.on("tools/execute", ...)`(116) —— 证明超时在 gate 下游 |
| `E:\Code\OceansLabWeb\dsh_oceanslab\plugins\agent-policy\package.json`、`plugins\agent-tools\package.json`、`plugins\agent-audit\package.json` | 既有包名/脚本约定（`@agent-studio/plugin-*`、`tsc -p tsconfig.json`） |
| `E:\Code\OceansLabWeb\dsh_oceanslab\tsconfig.base.json`、`package.json`、`.npmrc`、`pnpm-workspace.yaml` | 编译基线（`NodeNext`/`strict`/`verbatimModuleSyntax`/`noUncheckedIndexedAccess`） |
| `E:\Code\OceansLabWeb\dsh_oceanslab\docs\RESEARCH-SDK.md` | 同项目 SDK 报告的既有结论（approval 线上通道缺失），用于交叉验证 |

**本地验证产物**（可复现，不在交付范围内）：
`E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\toolcheck\`
（`package.json`、`tsconfig.json`、`src\policy.ts`、`src\tools.ts`、`smoke.mjs`、`smoke2.mjs`、`smoke3.mjs`、`smoke4.mjs`、`smoke5.mjs`）。
`tsc -p tsconfig.json --noEmit` → `EXIT=0`。
