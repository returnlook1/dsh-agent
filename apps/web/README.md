# Agent Playground（apps/web）

一页式的 DSH Agent 能力测试台：左栏配置并创建对话，右栏按 SSE 业务事件渲染消息与工具调用。
没有登录、用户体系、Agent 编辑器与 MCP 管理；MCP 列表只读，来自服务端
`config/mcp-servers.json`。

## 路由

| 路径 | 名称 | 说明 |
| --- | --- | --- |
| `/` | `playground` | 新对话态：左栏配置，右栏空态说明 |
| `/c/:conversationId` | `conversation` | 同一页面加载该对话的消息与工具调用历史 |

未知路径回落到 `/`。刷新 `/c/:id` 时通过 `GET /api/conversations/:id/messages` 回放历史。

## 目录

```
src/
  services/   agent-api.ts（HTTP + 响应窄化 + 统一错误）、sse.ts（纯函数 SSE 帧解析）
  stores/     config（项目能力）、conversation（历史/消息/SSE 归并）、ui（健康检查 + Toast）
  components/ ConfigPanel、SkillSelect、McpSelect、ChatPanel、MessageBubble、
              ToolCallCard、ConversationList、ConversationMeta、StatusBadge
  pages/      PlaygroundPage（组合两栏 + 切换确认）
  utils/      format（时间/耗时）、clipboard
  styles/     global.css（Semi token 之上的布局与聊天样式）
tests/        sse.test.ts（分块 / CRLF / 注释 / 多行 data / message.failed 提前终止）
```

## 契约

唯一后端契约是 `docs/SERVICE.md` §7（HTTP）与 §8（SSE），类型全部来自
`@agent-studio/shared`。前端只消费 5 个业务事件：

- `message.started`（role=user）→ 确认本地乐观用户气泡；
- `message.completed` → 按 `messageId` 去重追加助手消息（同一轮可多条）；
- `tool.started` / `tool.completed` → 按 `callId` 归并到当前轮助手消息下方的工具卡片；
- `message.failed` → Banner 错误 + 失败状态，结束本轮。

不解析 DSH 原始通知，不做 token 级打字机（后端没有 delta 事件）。

## 本地开发

```bash
# 仓库根目录（依赖由 Lead 安装）
npm run dev -w @agent-studio/web        # 5173，/api 代理到 127.0.0.1:8787
npm run typecheck -w @agent-studio/web
npm run build:web
npx vitest run apps/web                 # SSE 解析单测
```

## 约定

- 所有请求错误都转成可见提示（Semi `Banner` / `Toast`），不产生未处理 rejection；
- 发送中禁用重复提交；切换对话时若上一轮仍在跑会弹窗确认，确认后只解绑本地流，
  服务端仍会跑完并落库（符合 SERVICE.md §8.7）；
- 「新建对话」显式发送左侧当前选择并使用 `inheritProjectConfig: false`，避免
  取消勾选的 Skills/MCP 被项目配置的并集加回；项目默认仍可通过「保存为项目默认」维护；
- 健康检查失败时右上角状态置灰并可重试，不阻塞页面使用。
