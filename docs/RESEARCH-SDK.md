# DeepSeek Harness TypeScript SDK 研究报告（`0.2.1-rc.3`）

> 目的：判断网关能否用官方 TS SDK 驱动"受限 Agent"，以及网关事件协议
> (`message.delta | tool.started | tool.completed | approval.required | agent.completed | agent.failed`)
> 能如实映射到什么程度。
>
> **验证基线**：所有结论只来自 npm 上 `0.2.1-rc.3`（dist-tag `next`）实际发布的打包文件，
> 解包位置 `E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\pkgs\`。每条断言后面的 `path:line`
> 都指向真实读过的文件。凡未能验证的地方一律标 `未验证` / `TODO(verify)`，不做推断式断言。

---

## 1. 结论速查表

| # | 问题 | 结论 | 精确名字 / 依据 |
|---|---|---|---|
| 1a | 客户端可发送的 JSON-RPC 方法 | **7 个** | `initialize`, `session/prompt`, `session/resume`, `session/wait`, `session/working-directory/get`, `session/working-directory/set`, `shutdown` — `HarnessSdkRequestMap` (`dsh-sdk-protocol/lib/types/types.d.ts:129-158`) |
| 1b | 服务端→客户端通知 | **4 个** | `session.event`, `session.status`, `subagent.started`, `subagent.finished` — `HarnessSdkNotificationMap` (`同文件:122-127`) |
| 2 | 是否有 token 级增量文本（`assistant/delta`）？ | **NO（不存在）** | 事件词表 `KNOWN_SESSION_EVENT_TYPES`（56 个类型）中没有任何 delta 事件；最细粒度是**每个 step 一条**已提交的 `assistant/message`，其 `data.stream` 内含逐 delta 的历史 `AssistantStreamRecord[]`（**提交后才可见**，不是实时） |
| 3 | 会话事件是否带 `sessionId`？ | **NO，字段名也不是 `id`/`parentId`** | `SessionEvent` 信封只有 `type` / `seq` / `time` / `data` / `ignorable?` /（surface 事件的 `surfaceOp?`、`sourceEventSeqs?`）。`sessionId` 在**通知外层** `SessionEventNotification.sessionId` |
| 3b | 对话类事件名 | **完整** | `user/message`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `turn/start`, `turn/end`, `step/start`, `step/end`, `agent/inbox/spliced`, `approval/asked`, `approval/decided` |
| 4 | 是否实现 server→client 请求 / `approval/request` 线上通道？ | **NO — 两端都没实现** | 协议 README 原文："**Server→client requests are a dead capability** — the transport supports them, but the server never sends one"（`dsh-sdk-protocol/README.md:122`）；`HarnessClient` 类只有 `request`/`subscribe`，**没有 `notify`**（`dsh-sdk-client/lib/types/client.d.ts:65-160`） |
| 4b | 那 approval 怎么办？ | **必须 out-of-band** | sdk profile 组合里**没有任何 answerer**，`approval/request` 瀑布无人认领 → 结果恒为 `unavailable` → 工具**fail closed**（`dsh-user-approval/README.md:12,32,156`；`dsh-base/cordis.patch.yml:259-262`） |
| 5 | 如何判定"这一轮结束"？ | **`session.status` + `status: "idle"`** | `run()` 正是 `break` 在 `notification.method === "session.status" && params.status === "idle"` 上（`dsh-sdk-client/lib/index.js:828`）；`busy` 状态叫 **`running`**（`AgentStatus = 'idle' \| 'running'`，`dsh-agent/lib/types/runtime-types.d.ts:90`） |
| 5b | `finalResponse` 怎么来？ | 取区间内**最后一条** `assistant/message` 的 `data.message.content` 里 `type === "text"` 的块拼接 | `dsh-sdk-client/lib/index.js:900-907` |
| 6 | `resumeSession()` 需要什么？ | ①`initialize` 已完成 ②`$DSH_HOME` 下有该 session 的持久化日志 ③组合里有 `sessionPersistence` 服务（jsonl backend）④同一 session 未被占用 | 缺失时错误：`session "<id>" not found`（`dsh-session-persistence/lib/index.js:28`）；未配置持久化：`cannot resume: session persistence is not configured (load a dsh-session-persistence backend)`（`dsh-agent-loop/lib/index.js:1965`）；已占用：`SDK session is already open or opening: <id>`（`dsh-sdk-jsonrpc-server/lib/index.js:177`） |
| 6b | sdk profile 用哪个持久化后端？日志在哪？ | `@deepseek-ai/dsh-session-persistence-jsonl`，root = `dshHomePath('sessions')` | `dsh-base/cordis.patch.yml:138-141`；路径 = `$DSH_HOME/sessions/--<normalized-cwd>--/<encoded-id>/session.v4.jsonl.zstd`（`dsh-session-persistence-jsonl/README.md:59-73` + `lib/index.js:943` + `SESSION_FORMAT_VERSION = 4`） |
| 7 | 有没有 turn 中途取消？ | **NO** | "The wire has no per-session close or prompt-cancel method"（`dsh-sdk-jsonrpc-server/README.md:130`）；"No mid-turn cancel — the wire has no prompt-cancel method; abandoning a turn means closing the runtime"（`dsh-sdk-client/README.md:128`）。唯一停 turn 的方式 = 关掉 runtime（`client.close()` / 杀进程），代价是丢掉整个会话的 agent 句柄 |

---

## 2. Q1 —— 客户端可发送的方法（精确参数与返回值）

来源：`dsh-sdk-protocol/lib/types/types.d.ts`（下同，行号为该文件）。服务端 dispatch 见
`dsh-sdk-jsonrpc-server/lib/index.js:275-301`（未知方法 → JSON-RPC error `-32603`）。

| 方法 | params | result | 备注 |
|---|---|---|---|
| `initialize` | `InitializeParams` | `InitializeResult` | 进程级握手，必须先成功；未初始化时其它方法报 `SDK server is not initialized` |
| `session/prompt` | `SessionPromptParams` | `SessionPromptResult` = `{ messageId }` | **只是入队回执**，不代表任何后续 assistant 内容归属这次 prompt |
| `session/resume` | `SessionResumeParams` = `{ sessionId }` | `{}` | 不发新输入，只恢复历史 |
| `session/wait` | `SessionWaitParams` = `{ sessionId }` | `{}` | **从不创建** session；未知 id 直接报错 |
| `session/working-directory/get` | `SessionWorkingDirectoryParams` | `SessionWorkingDirectoryResult` = `{ cwd }` | 未知 id 会**创建** session（但不启动模型 turn） |
| `session/working-directory/set` | `+ path` | `{ cwd }` | |
| `shutdown` | `undefined` | `{}` | 服务端 dispose 整个 root fiber 后 `process.exit(0)`（`dsh-sdk-jsonrpc-server/lib/index.js:388-395`） |

```ts
// 摘自 dsh-sdk-protocol/lib/types/types.d.ts:14-80,128-158（裁剪）
export interface InitializeParams {
  cwd: string;              // 记录到每个 SDK 创建的 session header 上
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
  maxTokens?: number;       // 正整数输出上限，被 in-process 子 agent 继承
}
export interface InitializeResult { serverInfo: { name: string; version: string } }

