# 基于 DSH 的受限 Agent 平台实施方案

我建议将项目定位为一个 Agent Studio：保留 DeepSeek Harness（DSH）的核心能力，自己开发 Agent 管理、权限配置、MCP 管理和聊天页面。

技术方案确定为：Node.js + TypeScript + Vue3 + DSH Runtime + Cordis 插件。 不使用 .NET Core，也不需要 Fork DSH 源码。

## 一、总体设计

Agent Studio Web

Vue3 · TypeScript · Semi Design

Agent 管理

Agent 配置

聊天页面

MCP 管理

权限管理

运行日志

REST + SSE · WebSocket（可选）

Agent Gateway（Node.js）

REST API

DSH SDK

Session Manager

Agent Config

事件转换

用户认证

DSH 专用受限运行时

Agent Policy 插件

业务 Tool 插件

会话/权限上下文

日志与审计插件

原版 Agent Loop · Provider · Session · MCP · Skills · Memory

数据与外部服务

SQLite / PostgreSQL · MCP Servers · 业务 HTTP API

该架构有四个原则：

1. 不重写 Agent Loop：模型调用、上下文、工具执行、子智能体仍然使用 DSH。
2. 不修改 DSH 核心源码：通过独立 Profile 和 Cordis 插件增加能力。
3. 不把完整 DSH 管理权限暴露给前端：网页只访问你自己的 Agent Gateway。
4. 工具权限由服务端强制执行：Agent 能做什么，不由聊天提示词或前端按钮决定。

DSH 官方架构允许通过 Profile 组合插件，并通过 `ctx.tools`、`ctx.agents` 等扩展点自定义 Agent 行为，符合这套方案。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub

+1



## 二、具体采用什么接入方式？

建议第一版使用 DSH TypeScript SDK，而不是直接对接 DSH Web 的内部 API。

官方 `@deepseek-ai/dsh-sdk-client` 已经提供了创建会话、执行任务、订阅事件、恢复会话和处理工具审批的能力，SDK 底层通过 stdio JSON-RPC 管理 DSH 子进程。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



| 层             | 使用技术                    | 自己实现什么                  |
| ------------- | ----------------------- | ----------------------- |
| 用户页面          | Vue3 + Semi Design      | 聊天 UI、Agent 列表、权限配置     |
| Agent Gateway | Node.js + Fastify       | HTTP API、流式事件、身份认证      |
| SDK Bridge    | DSH TypeScript SDK      | 将网页请求转换成 DSH Session 操作 |
| Agent Policy  | 自定义 Cordis 插件           | 工具白名单、拒绝规则、审批           |
| Agent Runtime | 原版 DSH                  | 推理、工具调度、上下文、会话          |
| MCP           | DSH MCP Client          | 加载指定 MCP 服务及工具          |
| 数据存储          | SQLite 起步，后续 PostgreSQL | Agent 配置、访问权限、审计        |

第一版不需要做 DSH 原版界面的替代品，只需要实现自己的管理端和聊天端。

## 三、项目工程结构

建议采用 Monorepo，把 Web、Gateway、DSH 插件放在同一个仓库，便于统一管理版本。

