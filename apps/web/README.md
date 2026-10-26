# Agent Studio 控制台（apps/web）

Vue 3 + TypeScript + Semi Design（`@aifuxi/semi-ui-vue` 2.x）实现的管理端与聊天端。
所有类型来自 `@agent-studio/shared`，页面不自定义 HTTP 形状。

## 路由

| 路径 | 名称 | 说明 |
| --- | --- | --- |
| `/login` | `login` | 账号密码登录，token 存 Pinia + localStorage |
| `/agents` | `agents` | Agent 列表、统计、筛选、新建 |
| `/agents/:id/edit` | `agent-editor` | 六个配置页签、保存与发布 |
| `/chat/:agentId?` | `chat` | 会话列表 + 事件流聊天 + 审批弹窗 |
| `/mcp` | `mcp` | MCP 服务器增删改查与连接测试（仅管理员） |
| `/audit` | `audit` | 工具调用审计，筛选 + 分页 + 详情（仅管理员） |

`/` 重定向到 `/agents`，未知路径回落到 `/agents`。未登录访问受保护路由会跳转
`/login?redirect=<原路径>`；`/mcp`、`/audit` 对 `role: 'user'` 隐藏并由路由守卫拦截。

## 目录

```
src/
  services/   http（鉴权/错误/401）、sse（fetch + ReadableStream 解析）、agent-api（契约封装）、feedback（Toast 文案）
  stores/     auth / agents / chat / mcp（Pinia setup store）
  components/ ChatPanel、ToolCallCard、ApprovalDialog、AgentSelector、StatusTag、EmptyState、PageHeader
  layouts/    AppLayout（左侧导航 + 顶栏）
  pages/      login / agents / agent-editor（+ tabs）/ chat / mcp / audit
  ui/         内联 SVG 图标
  utils/      时间与数字格式化、状态词表
  styles/     global.css（Semi token 之上的布局与业务样式）
```

## 本地开发

```bash
# 仓库根目录，仅由 Lead 执行安装
npm install --cache .npm-cache --no-audit --no-fund

# 开发（5173，/api 代理到 127.0.0.1:8787）
npm run dev -w @agent-studio/web

# 类型检查 / 构建
npm run typecheck -w @agent-studio/web
npm run build -w @agent-studio/web
```

直接调用本地二进制（不经过 npm script）：

```bash
node node_modules/vue-tsc/bin/vue-tsc.js -p apps/web/tsconfig.json --noEmit
cd apps/web && node ../../node_modules/vite/bin/vite.js build
```

## 实现约定

- SSE 用 `fetch` + `ReadableStream` 手工解析（`EventSource` 不支持 POST），收到
  `agent.completed` / `agent.failed` / `run.limit` 后主动收流并取消响应体。
- `message.delta` 的 `mode: 'delta'` 累加文本，`mode: 'message'` 覆盖整段文本。
- 工具调用按 `callId` 合并 `tool.started` / `tool.completed`；审批挂起时把
  `approvalId` 记到最近一个运行中的工具卡片上，拒绝或超时后置为 denied。
- 所有写操作在使用前先校验；失败统一通过 Semi `Toast` 或页面 `Banner` 提示，
  不产生未处理的 Promise。
- 网关不可用时每个页面都退化为骨架屏 / 空状态 + 非阻塞错误提示，不出现白屏。

## 已知限制

- 编辑器「工具能力」依赖 `GET /api/agents/:id/tools`；网关未实现时展示空状态并允许重试。
- 聊天页欢迎语来自 `GET /api/agents/:id` 的 `draft.prompt.welcome`；无权限时退化为通用文案。
- 附件上传与模型切换在受限运行时下不可用，界面不展示对应入口。
- 本仓库的沙箱环境无法为 esbuild 建立带管道的子进程（`spawn EPERM`），因此
  `vite build` 需要在不受该限制的终端执行；类型检查不受影响。
