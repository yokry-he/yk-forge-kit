# 使用现有 Docker MySQL

状态：第一版数据库基础设施。尚未连接用户自己的 Docker MySQL，也未执行迁移。

## 技术方案

- 数据库：用户现有 Docker MySQL **8.0**（当前开发基线）。
- 驱动：mysql2 连接池。
- ORM 与迁移：Drizzle ORM / Drizzle Kit。
- 数据包：@forgekit/db，独立于 Vue UI 和 NestJS 业务层。
- 不创建新 Docker 数据库容器，也不在应用启动时自动执行迁移。

## 连接配置

环境变量使用 DATABASE_URL，格式为 mysql://user:password@host:port/database。仓库根目录 .env.example 仅是占位示例，不包含真实凭证。

- **当前开发阶段**：API 在本机运行，MySQL 8.0 在 Docker 中。使用已映射到宿主机的地址及端口，例如 `127.0.0.1:3306`；若映射到 `3307:3306`，则使用 `127.0.0.1:3307`。
- **后续容器化阶段**：API 与 MySQL 在同一 Docker 网络时，使用 MySQL 的服务名及容器内部端口（如 `mysql:3306`），不可再使用 `127.0.0.1` 指向 MySQL，因为它会指向 API 容器自身。
- 远程执行环境无法直接访问用户电脑的 localhost；不要为方便调试而暴露 MySQL 公网端口。

两个阶段保持同一个 `DATABASE_URL` 配置键，仅改变运行环境中的值，业务代码不感知部署位置。后续增加 Docker Compose 时应使用内部网络、数据库健康检查和启动依赖，不在项目仓库中写入真实密码。

建议为 YKForgeKit 使用独立数据库、最小权限账号和独立业务表，不使用 root 账号。创建数据库及授权需先确认现有实例情况。

## 本地开发与检查

先运行 `docker ps` 确认 MySQL 8.0 容器的宿主机端口映射（例如 `127.0.0.1:3307->3306/tcp`），确保 MySQL 已正常启动。将 `.env.example` 复制为 `apps/api/.env`，再配置实际 `DATABASE_URL`（该文件被 Git 忽略）。若用户名或密码包含 `@`、`:` 等 URL 特殊字符，请进行 URL 编码。启动 API 后：

- GET /api/v1/health：进程存活，不依赖数据库。
- GET /api/v1/ready：数据库 Ping 成功返回 200，否则 503，不暴露驱动错误或密码。

当前 API 默认仅监听 `127.0.0.1:3001`（可通过 `API_HOST`、`PORT` 调整）。用户中心与鉴权尚未接入前，不要将项目管理 API 暴露到公网。

新增 `AUTH_MODE`：本机开发使用 `local`，禁止在生产环境或非回环地址使用；`oidc` 模式需要可信身份提供方配置。OIDC 模式下项目列表、详情和资产操作执行成员级授权；未归属旧项目默认不可访问。详见 `docs/zh-CN/oidc-verification.md`。

项目元数据 API（不负责写入项目源码文件）：

- `POST /api/v1/projects`：接收 `{ "name": "my-app", "template": "vue-web", "features": ["theme"] }`，校验项目配置并存入 MySQL；名称重复返回 409。
- `GET /api/v1/projects`：按创建时间倒序查询最近 50 条项目记录。
- `GET /api/v1/projects/:slug`：按名称读取单条记录；不存在返回 404。

项目的本地源码生成仍由 CLI 完成。修改/删除 API 会在用户中心和权限策略就绪后实现，避免当前无鉴权阶段开放破坏性操作。

Vue 控制台的 `/projects` 页面显示项目列表，`/projects/new` 创建向导可调用 API 保存元数据，`/projects/:slug` 显示详情。后端或 MySQL 不可用时会展示明确的错误和重试操作，创建向导仍保留独立的本地 CLI 命令。**保存元数据与生成源码是两个不同操作**。

项目资产计划 API：

- `GET /api/v1/projects/:slug/assets`：列出此项目登记的资产与版本。
- `POST /api/v1/projects/:slug/assets`：接收 `{ "assetId": "official.theme" }`，使用资产目录验证目标兼容性，并登记当前版本。重复登记同版本是幂等的。
- 记录状态初始为 `planned`（待执行）；**该 API 不读取、不修改本地项目文件，不能声明安装成功**。只有后续 CLI 执行器校验成功，才能设计可信的 `applied` 状态同步流程。

当前尚无鉴权，不提供资产升级、卸载或直接覆盖源码的远程写操作。Vue 项目详情页会显示待执行计划与可选的官方资产。

### 在本机执行资产计划

项目详情页可根据你填写的项目源码目录生成三条命令（应在 YKForgeKit 仓库根目录执行）：

    node packages/cli/dist/index.js asset plan official.theme --dir ./my-app
    node packages/cli/dist/index.js asset add official.theme --dir ./my-app
    node packages/cli/dist/index.js asset verify official.theme --dir ./my-app

其中 `plan` 只预览文件变更；`add` 执行已有的安全安装流程；`verify` 仅检查锁记录、版本及受管理文件摘要，不修改文件。建议执行前先将项目纳入 Git 版本控制，执行后核对 `git diff`。

**这三个 CLI 操作都不会修改数据库状态**：当前尚未实现经过身份认证、执行回执及项目目录绑定的可靠状态同步，不能将浏览器记录自动标记为 `applied`。

CLI `asset verify` 支持增加 `--json` 输出可机读的本地校验回执，包含项目名、资产 ID/版本、受管理文件 SHA-256 摘要、锁文件 SHA-256 和校验时间。项目详情页可以粘贴回执，检查格式及与当前项目计划的匹配关系。**该回执未签名，任何人都可以构造文本，因此不能作为身份认证凭据、远程文件证明或数据库 `applied` 状态的依据。** 后续需先实现可信项目身份与执行器鉴权协议。

若需单独检查连接，可在 packages/db/.env 配置 DATABASE_URL，执行：

    corepack pnpm --filter @forgekit/db db:check

此命令只做连接 Ping，不会修改数据库结构。

## 迁移策略

Schema 定义在 packages/db/src/schema.ts，生成 SQL 到 packages/db/drizzle/。

    corepack pnpm --filter @forgekit/db db:generate

必须先检查 SQL、确认目标库和备份；只有明确获得数据库迁移授权后才执行：

    corepack pnpm --filter @forgekit/db db:migrate

当前业务数据基础是 projects 和 asset_installations；`0001` 迁移新增项目模板与能力配置字段，`0002` 迁移添加资产状态和项目内资产唯一约束。**如果既有数据库已经有同一项目重复的资产记录，必须先人工核查和处理，否则唯一约束迁移会失败**。组织协作与正式运行时授权仍待实现。

`0003` 迁移新增 `users`、`external_identities`、`project_memberships`，形成用户与项目角色的存储基础。当前虽已编写 OIDC 登录与项目级授权原型，但尚未经过真实身份提供方及 MySQL 的端到端验证；旧项目仍无归属，需要单独设计安全认领流程。暂不能据此直接公网部署。详细决策见 `docs/adr/0004-identity-authorization-foundation.md`。

`0004` 迁移新增项目成员权限变更审计表。OIDC 模式已具备部分项目成员级授权与登录原型，但正式部署仍需完成真实身份提供方、MySQL 事务和越权测试。

## 安全底线

- 凭证仅在环境或秘密管理器中存放，不写入代码、日志或 PR。
- 最小权限、限制连接数与超时、数据库备份和迁移审批。
- 数据库连接问题需从端口映射、网络、权限逐项验证，不猜测密码。
