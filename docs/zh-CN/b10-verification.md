# B10 验证记录

实现与契约见[构建控制台](./build-console.md)和 [ADR-0010](../adr/0010-build-log-streaming.md)。本记录仅保留可在仓库根目录运行的命令、验证结果与限制。

## 复现命令

使用仓库要求的 Node.js >=22 和锁定的 pnpm 版本，安装依赖后运行：

```sh
pnpm --filter @forgekit/console test
pnpm build
pnpm typecheck
pnpm test
```

## 本轮验证（2026-11-19）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm --filter @forgekit/console test` | 0 | 151 项通过 |
| `pnpm build` | 0 | 全仓构建通过；Vite 报告 Zod PURE 注释解析警告 |
| `pnpm typecheck` | 0 | 全仓严格类型检查通过 |
| `pnpm test` | 0 | 453 项通过、17 项按环境条件跳过；其中 console 151、API 79 项通过 |

回归覆盖 stdout/stderr/system 独立的分块 OSC/CSI 解析、日志组件文本渲染与单次清理，以及首屏刷新与轮询/分页重叠时的请求归属。旧请求在新请求之前或期间完成，都不得阻断后续请求或释放新请求的忙碌状态。

## 验证限制

默认测试中的 MySQL、Redis、Docker、CLI 模板冒烟和真实 Keycloak 用例依赖额外环境；跳过项不表示已完成集成验收。本轮未另行启动这些服务，也未运行真实浏览器验收，组件测试不替代真实布局、滚动与 IdP 端到端检查。

英文关键指南与日志自动保留期任务尚未交付；当前没有自动删除日志。中文为权威文档，公开发布前须补齐关键指南的英文对应版本。
