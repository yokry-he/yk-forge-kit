# YKForgeKit 本地开发（工程骨架）

当前提供 Vue 控制台、NestJS API、共享 TypeScript 契约和 Vue Web 项目创建能力。用户中心、业务资产市场、云部署尚未实现。

## 环境要求

本机运行真实 Docker 构建并打开静态预览链接，见 [本地 Docker 构建与预览](./local-docker-preview.md)。

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

API 开发模式使用 `tsx watch`。新增 NestJS 构造器依赖时，请用 `@Inject(服务类)` 显式声明注入对象，因为 tsx 不会生成类型元数据。

根目录 `dev` 会先按依赖顺序构建 API 与控制台的全部依赖包（包括 db、contracts），干净检出可直接执行。`corepack pnpm --filter @forgekit/db db:check` 同样会先构建 db 及其依赖。单独启动 API 前，应先执行 `corepack pnpm --filter @forgekit/api^... build`。

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
corepack pnpm test:startup
```

`test:startup` 在临时目录复制无 `dist` 的工作区并复用已安装的第三方依赖，验证根目录 `dev` 的 API 健康接口及 `db:check` 的模块加载；后者在无数据库配置时应明确报告缺少 `DATABASE_URL`。该检查不连接数据库，不删除当前工作区的编译产物，CI 在其他构建之前运行。中文为当前权威文档，英文对应指南尚待对外发布前补齐。

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

平台内置一个示范资产 `official.theme@1.1.0`。项目创建时选择 `theme`，会通过同一套资产安装器集成主题并写入 `.forgekit/assets.lock.json`。

```bash
node packages/cli/dist/index.js asset list
node packages/cli/dist/index.js asset plan official.theme --dir /path/to/my-app
node packages/cli/dist/index.js asset add official.theme --dir /path/to/my-app
```

建议先执行 `plan` 检查将创建或修改的文件，再执行 `add`。已有目录或受管理文件被用户修改时，不会静默覆盖；已安装且未变化的同版本资产重复执行为幂等操作。

升级与卸载需要先预览，再明确确认：

```bash
node packages/cli/dist/index.js asset upgrade official.theme --dir /path/to/my-app --dry-run
node packages/cli/dist/index.js asset upgrade official.theme --dir /path/to/my-app --yes
node packages/cli/dist/index.js asset remove official.theme --dir /path/to/my-app --dry-run
node packages/cli/dist/index.js asset remove official.theme --dir /path/to/my-app --yes
```

当前仅支持从已知 `1.0.0` 到 `1.1.0` 的主题升级及安全卸载，**尚不支持远程 Registry、任意第三方资产迁移或自动合并用户修改**。锁文件指纹用于本地变化检测，不是数字签名。

控制台提供三步配置与文件预览，当前通过复制上述 CLI 命令完成本地创建，不会直接在浏览器写入文件。

API 允许的开发前端 Origin 默认为 `http://localhost:5173`，可通过 `CONSOLE_ORIGIN` 配置；API 端口可由 `PORT` 调整，若修改端口需同时修改 Vite 代理设置。

此版本没有认证、数据库或用户代码执行能力，不能作为生产系统部署。

构建队列开发：根 `pnpm dev` 同时启动 worker；没有 DATABASE_URL 或 REDIS_URL 时 worker dev 打印 disabled。使用真实队列需要 Redis 7 和完成迁移的 MySQL，详见 [构建队列与 Worker](./worker-build-queue.md)。当前空构建不执行用户源码。

## Android 打包

uniapp 项目可通过控制台「Android 打包」配置包名、版本与只写发布签名，触发自有 Docker 执行机上的 APK / AAB 任务，查看日志并下载带 SHA-256 的安装包。需预先准备匹配的官方离线 SDK 镜像与 DCloud AppKey；平台当前仍从模板生成源码。真实原生工具链和真机需按 [Android 打包指南](./android-packaging.md) 验收，iOS 为后续工作。
