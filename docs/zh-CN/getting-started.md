# ForgeKit 本地开发（工程骨架）

当前提供 Vue 控制台、NestJS API、共享 TypeScript 契约和 Vue Web 项目创建能力。用户中心、业务资产市场、云部署尚未实现。

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
corepack pnpm test
corepack pnpm build
```

## 创建一个 Vue 项目

先在仓库根目录构建 CLI：

```bash
corepack pnpm build
node packages/cli/dist/index.js create my-app --features theme,router,pinia
```

默认启用 `theme`，可通过 `--features none` 创建不含可选功能的基础项目。

支持的能力：`theme`（主题）、`router`（Vue Router）、`pinia`（状态管理）。
默认生成到当前目录下的项目名子目录；可使用 `--dir /absolute/parent/path` 指定父目录。目标目录已经存在时 CLI 会拒绝覆盖。

生成后：

```bash
cd my-app
corepack pnpm install
corepack pnpm build
corepack pnpm dev
```

## 资产预览与安装（MVP）

平台内置一个示范资产 `official.theme@1.0.0`。项目创建时选择 `theme`，会通过同一套资产安装器集成主题并写入 `.forgekit/assets.lock.json`。

```bash
node packages/cli/dist/index.js asset list
node packages/cli/dist/index.js asset plan official.theme --dir /path/to/my-app
node packages/cli/dist/index.js asset add official.theme --dir /path/to/my-app
```

建议先执行 `plan` 检查将创建或修改的文件，再执行 `add`。已有目录或受管理文件被用户修改时，不会静默覆盖；已安装且未变化的同版本资产重复执行为幂等操作。

当前只支持安装，**尚不支持资产升级、卸载、远程 Registry 或自动合并用户修改**。锁文件内的本地指纹用于发现变化，不是数字签名；未来资产分发与签名验证会单独设计。

控制台提供三步配置与文件预览，当前通过复制上述 CLI 命令完成本地创建，不会直接在浏览器写入文件。

API 允许的开发前端 Origin 默认为 `http://localhost:5173`，可通过 `CONSOLE_ORIGIN` 配置；API 端口可由 `PORT` 调整，若修改端口需同时修改 Vite 代理设置。

此版本没有认证、数据库或用户代码执行能力，不能作为生产系统部署。