export interface SessionPromptParams { sessionId: string; contentBlocks: SdkPromptContentBlock[] }
export interface SessionPromptResult { messageId: string }
export interface SessionResumeParams { sessionId: string }
export interface SessionWaitParams   { sessionId: string }
export interface SessionWorkingDirectoryParams { sessionId: string }
export interface SessionWorkingDirectorySetParams extends SessionWorkingDirectoryParams { path: string }
export interface SessionWorkingDirectoryResult { cwd: string }

export interface HarnessSdkRequestMap {
  'initialize':                       { params: InitializeParams; result: InitializeResult };
  'session/prompt':                   { params: SessionPromptParams; result: SessionPromptResult };
  'session/resume':                   { params: SessionResumeParams; result: Record<string, never> };
  'session/wait':                     { params: SessionWaitParams; result: Record<string, never> };
  'session/working-directory/get':    { params: SessionWorkingDirectoryParams; result: SessionWorkingDirectoryResult };
  'session/working-directory/set':    { params: SessionWorkingDirectorySetParams; result: SessionWorkingDirectoryResult };
  'shutdown':                         { params: undefined; result: Record<string, never> };
}
```

`contentBlocks` 的元素类型（`SdkPromptContentBlock`，`同上:41-50`）：

```ts
export type SdkPromptContentBlock = ContentBlock | SdkEncodedImageBlock;
export interface SdkEncodedImageBlock {
  type: 'image';
  data: string;                                             // base64
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}
// ContentBlock 的 type 词表（dsh-llm/lib/types/types.d.ts:114-126）：
// 'text' | 'reasoning' | 'image' | 'file' | 'tool-call' | 'tool-addition' | 'tool-removal'
// 注意：'image' 的 ContentBlock 变体是 { type:'image', attachment: ImageAttachmentRef }，
// 与上面的 SdkEncodedImageBlock（inline base64）不是同一个东西；发 prompt 用后者。
```

### 启动选项（launch options）

```ts
// 摘自 dsh-sdk-client/lib/types/types.d.ts:20-62（裁剪；保留全部字段名与默认值注释）
export interface HarnessClientOptions {
  dshBin?: string;              // 省略时解析本包同版本的 @deepseek-ai/dsh 可执行入口
  profile?: string;             // 服务 SDK 协议的 profile 名（默认 'sdk'）
  patches?: string[];           // 有序 per-launch profile patch；相对路径在 spawn 前解析
  dshHome?: string;             // 子进程的 Harness home → 注入 env.DSH_HOME；相对路径同样先解析
  processCwd?: string;          // dsh 子进程自己的 cwd（≠ session 的 workspace）
  env?: NodeJS.ProcessEnv;      // 给了就**整体替换**父环境；undefined 才继承父环境
  initializeTimeoutMs?: number; // 默认 10000
  requestTimeoutMs?: number;    // undefined = 无限等（一个 turn 可以合法地跑很久）
  shutdownTimeoutMs?: number;   // 默认 1000
  disposeEofGraceMs?: number;   // 默认 6000
  disposeGraceMs?: number;      // 默认 3000
}

export interface DeepSeekHarnessOptions extends HarnessClientOptions {
  cwd?: string;                 // 写进每个 SDK session 的 workspace cwd（默认 process cwd）
  provider?: string;            // 默认 'deepseek-official'
  model?: string;               // 默认 'deepseek-v4-flash'
  reasoningEffort?: ReasoningEffortId;
  maxTokens?: number;
}
```

`resolveDshLaunch()` 把这些选项变成一条 argv（`dsh-sdk-client/lib/index.js` 的
`resolveDshLaunch`）：

```text
process.execPath <dshBin 或本包解析出的入口> --profile <profile> [--patch <p1> --patch <p2> ...]
env = { ...(options.env ?? process.env), ...dshBuiltinEnv, ...(dshHome ? { DSH_HOME } : {}) }
```

即：**`dshHome` 是通过环境变量给子进程的**，不是命令行参数；`patches` 一定排在
`dshBin` 自带 patch 之后。

### 服务端→客户端通知（全部 4 个，含精确 params）

```ts
// 摘自 dsh-sdk-protocol/lib/types/types.d.ts:82-127（裁剪）
export type SdkRunStatus = 'ok' | 'error';

export interface SessionEventNotification {
  sessionId: string;   // 运行时内**每一个** session 都会推，不止 SDK 创建的
  event: SessionEvent; // 完整的 session-log 事件信封
}
export interface SessionStatusNotification {
  sessionId: string;
  status: 'idle' | 'running';   // 整个 agent 的状态，不是单个 turn
}
export interface SubagentStartedNotification  { parentSessionId: string; childSessionId: string }
export interface SubagentFinishedNotification {
  provider: string;
  agentId: string;                 // 本地 run 时等于 childSessionId
  parentSessionId: string;
  childSessionId: string;
  status: SdkRunStatus;
  stopReason: SubagentStopReason;
  lastAssistantMessage?: ContentBlock[];  // 子 agent 没产出时该字段缺省
}

export interface HarnessSdkNotificationMap {
  'session.event':    SessionEventNotification;
  'session.status':   SessionStatusNotification;
  'subagent.started': SubagentStartedNotification;
  'subagent.finished': SubagentFinishedNotification;
}
```

**重要**：这几个通知是**全进程广播**——运行时里任何 session（包括并发会话、subagent 子会话）
的事件都会推过来，SDK 侧的过滤是纯客户端的。`HarnessClient.subscribeSessionTree(id)`
用 `subagent.started` 的父子边做本地血缘过滤（`dsh-sdk-client/lib/index.js:544-555`）。

---

## 3. Q2 —— 增量文本到底怎么到达客户端

### 结论：没有 token 级实时流。最细粒度 = **每个 step 一条已提交消息**

证据链（三条独立证据）：

1. **事件词表里有全部类型，没有任何 `*delta*`**
   `dsh-session/lib/types/known-event-types.js:20-99` 是"本构建能识别的全部 `SessionEventMap`
   成员"（生成式清单，共 56 个类型）。里面 **不存在** `assistant/delta` / `text/delta` /
   `message/delta` 之类的名字。只有 `assistant/message` 和 `assistant/attempt`。

2. **`assistant/message` 的语义是"一个 step 组装完成后的消息"**
   `dsh-session/lib/types/types.d.ts:321-339`：

```ts
'assistant/message': {
  turn: number;
  step: number;
  message: AssistantMessage;
  /** Exact timed model stream, compacted without joining delta boundaries. */
  stream: AssistantStreamRecord[];
  usage?: TokenUsage;
  interrupted?: true;        // turn 中途被取消时，已投递的前缀以 interrupted:true 落盘
};
```

   `AssistantMessage` = `{ role:'assistant', id: MessageId, content: readonly ContentBlock[], source: ModelMessageSource }`
   （`dsh-llm/lib/types/message.d.ts:124-151`）。也就是说**一次模型调用的全部文本在一次通知里到齐**，
   之后才轮到该 step 的 tool 执行。

3. **`stream` 里确实有逐 delta 的历史数据，但它是"已提交后的回放素材"**
   `dsh-llm/lib/types/assistant-stream.d.ts:16-71`：

```ts
export type AssistantStreamRecord =
  | { type: 'text-chunks';      time0: number; index: number; dt: readonly number[]; texts: readonly string[] }
  | { type: 'reasoning-chunks'; time0: number; index: number; dt: readonly number[]; texts: readonly string[] }
  | { type: 'tool-call-chunks'; time0: number; index: number; dt: readonly number[]; id: ToolCallId; name?: string; args: readonly string[] }
  | { type: 'chunk';            time: number; chunk: StreamChunk };