```
agent-studio/
│
├── apps/
│   ├── web/                         # Vue3 前端
│   │   └── src/
│   │       ├── pages/
│   │       │   ├── agents/          # Agent 列表
│   │       │   ├── agent-editor/    # Agent 配置
│   │       │   ├── chat/            # 聊天
│   │       │   ├── mcp/             # MCP 管理
│   │       │   └── audit/           # 审计日志
│   │       ├── components/
│   │       │   ├── ChatPanel.vue
│   │       │   ├── ToolCallCard.vue
│   │       │   ├── ApprovalDialog.vue
│   │       │   └── AgentSelector.vue
│   │       └── services/
│   │           └── agent-api.ts
│   │
│   └── gateway/                     # Node.js 网关
│       └── src/
│           ├── api/
│           │   ├── agents.ts
│           │   ├── sessions.ts
│           │   ├── messages.ts
│           │   └── approvals.ts
│           ├── runtime/
│           │   ├── DshRuntimeManager.ts
│           │   ├── DshSessionManager.ts
│           │   └── DshEventAdapter.ts
│           ├── policies/
│           ├── repositories/
│           └── server.ts
│
├── plugins/
│   ├── agent-policy/                # 必须开发
│   ├── agent-tools/                 # 自定义业务工具
│   └── agent-audit/                 # 工具执行日志
│
├── packages/
│   └── shared/                      # 前后端共享类型
│
├── runtime/
│   ├── patches/                     # DSH 配置叠加
│   ├── policies/                    # 编译后的权限配置
│   └── workspaces/                  # 受限运行目录
│
└── data/
    └── agent-studio.db
```

采用 `pnpm workspace` 管理，各项目之间的依赖关系为：

- `web` 依赖 `shared`；
- `gateway` 依赖 `shared` 和 DSH SDK；
- DSH 插件依赖 Cordis 和相应 DSH 扩展 API；
- `gateway` 负责启动 DSH Runtime，不直接导入 DSH 内部 Agent Loop。

这样以后你可以单独升级 DSH SDK 和 Runtime，而不必重做 Web 页面。

## 四、Agent 配置设计

建议将 Agent 定义、运行权限、运行环境分开管理。

一个 Agent 不只是名称和提示词，还应该有下面这些配置。

## 示例：水环境智能助手

受限 Agent

| 模型       | DeepSeek V4.1       |
| -------- | ------------------- |
| 工作模式     | Native Tool Calling |
| 数据范围     | 指定业务数据集             |
| MCP      | 监测数据查询服务            |
| 系统 Shell | 禁止                  |
| 文件写入     | 禁止                  |
| 地图定位     | 允许                  |
| 生成报表     | 需审批                 |
| 子智能体     | 默认禁用                |

### 建议的配置对象

```

{
  "id": "water-quality-agent",
  "name": "水环境智能助手",
  "description": "负责水环境数据查询和分析",
  "status": "published",
  "version": 1,

  "model": {
    "provider": "opencode",
    "modelId": "deepseek-v4.1-flash",
    "temperature": 0.3,
    "maxOutputTokens": 8192
  },

  "prompt": {
    "system": "你是水环境业务智能助手，只能使用已授权的数据和工具。",
    "welcome": "你好，请问需要查询什么数据？"
  },

  "capabilities": {
    "tools": {
      "search_datasets": "allow",
      "query_station": "allow",
      "map_fly_to": "allow",
      "export_report": "ask"
    },
    "mcpServers": ["water-quality"],
    "skills": [],
    "subagents": false
  },

  "security": {
    "shell": false,
    "fileRead": false,
    "fileWrite": false,
    "pluginManagement": false,
    "networkAccess": "restricted",
    "dataScope": "user-authorized"
  },

  "limits": {
    "maxTurns": 20,
    "maxConcurrentRuns": 1,
    "maxRequestsPerHour": 30
  },

  "ui": {
    "showToolCalls": true,
    "showReasoning": false,
    "allowAttachments": false,
    "showModelSelector": false
  }
}

```

这个 JSON 是 Agent Studio 自定义业务配置，不是 DSH 原生配置格式。`temperature`、`maxTurns`、`networkAccess` 等字段需要在运行时管理器、模型适配或策略层分别落实；不能只保存 JSON 就认为已经生效。

另外，模型 ID 必须以实际 Provider 返回的名称为准。

### 运行时配置转换

每次发布 Agent 时，系统执行：

1

读取并校验 Agent 配置

2

生成不可变的权限策略版本

3

检查模型和 MCP 工具是否可用

4

生成或选择 DSH Profile Patch

5

启动受限 Runtime 并执行健康检查

6

