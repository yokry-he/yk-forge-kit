# ForgeKit 本地开发（工程骨架）

当前仅提供 Vue 控制台、NestJS API、共享 TypeScript 契约以及 CLI 最小骨架；项目创建、资产安装和部署功能尚未实现。

## 环境要求

- Node.js 22 或更高版本
- Corepack（使用仓库声明的 pnpm 版本）

## 启动

```bash
corepack enable
corepack pnpm install
corepack pnpm dev
```

- Web 控制台：`http://localhost:5173`
- API 健康检查：`http://localhost:3001/api/v1/health`

单独运行：

```bash
corepack pnpm --filter @forgekit/api dev
corepack pnpm --filter @forgekit/console dev
corepack pnpm --filter @forgekit/cli dev -- version
```

验证：

```bash
corepack pnpm typecheck
corepack pnpm build
```

API 允许的开发前端 Origin 默认为 `http://localhost:5173`，可通过 `CONSOLE_ORIGIN` 配置；API 端口可由 `PORT` 调整，若修改端口需同时修改 Vite 代理设置。

此版本没有认证、数据库或用户代码执行能力，不能作为生产系统部署。