export declare function expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[];
```

   即：模型每个 delta 的文本和**时间戳**都被压进 `assistant/message.data.stream`。
   模型流结束后一次性随事件推送。你可以用 `expandAssistantStream()` 还原成带时间的
   delta 序列，但那只能在**收到事件之后**按原始节奏"重播"，无法边生成边推。

### 对网关的直接后果

| 期望 | 现实 |
|---|---|
| 实时打字机效果 | **做不到**。SDK 线上不存在 token 级推送 |
| 每个 step 结束拿到该次模型输出全文 | 可以，`assistant/message` |
| 拿到带时间的 delta 序列（用于回放/测速） | 可以，但仅在事件提交后 |
| 每个工具调用的开始/结束边界 | 可以，`tool/call` → `tool/result` |
| 用户消息被接收的时刻 | 可以，`agent/inbox/spliced` 回执（见 §4.6） |

> 未验证：真实运行时里 `assistant/message` 是"模型流结束立刻写"还是"step 结束才写"。
> `d.ts` 注释称其为 "Assembled assistant message for one step"，`turn/end` 注释称有 step 之后
> 才有 `step/end`。**用 `step/end` 判断 step 边界是否可靠，需要在真实 runtime 上做一次
> `TODO(verify)` 实测。**

---

## 4. Q3 —— 对话 UI 需要的持久化会话事件

### 4.1 信封（`SessionEvent`）

```ts
// 摘自 dsh-session/lib/types/types.d.ts:490-513（裁剪）
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K;
    seq: SessionSeq;      // 会话内单调序号
    time: number;         // Unix epoch ms
    data: SessionEventMap[K];
    ignorable?: true;     // 不认识该类型时可安全跳过；缺省=必须拒绝重建
  } & (K extends SurfaceEventType
        ? SurfaceIntent<K>            // surfaceOp: 'append' | { op:'replace', startSeq, endSeq }
        : { surfaceOp?: never; sourceEventSeqs?: never });
}[T];
```

**必须纠正三个常见误解**（题目里提到的字段名在这里都不存在）：

* **没有 `sessionId`** —— 由外层 `SessionEventNotification.sessionId` 提供。
* **没有 `id`** —— 只有 `seq`。消息级的稳定 id 在 `data.message.id`（`MessageId`）。
* **没有 `parentId`** —— fork 血缘在 `SessionHeader.parentSession`（不在事件里）。

### 4.2 核心对话事件（`SessionEventMap`，`dsh-session/lib/types/types.d.ts:256-434`）

| 事件 `type` | `data` 字段 | 说明 |
|---|---|---|
| `turn/start` | `{ turn: number }` | 一个 turn 开始 |
| `turn/end` | `{ turn: number; reason: TurnEndReason }` | 一个 turn 结束，`reason.kind` ∈ `completed \| aborted \| blocked \| error \| max-tokens \| interrupted \| forked` |
| `step/start` | `{ turn: number; step: number }` | 一次模型调用 + 它请求的工具执行 |
| `step/end` | `{ turn: number; step: number }` | |
| `user/message` | `UserMessage` = `{ role:'user', id: MessageId, content: ContentBlock[], source: MessageSource }` | 直接人类输入 / 注入上下文 / goal 续轮都走这里，靠 `source.kind` 区分 |
| `assistant/message` | `{ turn, step, message: AssistantMessage, stream, usage?, interrupted? }` | 见 §3 |
| `assistant/attempt` | `{ turn, step, stream }` | 失败/重试/被取消但**未提交任何可见消息**的尝试 |
| `tool/call` | `{ turn, step, callId: ToolCallId, name: string, arguments: string }` | `arguments` 是模型产出的**原始 JSON 字符串**，未解析 |
| `tool/result` | `{ turn, step, message: ToolResultMessage, error?: { name, code, reason? }, meta?: JsonValue }` | `message.isError?` 标失败；`meta` 是工具私有的展示载荷（可为任意 JSON） |
| `system/message` | `{ turn, step, message: SystemMessage }` | 系统提示词，历史派生用 |
| `developer/message` | `{ turn, step, message: DeveloperMessage, headerSeq? }` | 工具增删等增量 |
| `request/header` / `request/context` | `{ header, reason, startsSeries? }` / `RequestContext` | 请求配置快照，log-only |
| `session/end-seed` | `{ inherited?: true }` | fork 边界标记 |

`TurnEndReason` 的失败分支（`同文件:166-211`）：

```ts
error: { kind: 'error'; error: LlmFailure };
aborted: { kind: 'aborted'; reason: TurnEndCancelCause };
// LlmFailure = { message: string; code: string; status?: number; providerRetryAfterMs?; requestId? }
//   （dsh-llm/lib/types/types.d.ts:26-...）
// TurnEndCancelCause = { kind:'user' } | { kind:'parent' } | { kind:'hook', reason:string } | { kind:'disposed' } | { kind:'legacy' }
```

### 4.3 插件合并进来的、对话 UI 需要的额外事件

| 事件 `type` | 定义位置 | `data` |
|---|---|---|
| `agent/inbox/spliced` | `dsh-agent/lib/types/types.d.ts:79-93` | `{ target: 'next-turn' \| 'next-step', start: number, removedCount?: number, inserted: UserMessage[], outcome?: 'canceled' }` |
| `approval/asked` | `dsh-user-approval/lib/types/types.d.ts:27-42` | `{ id: ApprovalRequestId, toolName: string, callId?: ToolCallId, reason?: string }`（log-only，无 `surfaceOp`） |
| `approval/decided` | 同上:43-51 | `{ id: ApprovalRequestId, outcome: 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable' }` |

> 其它在 `KNOWN_SESSION_EVENT_TYPES` 里存在、但本文**未读其 payload 定义**的类型（不要凭名字猜字段）：
> `session/title`, `compaction/*`, `hook/*`, `goal/change`, `plan/mode`, `permission/preset`,
> `sandbox/mode`, `job/*`, `subagent/*`, `team/*`, `todo/write`, `llm/retry`, `llm/retry-started`,
> `working-directory/change`, `deliverables/presented` … 完整清单见
> `dsh-session/lib/types/known-event-types.js:20-99`。

### 4.4 `RunResult`（高层 API 的返回）

```ts
// 摘自 dsh-sdk-client/lib/types/types.d.ts:63-73
export interface RunResult {
  sessionId: string;
  finalResponse: string;                    // 区间内最后一条 assistant/message 的 text 拼接
  events: SessionEvent[];                   // 根 session 的 session.event 载荷，按线序
  notifications: HarnessNotification[];     // 根 session + 已发现后代的所有通知，按线序
}
```

---

## 5. Q4 —— Approval 支持：**明确没有**

三重证据，可以放心下结论"必须 out-of-band"：

1. **协议层 README 直接说明这是死能力**
   `dsh-sdk-protocol/README.md:122`：
   > **Server→client requests are a dead capability** — the transport supports them,
   > but the server never sends one; the Python SDK's responder surface exists for future approval flows.

2. **`HarnessSdkNotificationMap` 里没有任何 approval 方法**
   `dsh-sdk-protocol/lib/types/types.d.ts:122-127` 只有 4 条；`HarnessSdkRequestMap`
   里也没有"回答 approval"的方法。传输层 `JsonRpcLineTransport` 确实能收发双向请求
   （`transport.d.ts:26-41`），但**客户端类没把它暴露出来**。

3. **客户端根本没有发通知/回响应的 API**
   `HarnessClient` 的公开成员只有 `start/initialize/prompt/resumeSession/
   getWorkingDirectory/setWorkingDirectory/request/subscribe/subscribeSessionTree/close`
   （`dsh-sdk-client/lib/types/client.d.ts:65-160`），**没有 `notify()`**，也没有
   "respond to server request"。sdk-client README 同意："Client→server notifications and
   server→client requests are **unimplemented on both wire ends**"（`README.md:130`）。

### 那受限 Agent 撞到需要审批的操作时会发生什么？

**不是挂起等待，而是 fail closed 变成一次工具失败。** 链路：

* 组合里的审批策略由 `DSH_PERMISSION_MODE` 决定（默认 `workspace-write` → `policy: ask`）：
  `dsh-base/cordis.patch.yml:259-262`。
* `policy: ask` 时服务把问题投给 `approval/request` 瀑布；**没人认领 → `unavailable`**：
  `dsh-user-approval/README.md:32`（"Without a terminal answerer, requests resolve
  `unavailable` and fail closed"）、`lib/index.js:176`（fallback 返回 `'unavailable'`）。
* `sdk-app` 的 patch 只插入了 `sdk-app-startup` + `sdk-jsonrpc-server`
  （`dsh-sdk-app/cordis.patch.yml:11-21`）；`dsh-base` 的 patch 里 **grep 不到任何 answerer**
  （只有 `user-approval` 服务本身）。所以 sdk profile 下 **approval 永远 unavailable**。
* 模型侧看到的结果：一次工具错误；审计事件 `approval/asked` → `approval/decided{outcome:'unavailable'}`
  仍然会作为 `session.event` 推到 SDK 线上（log-only 事件）。

同类坑：`ask_user_question` 工具在 SDK profile 下同样没有 answerer，会以**工具失败**收场
（`dsh-user-questions/README.md:45` 列出的可能失败文案包含
`Error: no user-questions answerer accepted the request`）。
> `TODO(verify)`：该 README 的另一段提到 timed call 有 "unattended timer"（超时只 abort 前台
> 请求、不 abort turn，`:40`），所以"是否会在某个时间窗口内 pending 而不是立刻失败"未实测。

### 因此网关的唯一可行路径

| 方案 | 可行性 | 说明 |
|---|---|---|
| 复用 SDK 的 approval 通道 | ❌ 不存在 | 见上 |
| 在 SDK 侧看到 `approval/asked` 后"回答" | ❌ 时序上不可能 | `approval/asked` 落盘后**立刻**执行瀑布判定（`lib/index.js:132-176`），等你读到事件时 `unavailable` 已经定了 |
| 带外审批 + 用 profile patch 换策略 | ✅ 推荐 | 要么全程 `DSH_PERMISSION_MODE=danger-full-access`（`policy: never`，全部直接放行），要么用 `patches: [...]` 注入一个**受信的 answerer 插件**把决策接到你自己的 IPC/HTTP 上 |
| 权限前置收紧 | ✅ 补充 | 用 `sandbox-policy`/`permission-presets` 把可做的事压到不需要审批的范围 |

> `approval.required` 这个网关事件在 0.2.1-rc.3 上**只能是"事后通知"**（语义等价于
> `approval.denied{unavailable}`），不能是"请求用户批准"。

---

## 6. Q5 —— `run()` vs `HarnessClient.prompt()`

### 6.1 `prompt()`（低层）

```ts
prompt(sessionId: string, contentBlocks: SdkPromptContentBlock[]): Promise<string>
```

`session/prompt` 一被接受就返回 `messageId`，**永不等待 agent 活动**
（`dsh-sdk-client/README.md:56`；`lib/index.js:434-442`）。服务端实现只做
`agent.followup(message)` 后立即返回（`dsh-sdk-jsonrpc-server/lib/index.js:153-165`）。
**没有任何 turn/assistant 归属关系**（protocol README:60："it does not identify a later
assistant message, turn ending, or prompt result"）。

### 6.2 `HarnessSession.run()` / `DeepSeekHarness.run()`（高层）

真实实现（`dsh-sdk-client/lib/index.js:800-839`）可以逐行读完，语义是：

1. `await harness.start()`（memoize 的 `initialize`）；
2. `client.subscribeSessionTree(this.id)` —— **先订阅再 prompt**；
3. `client.prompt(...)` 拿 `messageId`；
4. 循环 `await subscription.next()`：
   * 未收到回执前，只认 `session.event` 且 `params.sessionId === this.id` 且
     `event.type === 'agent/inbox/spliced'` 且 `event.data.inserted[].id === messageId`
     （`isInboxReceipt`，`lib/index.js:889-894`）→ 标记 `received = true`；
   * 收到回执后开始收集；
   * `notification.method === 'session.status' && params.sessionId === this.id && params.status === 'idle'` → **break**；
5. 返回 `{ sessionId, finalResponse, events, notifications }`。

### 6.3 "turn 结束" 的判定口径

| 信号 | 精确名字 | 语义 | 可靠性 |
|---|---|---|---|
| agent 空闲 | `session.status` / `params.status === 'idle'`（忙碌 = `'running'`） | **整 agent** 空闲，不是单 turn | 官方 `run()` 的 break 条件，可用 |
| turn 结束 | `session.event` / `event.type === 'turn/end'`，`data.reason.kind` | 单 turn 的终态（含失败/取消原因） | 语义最准，**但 `run()` 并不依赖它** |
| 子 agent 结束 | `subagent.finished` | 仅 in-process 子 agent | 远程 run 不报 |
| 显式等待 | `client.request('session/wait', { sessionId })` | 等到根 agent 空闲且受管后代完成 | 适合后台 drain；**未知 session 会报错，不创建** |

`turn/end.reason.kind` 与网关的对应关系很关键（`dsh-session/lib/types/types.d.ts:166-211`）：

* `completed` → 正常完成
* `error` → `data.reason.error: LlmFailure`（`message` / `code` / `status`）
* `aborted` → `data.reason.reason.kind ∈ user|parent|hook|disposed|legacy`
* `max-tokens` → 撞输出上限
* `blocked` / `interrupted` / `forked` → 其它终态

### 6.4 `finalResponse` 的推导

```ts
// dsh-sdk-client/lib/index.js:900-907 原文逻辑
function finalResponse(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    return event.data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  return '';
}
```

注意：**"最后一条"不等于"这次 prompt 的答案"**。README 明确说
`finalResponse` "is the last committed root-session assistant text in that interval —
**not a response causally assigned to the prompt**"（`dsh-sdk-client/README.md:52`）。
steering、注入上下文、并发入队的其它工作都可能混进这个区间。

### 6.5 运行时失败时的行为

| 失败类型 | 表现 |
|---|---|
| 子进程退出 / stdio 关闭 | `TransportClosedError`，消息里带 **exit code + stderr 尾部**（`client.d.ts:22-25`；`lib/index.js:617-623`，stderr 尾部上限 400 行） |
| 请求超时 | `RequestTimeoutError`（只有显式配了 `requestTimeoutMs` 才会超时；默认 `undefined` = 无限等，"a turn can legitimately run long"，`types.d.ts:41-42`） |
| 服务端回了不合协议的结果 | `SdkProtocolError`（如 `session/prompt` 没返回 `messageId`、`assistant/message` 的 content 畸形） |
| JSON-RPC 错误响应 | `JsonRpcResponseError{ code, data }`；handler 抛异常统一映射成 **`-32603`**（`dsh-sdk-protocol/lib/index.js:199,210`），未知方法 `-32601` |
| 模型/turn 级失败 | **不进异常**。以 `turn/end` 的 `reason.kind === 'error'` 出现在事件流里。服务端另外把 `agent/error` 记在 `record.failure` 里，仅当**没有更新的 `turn/end`** 时让 `session/wait` 抛错（`dsh-sdk-jsonrpc-server/lib/index.js:77-84,200-203`）——`agent/error` **本身不是线上通知** |
| 握手失败 | `DeepSeekHarness.start()` 会清理并换一个新 client；清理也失败时抛 `AggregateError`（`lib/index.js:703-712`） |

---

## 7. Q6 —— `resumeSession()` 的前置条件与错误

### 7.1 需要什么

```ts
// 高层：先 start（含 initialize），再发 session/resume，最后包成 handle
async resumeSession(sessionId: string): Promise<HarnessSession>   // lib/index.js:731-735
// 低层：
async resumeSession(sessionId: string): Promise<void>             // lib/index.js:448-450 → request('session/resume',{sessionId})
```

服务端 `resume()`（`dsh-sdk-jsonrpc-server/lib/index.js:173-180`）→ `agents.resume()` →
`persistence.open(id, 'write')`（`dsh-agent-loop/lib/index.js:1963-1990`）。所以要求：

1. **`initialize` 已完成**（否则 `SDK server is not initialized`）。
2. **运行时 home 里有该 session 的日志**。sdk profile 继承 `dsh-base`，持久化后端是
   `@deepseek-ai/dsh-session-persistence-jsonl`，`root: dshHomePath('sessions')`
   （`dsh-base/cordis.patch.yml:138-141`），即 **`$DSH_HOME/sessions`**。
   `$DSH_HOME` 解析优先级：显式 configure > `$DSH_HOME` > `~/.dsh`
   （`dsh-home-paths/lib/index.js` 的 `resolveDshHome`；`DSH_HOME_DIR_NAME = ".dsh"`）。
3. **组合里有 `sessionPersistence` 服务**（jsonl backend 必须挂上）。缺了会报
   `cannot resume: session persistence is not configured (load a dsh-session-persistence backend)`
   （`dsh-agent-loop/lib/index.js:1965`）。
4. **session 未被占用**：同进程内重复 resume 同一 id →
   `SDK session is already open or opening: <id>`（`dsh-sdk-jsonrpc-server/lib/index.js:177`）；
   跨进程/跨实例被写句柄占用 → `session "<id>" is already owned by an active write handle`
   （`dsh-session-persistence/lib/index.js:48`，内核 flock/命名信号量）。

### 7.2 磁盘布局（`$DSH_HOME` 下）

```text
$DSH_HOME/
  cordis.patch.yml                     # 机器级 patch
  sessions/                            # ← jsonl backend 的 root
    --<normalized-cwd>--/              # 可读的项目目录（无 cwd 时为 _no-cwd/）
      <encoded-id>/                    # session id 单段安全转义
        session.v4.jsonl.zstd          # 当前代（压缩）
        session.v3.jsonl.zstd          # 历史代，保留不覆盖
```
依据：`dsh-session-persistence-jsonl/README.md:59-73` + `lib/index.js:943`
（`generationLogPath(root, cwd, id, SESSION_FORMAT_VERSION, compression)`）+
`SESSION_FORMAT_VERSION = 4`（`dsh-session/lib/types/types.d.ts:55`）。

> ⚠️ 该 README 的示例表格仍把 `session.v3.jsonl` 标成 "current"，与代码里的
> `SESSION_FORMAT_VERSION = 4` 不一致（README 示例是示意性的）。**不要硬编码 v3 文件名**，
> 按"数值最高的 `session.vN.*`"选择。

### 7.3 没有该 session 时的确切错误

* 持久化层抛出：`session "<id>" not found`（`SessionPersistenceNotFoundError`，
  `dsh-session-persistence/lib/index.js:24-29`）。
* 经服务端 handler 抛 → 传输层包成 JSON-RPC 错误帧 `code: -32603`、`message` 即上面那句
  （`dsh-sdk-protocol/lib/index.js:210`）。
* 客户端 `request()` 把它变成 `JsonRpcResponseError`（`code`、`data` 保留）。
* `HarnessClient.resumeSession()` 不做二次包装，直接 reject（`lib/index.js:448-450`）。
* 注意 `resumeSession()` **不会**创建替代 session（server README:28："Missing, unreadable,
  incompatible, or occupied sessions reject without creating a replacement"）。

---

## 8. Q7 —— 取消：不存在，只能关 runtime

| 想做的事 | 现实 |
|---|---|
| 取消正在跑的 turn | **没有 API**：没有 `session/cancel`、没有 abort 参数、没有 `client.notify` 通道 |
| `AbortSignal` | 只存在于**本地请求等待**：`transport.request(..., signal)`（`transport.d.ts:85`）把 pending 从表里删掉；**服务端那边的 turn 继续跑**（`client.d.ts:60-63`："There is no wire-level cancel: a timed-out request stays running server-side until the runtime is closed"） |
| 唯一可靠的停止方式 | `client.close()`：先发协议 `shutdown`（`shutdownTimeoutMs` 默认 1000ms），再走 stdin-EOF → SIGTERM → SIGKILL 阶梯直到进程真的退出（`lib/index.js:566-580`；`dispose.d.ts`）。**幂等且终态**，关闭后 client 不可复用 |
| 代价 | 关闭 runtime 会连**同一进程里的所有 session**一起 dispose（`performShutdown` 遍历 `this.sessions`，`dsh-sdk-jsonrpc-server/lib/index.js:243-267`）。要"只停一个会话"，只能一个 runtime 承载一个会话 |
| 落盘表现 | 被"取消"的 turn 在日志里是 `turn/end{reason.kind:'aborted'}` 或 `interrupted`；已投递的文本前缀以 `assistant/message{interrupted:true}` 落盘（`types.d.ts:321-330`） |

> 架构建议：网关要让"停止"可用且代价可控 → **一个受限 agent 一个 runtime 子进程**。

---

## 9. 可直接复制的 TypeScript 示例（`HarnessClient` 低层）

只用本文验证过的 API。`// TODO(verify)` 标出需要在真实 runtime 上实测的点。

```ts
import {
  HarnessClient,
  validatedSessionEvent,
  JsonRpcResponseError,
  TransportClosedError,
  RequestTimeoutError,
  SdkProtocolError,
} from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface GatewaySink {
  /** 网关侧事件回调（映射关系见 §10） */
  onEvent(event: SessionEvent): void
  onIdle(): void
  onFailure(error: unknown): void
  /** 可选：subagent 生命周期是通知，不是 SessionEvent，单独走这里 */
  onSubagent?(notification: HarnessNotification): void
}

export interface TurnOptions {
  /** 运行时 home；不传则用 $DSH_HOME 或 ~/.dsh */
  dshHome?: string
  /** 会话工作目录（写进 session header，也决定沙箱 workspace 的语义起点） */
  workspaceCwd: string
  provider?: string
  model?: string
  sessionId: string
  text: string
}

export async function runOneTurn(opts: TurnOptions, sink: GatewaySink): Promise<void> {
  const client = new HarnessClient({
    profile: 'sdk',                        // 默认就是 'sdk'；显式写出来便于排错
    ...(opts.dshHome === undefined ? {} : { dshHome: opts.dshHome }), // → 子进程 env.DSH_HOME
    // 不要轻易传 env：传了会**整体替换**父环境，凭据全丢（types.d.ts:31-38）
    // 不传 requestTimeoutMs = 不设上限（一个 turn 可能合法地跑很久）；见 §11 gotcha 7
    initializeTimeoutMs: 30_000,
    shutdownTimeoutMs: 1_000,
  })

  // 订阅必须先于 prompt，否则可能漏掉回执事件
  const sessionId = opts.sessionId
  const sub = client.subscribe((n: HarnessNotification) => {
    const sid = n.params.sessionId
    return typeof sid === 'string' && sid === sessionId
  })

  try {
    client.start()                          // 幂等；启动子进程
    const info = await client.initialize({  // 进程级握手，必须先成功
      cwd: opts.workspaceCwd,
      provider: opts.provider ?? 'deepseek-official',
      model: opts.model ?? 'deepseek-v4-flash',
    })
    console.log('runtime:', info.serverInfo.name, info.serverInfo.version)

    const messageId = await client.prompt(sessionId, [{ type: 'text', text: opts.text }])
    console.log('queued message:', messageId)

    let received = false
    while (true) {
      const notification = await sub.next()

      // 1) 会话事件：唯一的信息来源
      if (notification.method === 'session.event') {
        const event = validatedSessionEvent(notification.params.event)   // 会抛 SdkProtocolError
        if (!received && isOurReceipt(event, messageId)) received = true
        if (received) sink.onEvent(event)
        continue
      }

      // 2) agent 状态：idle = 本轮活动区间结束（官方 run() 的判定口径）
      if (notification.method === 'session.status') {
        if (notification.params.status === 'idle' && received) {
          // TODO(verify) 实测 turn/end 是否总在 idle 之前到达；
          // 若不保证，这里应改为"等 turn/end 或 idle 后 sleep 一小段再收尾"。
          sink.onIdle()
          return
        }
        continue
      }

      // 3) subagent 生命周期（可选）：它们是**通知**，不是 SessionEvent，
      //    不要硬塞进 onEvent；需要就单独开一个回调/单独落库。
      if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
        if (received) sink.onSubagent?.(notification)
        continue
      }
    }
  } catch (error) {
    if (error instanceof TransportClosedError) {
      // runtime 退出/不可启动；message 里有 exit code + stderr 尾部
      sink.onFailure(error)
    } else if (error instanceof JsonRpcResponseError) {
      // -32603（handler 异常）或 -32601（未知方法）；如 resume 缺失 session
      sink.onFailure(error)
    } else if (error instanceof RequestTimeoutError) {
      // 只有显式配置 requestTimeoutMs 才可能发生
      sink.onFailure(error)
    } else if (error instanceof SdkProtocolError) {
      sink.onFailure(error)
    } else {
      sink.onFailure(error)
    }
    throw error
  } finally {
    sub.close()
    // 唯一能真正停下 turn 的手段；幂等、终态
    await client.close()
  }
}

/** 与服务端 isInboxReceipt 等价的判断（dsh-sdk-client/lib/index.js:889-894） */
function isOurReceipt(event: SessionEvent, messageId: string): boolean {
  if (event.type !== 'agent/inbox/spliced') return false
  const data = event.data as { inserted?: Array<{ id?: unknown }> }
  return Array.isArray(data.inserted) && data.inserted.some((m) => m?.id === messageId)
}

/** 占位说明已删除：subagent.* 是 HarnessNotification，不是 SessionEvent，
 *  不能也不需要伪装成 SessionEvent。 */

/** 后台 drain 的另一种写法（订阅先建、prompt 后等 wait） */
export async function promptThenWait(client: HarnessClient, sessionId: string, text: string): Promise<void> {
  const sub = client.subscribe(() => true)
  await client.prompt(sessionId, [{ type: 'text', text }])
  // session/wait 不创建 session；未知 id 会直接报错（-32603）
  await client.request('session/wait', { sessionId })
  for (;;) {
    const n = sub.tryNext()          // 非阻塞排空已投递的通知
    if (n === undefined) break
    // 处理 n ...
  }
  sub.close()
}
```

示例中**没有**使用的东西（因为不存在）：`client.notify()`、`session/cancel`、
approval 回写、`assistant/delta`、token 级回调、`client.session()`。

### 另一个可用入口（高层）

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  dshHome: 'E:/data/dsh-home-a',
  cwd: 'E:/work/agent-1',        // → initialize 的 cwd（不是子进程 cwd）
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  // maxTokens: 49_152,
})
const result = await harness.run('say hi', {
  onNotification: (n) => { /* 全量通知回调，含 session.status */ },
})
console.log(result.sessionId, result.finalResponse, result.events.length)
```

`DeepSeekHarnessOptions.cwd` 只影响 `initialize.cwd`；`processCwd` 才是子进程的 cwd
（`lib/index.js:666`）。`await using` 保证 `close()`；`HarnessClient.close()` 是终态的。

---

## 10. 网关事件映射表

| 网关事件 | 源（DSH 通知/事件） | 可用数据 | 缺口 / 做不到 |
|---|---|---|---|
| `message.delta` | **没有真 delta**。最接近：`session.event` + `type:'assistant/message'`（每 step 一条） | `data.message.content[]`（`text` / `reasoning` 块）、`data.message.id`、`data.turn`、`data.step`、`data.usage`、`data.interrupted`、`data.stream[]`（逐 delta 文本 + `dt` 毫秒） | ❌ 无法实时逐 token 推；❌ 无"本次 prompt 专属"的增量（steering/注入/并发入队会混入）；⚠️ `content` 还可能含 `image`/`tool-call`/`file` 块，不是纯文本；⚠️ `data.stream` 体积大（每个 delta 都带时间），网关最好丢弃或按需透传 |
| `tool.started` | `session.event` + `type:'tool/call'` | `data.callId`、`data.name`、`data.arguments`（**原始 JSON 字符串**，需自己 parse）、`data.turn`/`data.step` | ⚠️ 只有"模型请求了这个调用"，没有开始执行的时刻戳（`event.time` 只是落盘时间）；⚠️ 没有结构化参数（字符串），解析失败要兜底；⚠️ 无工具 schema/展示元数据 |
| `tool.completed` | `session.event` + `type:'tool/result'` | `data.message.content[]`（结果块）、`data.message.toolCallId`、`data.message.isError`、`data.error{name,code,reason}`、`data.meta`（任意 JSON，工具私有） | ⚠️ 时长要自己用 `tool/call.time` 与 `tool/result.time` 相减；⚠️ `meta` 形状因工具而异，必须当不透明 JSON；⚠️ 没有"工具被拒绝"的专用事件（拒绝也表现为 `isError` 的 result） |
| `approval.required` | **无对应线上请求**。只能看到审计事件 `approval/asked` → `approval/decided` | `asked.data: {id, toolName, callId?, reason?}`；`decided.data: {id, outcome}`，`outcome` 只会是 `unavailable`（无 answerer 时） | ❌ **不可能真正"请求审批并等待"**：SDK 无双向通道；读到 `approval/asked` 时结果已定 ❌ 无法回写决策；❌ 事件不带工具参数（"The request carries no tool arguments"，`dsh-user-approval/README.md:155`）→ 只能给用户看工具名。正确定位：把 `approval/decided{unavailable}` 映射成 `tool.completed{isError}` 的通知或一条旁观提示 |
| `agent.completed` | `session.status` + `status:'idle'`（首选）；语义校验用 `turn/end` + `reason.kind:'completed'` | `sessionId`；若是 `turn/end` 还可得 `data.turn`、`data.reason` | ⚠️ `idle` 是**整 agent**，不是单 turn；⚠️ `blocked` / `max-tokens` / `interrupted` 也会以 idle 收尾，需读 `turn/end.reason` 才能区分"正常完成"；⚠️ `idle` 可能在本轮任何 step 之间短暂出现（未验证；`TODO(verify)`）；⚠️ 无 token/费用汇总（`usage` 分散在各 `assistant/message` 上，需自己累加） |
| `agent.failed` | `turn/end` + `reason.kind:'error'` → `data.reason.error: LlmFailure`；取消 → `reason.kind:'aborted'`（`reason.reason.kind`）；**`agent/error` 不是线上通知** | `LlmFailure{message,code,status?,providerRetryAfterMs?,requestId?}`；abort 的 cause | ❌ 拿不到 `agent/error` 事件本身；❌ 没有独立"错误事件"，必须从 `turn/end` 反推；⚠️ `session/wait` 在"有失败但无更新 `turn/end`"时会 reject，而在纯事件流模式里这种失败可能只体现为 idle + 空 `assistant/message`；⚠️ 重试过程只有 `llm/retry`/`llm/retry-started` 事件（payload 未读，`未验证`） |

补充映射建议（网关自用）：

| 网关内部事件 | 源 |
|---|---|
| `turn.started` | `turn/start{data.turn}` |
| `user.message.accepted` | `agent/inbox/spliced` 且 `data.inserted[].id === messageId` |
| `step.started` / `step.ended` | `step/start` / `step/end`（`{turn, step}`） |
| `assistant.attempt.failed` | `assistant/attempt`（有 `stream`，无 `message` → 无可见内容） |
| `agent.busy` | `session.status` + `status:'running'` |
| `approval.observed` | `approval/asked` + `approval/decided`（只读观测） |

---

## 11. Gotchas（naive 实现一定会踩）

1. **`session.event` 是全进程广播**：任何 session（含并发会话、subagent 子会话）的事件都会来。
   必须按 `params.sessionId` 过滤；要跟子 agent 就自己维护 `subagent.started` 血缘
   （SDK 的 `subscribeSessionTree` 就是这么做的，`lib/index.js:544-555`）。
2. **事件信封没有 `sessionId`**：把 `notification.params.sessionId` 跟事件拼在一起再往下传，
   否则持久化/去重时无法区分会话。
3. **先 `subscribe` 再 `prompt`**。反过来做有概率丢掉 `agent/inbox/spliced` 回执，
   于是"永远等不到 `received`"，循环卡死。
4. **不要用 `messageId` 去认领 assistant 消息**。协议明确说它只是入队回执；
   `run()` 也只能用"最后一条 `assistant/message`"近似归属。
5. **`idle` ≠ "我这次 prompt 结束了"**。可能有 steering/注入/并发 prompt；
   `idle` 只是"整个 agent 此刻没事干"。
6. **`status:'running'` 才是忙**。别把 `'busy'` 写进代码（不存在的字面量）。
7. **`requestTimeoutMs` 默认无限**：不配就永远不会因超时中止；配了则超时只是**放弃等待**，
   服务端 turn 继续跑（`client.d.ts:60-63`）。真正的兜底是"超时后 `close()` 整个 runtime"。
8. **`close()` 是终态**：关闭后 client 不可复用；`DeepSeekHarness` 关闭后再 `run()`
   也不会重连（`lib/index.js:750-753` + README:52）。
9. **`env` 传对象 = 整体替换父环境**（`types.d.ts:31-38`）。想保留 `DEEPSEEK_API_KEY`
   等凭据就别传 `env`，或自己 `{...process.env, ...}` 合并。
10. **`cwd` 有两个**：`HarnessClientOptions.processCwd` 是子进程 cwd；
    `initialize.cwd` 才是 session 的 workspace（还会写进 `SessionHeader.cwd`）。
    沙箱的 `workspaceRoot` 又是 `process.cwd()`（`dsh-base/cordis.patch.yml:243-245`），
    三者不一致会导致"文件写到想不到的地方"。
11. **受限 agent 的审批是"静默失败"不是"等人批"**：`workspace-write`（默认）+ 无 answerer →
    `unavailable` → 工具错误。想要"能干活"就得 `DSH_PERMISSION_MODE=danger-full-access`
    或注入自己的 answerer patch；否则模型会反复重试同一个被拒操作。
12. **`ask_user_question` 在 SDK profile 下同样没有答者**，会以工具失败收场
    （文案之一是 `Error: no user-questions answerer accepted the request`，见
    `dsh-user-questions/README.md:45`）；不要让模型陷入"必须问用户"的循环。
    其 timed-call 的 pending 窗口未实测 → `TODO(verify)`。
13. **`shutdown` 会 `process.exit(0)`**：`close()` 里发 `shutdown` 后子进程会自己退，
    紧接着的 SIGTERM/SIGKILL 阶梯是兜底。别把 `shutdown` 当"优雅停止单个会话"用。
14. **一个 runtime 里所有 session 共存亡**：`shutdown` dispose 全部（`performShutdown`）。
    要隔离 → 一会话一进程。
15. **stdout 是协议专用**：子进程组合里任何往 stdout 打日志的插件都会破坏 JSON-RPC 帧
    （`dsh-sdk-jsonrpc-server/README.md:46-48`）；自己加 patch 时尤其小心。
16. **`assistant/message` 可能带 `interrupted: true`**（被取消/中断的前缀），文本可能是
    半截的；如果把它当完整回答会出错。
17. **`tool/call.arguments` 是字符串**，且可能是非法 JSON（模型产出）；解析失败必须兜底。
18. **`tool/result.error` 只在 `message.isError === true` 时才存在**（`types.d.ts:379-387`）。
19. **`session/wait` 不创建 session**，未知 id 直接 reject（`SDK session: unknown SDK session: <id>`）；
    而 `session/working-directory/*` **会创建** session。两者语义相反，别搞混。
20. **`session/resume` 需要"原样的 home"**：`$DSH_HOME/sessions` 下按 `<normalized-cwd>` 分目录，
    cwd 变了/换 home 了都找不到 → `session "<id>" not found`（`-32603`）。
    另外还有跨进程写锁，恢复中的 session 不能被第二个进程再打开。
21. **别硬编码 `session.v3.jsonl`**：当前格式版本是 4（`SESSION_FORMAT_VERSION = 4`），
    但 persistence README 的示例表还写着 v3。按"最高 vN"选。
22. **`ignorable` 语义**：未知事件类型且无 `ignorable: true` 时，官方读路径会**拒绝重建会话**。
    网关做事件白名单过滤时不要"默默丢掉"，否则拿到的是被掏空的会话。
23. **`assistant/message.data.stream` 可能非常大**：它逐 delta 保存文本和时间，长回答会撑爆
    单条通知。网关最好在透传前删除该字段。
24. **`validatedSessionEvent()` 会抛 `SdkProtocolError`**：它校验 `assistant/message.content`、
    `turn/end.reason` 等字段。用它做边界校验，但要把异常接住，否则一条畸形事件会中断整个 turn 循环。
25. **`subagent.finished` 只报 in-process run**（远程 run 不报，`types.d.ts:104`），
    因此"等所有子 agent 完成"不能只靠它，要用 `session/wait` 或 `whenIdle` 语义。

---

## 12. 未解决问题（不要当成已确认）

| 问题 | 状态 |
|---|---|
| `turn/end` 是否总在 `session.status:idle` 之前投递？ | `未验证` —— 需要真实 runtime 观测；官方 `run()` 完全不等 `turn/end` |
| `idle` 是否会在同一 turn 的 step 之间短暂出现？ | `未验证` —— `agent/status` 由 agent loop 驱动，`session/wait` 里有 `agent.whenIdle()` + seq 双重确认，暗示 step 间不会，但没在 SDK 线上实测 |
| `assistant/message` 的落盘时刻（模型流结束 vs step 结束） | `未验证` —— 只确认了它是"per step 组装后的消息" |
| `llm/retry` / `llm/retry-started` / `session/title` / `compaction/*` 等的 payload 字段 | `未读` —— 只确认它们存在于 `KNOWN_SESSION_EVENT_TYPES` |
| `maxTokens` 与 `maxTokensAsSuccess` 对**根** turn 的影响 | `部分` —— `maxTokensAsSuccess` 服务端配置默认 `false`，其 `successStatus()` 把 `max-tokens` 映射为 `error`；SDK 侧只影响 `subagent.finished.status`，根 turn 的行为未实测 |
| 真实端到端联调（需要模型凭据） | `未做` —— 本文全部结论来自发布文件的静态证据 |

---

## 13. 实际读过的源文件清单（全部来自 npm `0.2.1-rc.3`）

根目录：`E:\Code\OceansLabWeb\dsh_oceanslab\.tmp\pkgs\`（解包自 `npm pack <pkg>@0.2.1-rc.3`）

| 包 | 文件 |
|---|---|
| `@deepseek-ai/dsh-sdk-client` | `deepseek-ai-dsh-sdk-client-0.2.1-rc.3\package\README.md` |
| | `...\package\lib\types\index.d.ts` |
| | `...\package\lib\types\api.d.ts` |
| | `...\package\lib\types\client.d.ts` |
| | `...\package\lib\types\types.d.ts` |
| | `...\package\lib\types\launch.d.ts` |
| | `...\package\lib\index.js`（完整读 `:330-909`，其余 grep） |
| `@deepseek-ai/dsh-sdk-protocol` | `deepseek-ai-dsh-sdk-protocol-0.2.1-rc.3\package\README.md` |
| | `...\package\lib\types\types.d.ts` |
| | `...\package\lib\types\transport.d.ts` |
| | `...\package\lib\index.js`（grep：错误码 `-32601`/`-32603`） |
| `@deepseek-ai/dsh-session` | `deepseek-ai-dsh-session-0.2.1-rc.3\package\lib\types\types.d.ts` |
| | `...\package\lib\types\known-event-types.d.ts` |
| | `...\package\lib\types\known-event-types.js` |
| `@deepseek-ai/dsh-llm` | `deepseek-ai-dsh-llm-0.2.1-rc.3\package\lib\types\message.d.ts` |
| | `...\package\lib\types\assistant-stream.d.ts` |
| | `...\package\lib\types\content.d.ts` |
| | `...\package\lib\types\types.d.ts`（`:26-...`、`:40-139`） |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | `deepseek-ai-dsh-sdk-jsonrpc-server-0.2.1-rc.3\package\README.md` |
| | `...\package\lib\index.js`（`:40-405`） |
| `@deepseek-ai/dsh-sdk-app` | `deepseek-ai-dsh-sdk-app-0.2.1-rc.3\package\cordis.patch.yml` |
| | `...\package\README.md` |
| `@deepseek-ai/dsh-base` | `deepseek-ai-dsh-base-0.2.1-rc.3\package\cordis.patch.yml`（grep + 上下文） |
| | `...\package\README.md`（grep：home/profile） |
| `@deepseek-ai/dsh` | `deepseek-ai-dsh-0.2.1-rc.3\package\README.md`（grep：profile/home） |
| | `...\package\lib\profile-boot-C14i-8IN.js`（grep：`resolveDshHome`） |
| `@deepseek-ai/dsh-home-paths` | `deepseek-ai-dsh-home-paths-0.2.1-rc.3\package\lib\index.js`（全文） |
| `@deepseek-ai/dsh-user-approval` | `deepseek-ai-dsh-user-approval-0.2.1-rc.3\package\README.md` |
| | `...\package\lib\types\types.d.ts` |
| | `...\package\lib\index.js`（grep：outcome 词表、瀑布 fallback） |
| `@deepseek-ai/dsh-user-questions` | `deepseek-ai-dsh-user-questions-0.2.1-rc.3\package\README.md`（grep：fail closed 文案） |
| `@deepseek-ai/dsh-agent` | `deepseek-ai-dsh-agent-0.2.1-rc.3\package\lib\types\types.d.ts`（`:40-95`） |
| | `...\package\lib\types\runtime-types.d.ts`（grep：`InboxTarget`、`AgentStatus`、`agent/status`、`agent/error`） |
| `@deepseek-ai/dsh-agent-loop` | `deepseek-ai-dsh-agent-loop-0.2.1-rc.3\package\lib\index.js`（`:1955-2023`，另 grep） |
| `@deepseek-ai/dsh-session-persistence` | `deepseek-ai-dsh-session-persistence-0.2.1-rc.3\package\lib\index.js`（grep：错误类与文案） |
| `@deepseek-ai/dsh-session-persistence-jsonl` | `deepseek-ai-dsh-session-persistence-jsonl-0.2.1-rc.3\package\README.md`（`:54-77`） |
| | `...\package\lib\index.js`（grep：`generationLogPath`、`SESSION_FORMAT_VERSION`、`open()`） |