将该版本标记为可供用户使用

配置修改后先创建新版本，不直接修改已有会话对应的权限快照。管理员可以禁用旧版本或撤销权限；撤销操作应立即在执行守卫处生效。

## 五、权限机制是整个系统的核心

我建议做成四层权限体系。

| 层级             | 主要作用               | 实施位置                    |
| -------------- | ------------------ | ----------------------- |
| 第 1 层：Agent 能力 | 允许哪些工具、Skills、MCP  | DSH 插件组合和 Tool Registry |
| 第 2 层：执行策略     | allow / deny / ask | Agent Policy 插件         |
| 第 3 层：用户授权     | 哪个用户能访问哪些业务数据      | Gateway + 业务工具          |
| 第 4 层：系统隔离     | 文件、进程、网络、凭据的实际权限   | 独立 Runtime / OS 沙箱      |

这四层不能相互替代。

例如，管理员允许 `query_station` 工具，但普通用户只能查询其授权区域内的监测站，真正的工具执行还必须校验站点归属和数据权限。

对于你目前的需求，建议采用两种工具：

Native 模式： 模型直接调用已注册的工具，便于管理每个工具的权限。DSH 已提供 Native 与 PTC 两种工具呈现方式。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



PTC 模式： 模型通过生成程序来组织工具调用。虽然 PTC 子工具也会进入工具执行流水线，但通用代码执行能力会显著增加审计复杂度。

因此，我建议受限 Agent 第一版统一使用 `native`，暂不开放 PTC、Shell 和任意代码执行。

## 六、具体开发 DSH Agent Policy 插件

这是整个方案中最重要的自定义插件。

DSH 已经提供两类与权限有关的扩展接口：

- `tools/pre-execute`：在执行前决定允许、拒绝或要求审批。
- `ctx.tools.guard()`：在实际执行前实施最终拒绝，不能被后续策略改回允许。

另外，`ctx.tools.restrict()` 可以控制 Agent 看到哪些继承工具，但不能替代强制权限校验。

