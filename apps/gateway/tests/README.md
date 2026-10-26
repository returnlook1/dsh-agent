# Gateway 测试

```bash
npm test                        # 全部单测（含插件与网关）
npx vitest run apps/gateway     # 只跑网关
npx vitest run apps/gateway --reporter=verbose
```

测试本身不启动 DSH 子进程、不联网、不读开发者 `DSH_HOME`；数据库全部落在
`.tmp/gw-test-*` 临时目录并在结束后删除。

真实运行时链路的验证不在这里（需要启动子进程与本地端口）：

```bash
npm run smoke                   # 5 个安全场景（真实 DSH + mock 模型）
npm run e2e                     # 网关 HTTP/SSE 端到端（含审批批准/拒绝）
```

覆盖范围见 [docs/VERIFICATION.md](../../docs/VERIFICATION.md)。
