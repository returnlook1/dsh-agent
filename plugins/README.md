# Cordis 插件

运行在 DSH 运行时子进程内（`@deepseek-ai/dsh@0.2.1-rc.3`）的插件。当前只有一个：
**`agent-tools`**，作为"如何给 Agent 增加业务工具"的示例。上一个大版本里的
`agent-policy`（工具策略/审批）与 `agent-audit`（审计）已随平台精简而移除，
原因见 `docs/DECISIONS.md` §2。

| 插件 | 职责 | 注册方式 |
| --- | --- | --- |
| `agent-tools` | 4 个业务工具 + 构建产物 `dist/catalog.json` | `ctx.tools.register(defineTool(...))` |

它在运行时里的挂载点：

```yaml
# runtime/templates/agent-service/cordis.patch.yml
- insert:
    - id: agent-tools
      name: '{{TOOLS_PLUGIN}}'      # 绝对路径，由服务物化时替换
```

不需要业务工具时，把这一段从模板删掉即可——它们彼此独立。

## 1. `agent-tools`

### 工具清单

| 工具 | 参数 | 风险 | 说明 |
| --- | --- | --- | --- |
| `search_datasets` | `keyword: string`（1..80） | low | 在数据集目录里按关键词检索 |
| `query_station` | `stationId: string`、`days: integer`（1..30） | low | 读取站点最近 N 天的监测序列 |
| `map_fly_to` | `longitude`（-180..180）、`latitude`（-90..90）、`zoom?`（1..18） | low | 让前端地图定位到指定点 |
| `export_report` | `stationId: string`、`format: 'pdf' \| 'xlsx'` | high | 生成报表任务并写到输出目录 |

参数边界（如 `days` 的 1..30）在 `execute()` 内校验：`defineTool` 的参数 DSL 没有
min/max（见 `docs/RESEARCH-TOOLS.md` §1）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_STUDIO_TOOLS_DATA_DIR` | `<cwd>/.studio/data` | `datasets.json` / `stations.json` 所在目录 |
| `AGENT_STUDIO_OUTPUT_DIR` | `<cwd>/.studio/output` | 报表输出目录 |
| `AGENT_STUDIO_ALLOWED_STATIONS` | – | 逗号分隔的站点白名单；设置后只能查询名单内的站点（参数级授权示例） |

服务在物化运行时会把 `<repo>/runtime/tools/*.json` 复制进快照的 `workspace/.studio/data`，
并通过 `AGENT_STUDIO_TOOLS_DATA_DIR` 指过去，所以 Agent 看不到仓库里的原始文件。

### 数据契约

```jsonc
// datasets.json
{ "datasets": [ { "id": "...", "name": "...", "description": "...", "tags": ["..."] } ] }

// stations.json
{ "stations": [ {
    "id": "ST-3101", "name": "东湖一号监测站",
    "readings": [ { "day": "2026-09-26", "value": 7.85, "indicators": { "ph": 8.01 } } ]
} ] }
```

`readings[].value` 是该站的代表指标（示例用溶解氧 mg/L）；`indicators` 是附加指标，
加载器只取 `day`/`value`。数据由 `npm run data:demo` 确定性生成。

### 开发

```powershell
npm run build -w @agent-studio/plugin-agent-tools     # tsc + 生成 catalog.json
npm run typecheck -w @agent-studio/plugin-agent-tools
npx vitest run plugins/agent-tools
```

`dist/catalog.json` 由 `scripts/build-catalog.mjs` 从编译后的模块生成，测试会断言
"目录 ↔ 注册工具"一致（漏更新会失败）。

### 约束

- 运行时只允许从 `@deepseek-ai/dsh-tools` 引入 `defineTool`（纯函数工厂，版本与运行时一致）；
  其它 `@deepseek-ai/*` 依赖只能是 `import type`。
- 工具执行必须观察 `exec.signal`；输出要确定性（同一输入同一结果）。
- 工具抛错会被注册表转成 `isError` 结果，模型能看到错误文本；不要让进程崩溃。