[image](https://www.google.com/s2/favicons?domain=https://deepseek-harness.github.io\&sz=32)

DeepSeek Harness

+1



### 1. 插件代码

下面是一个采用固定权限快照的最小示例。一个受限 Runtime 只加载其被允许的工具及对应策略。

`plugins/agent-policy/src/index.ts`

```

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";

export const name = "agent-studio-policy";
export const inject = ["tools"];

// 示例：真实实现由可信启动配置提供，
// 严禁从用户消息或模型提示词读取权限。
const policy = {
  allowed: new Set([
    "search_datasets",
    "query_station",
    "map_fly_to",
    "export_report"
  ]),
  approvalRequired: new Set([
    "export_report"
  ])
};

export function apply(ctx: Context) {
  // 1. 强制工具白名单，默认拒绝
  ctx.effect(() =>
    ctx.tools.guard((exec) => {
      if (!exec.agent) {
        return "缺少 Agent 执行身份";
      }

      if (!policy.allowed.has(exec.name)) {
        return `工具 ${exec.name} 未获得授权`;
      }

      return undefined;
    })
  );

  // 2. 对需要确认的操作请求审批
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!policy.allowed.has(exec.name)) {
      return {
        kind: "deny",
        reason: "该工具未被允许"
      };
    }

    if (policy.approvalRequired.has(exec.name)) {
      return {
        kind: "ask",
        reason: "执行该工具需要用户审批"
      };
    }

    return next();
  });
}

```

这里使用的是 DSH 官方的 Cordis 插件结构和工具执行扩展点。

要特别注意：

- 示例中的白名单是固定的，正式实现应通过经过验证的策略配置加载。
- 这个插件只能限制通过 DSH Tool Registry 分发的工具；它不能代替底层操作系统隔离。
- 需要审批的工具必须配置实际的审批通道，否则 DSH 应拒绝执行。
- 不应在插件内通过临时修改全局变量来切换不同用户的权限。

对于正式版，建议让插件从启动时加载只读策略快照，并在需要撤销时通过可信控制通道更新策略。

### 2. 如何将插件加载到 DSH？

DSH 官方支持 `--patch` 叠加 Cordis 插件配置。

[image](https://www.google.com/s2/favicons?domain=https://deepseek-harness.github.io\&sz=32)

DeepSeek Harness



例如新建：

`runtime/patches/restricted.cordis.yml`

```
- insert:
    - id: agent-studio-policy
      name: "D:/AgentStudio/plugins/agent-policy/dist/index.js"
```

Windows 下采用实际编译后的绝对路径。

首次调试时可查看 DSH 组合后的插件树：

```
dsh --profile sdk --dump-config `
    --patch D:/AgentStudio/runtime/patches/restricted.cordis.yml
```

确认自定义插件确实出现在配置树中，然后由 SDK 使用同一个 Patch 启动运行时。

实际安装中还需要检查插件的构建产物和依赖解析是否正确。

### 3. 多个 Agent 如何隔离？

我不建议第一版将所有用户、所有不同权限的 Agent 都放在同一个 DSH 进程中。

尤其当某些 Agent 能查询数据，另一些还能执行 Shell 时，混合运行会明显增加权限隔离的复杂度。

建议：

Agent Runtime Manager

根据 Agent 配置、权限等级和用户身份选择运行环境

查询型

只读业务工具

受限

分析型

计算、报表

受限

开发型

文件、Shell

独立隔离

初期以每个会话一个独立 Runtime最容易做清晰的权限隔离、取消和故障恢复，但进程资源消耗较高。后续可以按相同权限策略和信任边界实现 Runtime 池。

## 七、Node.js Gateway 具体怎么调用 DSH？

建议在 Gateway 中封装一个 `DshRuntimeManager`，而不是让各个 HTTP Controller 分别创建 SDK 对象。

### 1. 核心 SDK 适配器

`apps/gateway/src/runtime/DshRuntimeManager.ts`

```

import { DeepSeekHarness } from
  "@deepseek-ai/dsh-sdk-client";

export interface RuntimeConfig {
  home: string;
  workspace: string;
  patch: string;
  provider: string;
  model: string;
}

export class DshRuntimeManager {
  private harness: DeepSeekHarness;

  constructor(config: RuntimeConfig) {
    this.harness = new DeepSeekHarness({
      profile: "sdk",
      dshHome: config.home,
      cwd: config.workspace,
      patches: [config.patch],
      provider: config.provider,
      model: config.model
    });
  }

  async run(
    message: string,
    sessionId?: string,
    onEvent?: (event: unknown) => void
  ) {
    return this.harness.run(message, {
      sessionId,
      onNotification: notification => {
        onEvent?.(notification);
      }
    });
  }

  async resume(sessionId: string) {
    return this.harness.resumeSession(sessionId);
  }

  async close() {
    await this.harness.close();
  }
}

```

这个封装使用了官方已文档化的 `DeepSeekHarness`、`run()`、`resumeSession()` 和 `close()`。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



关键是：`RuntimeManager` 由 Gateway 服务统一管理生命周期，一个 Runtime 可以持续处理同一会话的多轮对话。

不同 Agent 可以使用不同的 `provider`、`model`、`patch` 和工作目录，不必共享管理员自己的 DSH Profile。

### 2. 聊天接口

后端建议定义以下 API。

| 方法   | 路径                            | 功能              |
| ---- | ----------------------------- | --------------- |
| GET  | `/api/agents`                 | 查询已发布 Agent     |
| GET  | `/api/agents/:id`             | 获取 Agent 公开信息   |
| POST | `/api/agents`                 | 管理员创建 Agent     |
| PUT  | `/api/agents/:id`             | 管理员修改配置         |
| POST | `/api/agents/:id/publish`     | 发布配置版本          |
| POST | `/api/agents/:id/sessions`    | 创建会话            |
| GET  | `/api/sessions/:id/messages`  | 查询历史消息          |
| POST | `/api/sessions/:id/messages`  | 发送消息，SSE 返回执行事件 |
| POST | `/api/approvals/:id/decision` | 批准或拒绝操作         |
| GET  | `/api/agents/:id/tools`       | 查看该 Agent 可用工具  |
| GET  | `/api/audit/tool-calls`       | 管理员查看工具审计       |

这些都是 Agent Studio 自己提供的 HTTP API，不依赖 DSH 原版 Web 服务。

### 3. SSE 事件规范

不要把 DSH 原始通知直接交给前端渲染。

建议在 `DshEventAdapter` 中统一转换为你自己的事件协议。

```

type AgentEvent =
  | {
      type: "message.delta";
      sessionId: string;
      text: string;
    }
  | {
      type: "tool.started";
      sessionId: string;
      callId: string;
      tool: string;
    }
  | {
      type: "tool.completed";
      sessionId: string;
      callId: string;
      success: boolean;
    }
  | {
      type: "approval.required";
      sessionId: string;
      approvalId: string;
      tool: string;
      description: string;
    }
  | {
      type: "agent.completed";
      sessionId: string;
      text: string;
    }
  | {
      type: "agent.failed";
      sessionId: string;
      message: string;
    };

```

例如用户发送消息后，Gateway 可能依次推送：

```
event: tool.started
data: {"tool":"query_station","callId":"call-001"}

event: tool.completed
data: {"callId":"call-001","success":true}

event: agent.completed
data: {"text":"查询完成，监测数据如下..."}
```

实际 DSH 通知需要通过 SDK 事件结构进行映射，不能假设原始通知本来就是这些名称。

特别注意，DSH 的 `run()` 在 Agent 进入 idle 后才返回最后一条已提交的助手文本。要实现真正的逐字流式显示，需要处理对应的流式通知，不能只在任务结束后拆分 `finalResponse` 冒充实时流。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



### 4. 审批需要双向通信

如果 Agent 请求 `export_report` 之类的操作：

1. DSH 发起审批请求。
2. Gateway 生成对应的待审批记录，并推送给前端。
3. 前端显示操作名称、参数摘要和风险信息。
4. 用户选择允许一次或拒绝。
5. Gateway 验证用户身份与审批归属。
6. 通过 SDK 的请求响应机制把结果送回 DSH。

目前官方 SDK 的 `client.onRequest()` 已支持处理 `approval/request`，决定值包括 `allowed-once`、`rejected` 和 `cancelled`。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



因此审批页面不必自己重新实现 DSH 的底层授权协议，只需实现网页交互和 Gateway 中的异步请求关联。

还应强制审批超时后拒绝，并禁止把一次审批扩展为永久授权。

## 八、前端页面详细设计

建议使用 Vue3 + TypeScript + Semi Design，采用经典的左右布局，管理员和普通用户分别拥有不同入口。

### 页面 1：Agent 管理

## Agent 管理

创建、配置、测试和发布智能体

页面设计

# 8

全部 Agent

# 5

已发布

# 3

草稿

&#x20;新建

水环境智能助手

监测数据与历史趋势查询

已发布

DeepSeek V4.1

4 个工具

数据分析助手

统计分析与报表生成

已发布

GPT / Codex

6 个工具

文档助手

文档检索与内容总结

草稿

DeepSeek

2 个工具

以上为静态界面样例数据，实际项目中由 Agent 配置 API 提供。

### 页面 2：Agent 编辑器

编辑页面建议采用顶部标题栏 + 左侧配置导航 + 右侧设置内容，而不是把所有内容放在同一个表单中。

| 页签    | 配置内容                            |
| ----- | ------------------------------- |
| 基本信息  | 名称、描述、系统提示词、欢迎语                 |
| 模型设置  | Provider、模型、推理参数、Token 限额       |
| 工具能力  | DSH Tools、MCP 工具、Skills、子 Agent |
| 权限管理  | allow / deny / ask、数据范围、系统限制    |
| 会话配置  | 历史记录、附件、上下文、超时                  |
| 测试与发布 | 测试聊天、权限模拟、发布版本                  |

其中工具能力页要展示 DSH 实际发现的工具清单。MCP 工具则按服务器分组，管理员可以逐项授权，而不是只能打开或关闭整个 MCP Server。

### 页面 3：普通用户聊天

这一页应保持简单。

水环境智能助手

监测查询 · 数据分析

查询某监测站最近一周的水质变化。

智能助手

监测站信息查询完成

历史监测数据读取完成

已获取该站点最近一周的监测记录，可以继续查看具体指标及变化趋势。

监测趋势

2.733.33.63.910/1910/2010/2110/2210/2310/2410/25

示例数据，非实际监测记录

请输入需要查询的问题...

聊天界面布局示意。趋势图仅用于展示组件位置，未连接真实数据。

聊天页应根据 Agent 配置决定是否提供附件上传、模型切换、工具调用详情、推理状态等功能。即使 UI 不显示工具过程，服务端仍然要执行完整的权限检查与审计。

## 九、数据存储设计

第一版可以直接使用 SQLite，不需要部署复杂的数据库服务。面向多用户、分布式运行后再考虑 PostgreSQL。

我建议最少设计以下七张表：

| 数据表                 | 作用           | 核心字段                               |
| ------------------- | ------------ | ---------------------------------- |
| `agents`            | Agent 基础信息   | id、name、status、owner_id            |
| `agent_versions`    | 已发布配置快照      | agent_id、version、config_json       |
| `agent_permissions` | 工具权限规则       | version_id、tool_name、action        |
| `mcp_servers`       | MCP 服务配置     | id、transport、config、enabled        |
| `agent_sessions`    | 业务与 DSH 会话关联 | id、user_id、agent_id、dsh_session_id |
| `agent_messages`    | 聊天展示数据       | session_id、role、content、sequence   |
| `agent_tool_audit`  | 工具执行审计       | call_id、tool、decision、status、time  |

如果后续使用多个 DSH Runtime，还需要增加运行时实例表，记录 Profile、策略版本、进程状态和资源占用。

### 会话特别需要注意

建议业务系统的 `sessionId` 和 DSH 的原始 `sessionId` 分开保存。

例如：

```
{
  "id": "business-session-001",
  "userId": "user-1001",
  "agentId": "water-quality-agent",
  "agentVersion": 1,
  "dshSessionId": "实际DSH会话ID",
  "runtimeId": "runtime-001",
  "status": "idle"
}
```

用户每次发送消息，Gateway 必须先检查当前用户是否拥有这个会话，再去查找对应的 DSH Runtime。

恢复持久化 DSH 会话应使用 SDK 的 `resumeSession()`；不能仅靠传入旧 ID 就认为历史已经恢复。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



## 十、部署方式

第一版可以采用 Windows 本地开发和部署，不必先引入 Docker。

Windows 主机

Web 前端

Vue3 构建后的静态文件

由 Gateway 或 Nginx 提供访问

Node.js Gateway

Fastify HTTP 服务

运行时管理、认证、聊天、审批

DSH 子进程

SDK Profile + 限权插件

通过 stdio JSON-RPC 通信，不需要开放独立公网端口

建议先使用固定版本安装 SDK：

```
npm install @deepseek-ai/dsh@0.2.1-rc.2 `
  @deepseek-ai/dsh-sdk-client@0.2.1-rc.2
```

这条命令以你之前使用的版本为目标；实际安装前应确认 npm 上两个包都发布了对应版本。不要混用不同版本的 Runtime 与 SDK。

可以先单独运行以下最小测试：

```
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

const harness = new DeepSeekHarness({
  profile: "sdk",
  provider: "deepseek-official",
  model: "deepseek-v4-flash"
});

try {
  const result = await harness.run("你好");
  console.log(result.finalResponse);
} finally {
  await harness.close();
}
```

模型名称与 Provider 必须改成你当前环境实际可用的配置。

注意，这段代码只用于验证基础 SDK 能否运行，还没有施加受限 Profile 或权限插件，不能把这个原型直接暴露给普通用户。

## 十一、实际开发的优先级

建议分四阶段落地。

| 阶段      | 要实现的功能                       | 验收标准                     |
| ------- | ---------------------------- | ------------------------ |
| P0：基础接入 | SDK、Gateway、Vue 聊天、多轮会话      | 可以连续对话，并在页面展示 Agent 执行结果 |
| P1：安全控制 | Agent 配置、白名单、Guard、审批、隔离     | 未授权工具确实无法执行              |
| P2：管理平台 | Agent 编辑、MCP、Skills、发布、历史和日志 | 管理员可以创建并发布多个不同能力的 Agent  |
| P3：平台增强 | Runtime 池、多用户、记忆、监控、嵌入组件     | 多用户并发稳定，能持续运行和恢复         |

其中 P1 必须在提供给普通用户之前完成，而不是等功能开发完再补安全机制。

## 十二、几个非常关键的实施细节

1\. 不能直接照搬你当前个人 DSH 的全部插件。 需要为受限环境建立独立的 SDK Profile、DSH Home、配置和凭据，尤其是插件管理、Shell、文件系统、浏览器自动化等高权限能力。

2\. 不要通过系统提示词控制权限。 即使系统提示词写了“禁止访问文件”，如果 Agent 的工具注册表中仍存在可执行命令的工具，就不构成真正的安全限制。

3\. 业务工具要做参数级授权。 仅允许 `query_station` 还不够，工具内部还要校验用户是否有权读取对应站点和数据集。

4\. SDK 的取消功能有限。 当前 SDK 文档说明没有通用的中途取消单轮任务接口。因此初版“停止生成”需要谨慎处理，必要时关闭对应 Runtime。复用 Runtime 池时尤其不能直接关闭承载其他用户任务的进程。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



5\. DSH 的版本还在快速变化。 官方明确处于预览阶段，核心 API 可能发生变动。建议固定版本，并为 SDK、权限插件、MCP、会话恢复和审批建立自动化测试。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



## 最终推荐的实现组合

| 模块         | 技术选择                            |
| ---------- | ------------------------------- |
| Agent 引擎   | 原版 DeepSeek Harness             |
| Agent 执行接口 | `@deepseek-ai/dsh-sdk-client`   |
| 插件开发       | Cordis + TypeScript             |
| 权限控制       | 自定义 Agent Policy 插件             |
| Gateway    | Node.js + Fastify               |
| Web 前端     | Vue3 + TypeScript + Semi Design |
| 流式交互       | SSE                             |
| 审批交互       | SDK Request Handler + Gateway   |
| 数据库        | SQLite，后续 PostgreSQL            |
| MCP        | 原版 DSH MCP Client               |
| 状态管理       | Pinia                           |
| Runtime 隔离 | 独立 Profile、DSH Home、进程和权限       |

最值得优先做的不是整个管理后台，而是先跑通一条完整链路：

创建受限 Agent → 选择模型和工具 → 发送消息 → DSH 执行 → 工具权限检查 → 返回流式结果 → 页面展示。

当这一条链路打通并验证权限可靠之后，其他的 Agent 管理、MCP 管理、发布、嵌入和运行监控，基本都是围绕已有核心能力继续扩展。

参考文档：[DSH 官方插件开发](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/?utm_source=chatgpt.com)、[DSH TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md?utm_source=chatgpt.com)、[DSH Tools 和权限扩展接口](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools?utm_source=chatgpt.com)。