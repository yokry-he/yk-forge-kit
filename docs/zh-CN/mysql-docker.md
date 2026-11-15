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

建议为 ForgeKit 使用独立数据库、最小权限账号和独立业务表，不使用 root 账号。创建数据库及授权需先确认现有实例情况。

## 本地开发与检查

先运行 `docker ps` 确认 MySQL 8.0 容器的宿主机端口映射（例如 `127.0.0.1:3307->3306/tcp`），确保 MySQL 已正常启动。将 `.env.example` 复制为 `apps/api/.env`，再配置实际 `DATABASE_URL`（该文件被 Git 忽略）。若用户名或密码包含 `@`、`:` 等 URL 特殊字符，请进行 URL 编码。启动 API 后：

- GET /api/v1/health：进程存活，不依赖数据库。
- GET /api/v1/ready：数据库 Ping 成功返回 200，否则 503，不暴露驱动错误或密码。

当前 API 默认仅监听 `127.0.0.1:3001`（可通过 `API_HOST`、`PORT` 调整）。用户中心与鉴权尚未接入前，不要将项目管理 API 暴露到公网。

项目元数据 API（不负责写入项目源码文件）：

- `POST /api/v1/projects`：接收 `{ "name": "my-app", "template": "vue-web", "features": ["theme"] }`，校验项目配置并存入 MySQL；名称重复返回 409。
- `GET /api/v1/projects`：按创建时间倒序查询最近 50 条项目记录。
- `GET /api/v1/projects/:slug`：按名称读取单条记录；不存在返回 404。

项目的本地源码生成仍由 CLI 完成。修改/删除 API 会在用户中心和权限策略就绪后实现，避免当前无鉴权阶段开放破坏性操作。

Vue 控制台的 `/projects` 页面显示项目列表，`/projects/new` 创建向导可调用 API 保存元数据，`/projects/:slug` 显示详情。后端或 MySQL 不可用时会展示明确的错误和重试操作，创建向导仍保留独立的本地 CLI 命令。**保存元数据与生成源码是两个不同操作**。

若需单独检查连接，可在 packages/db/.env 配置 DATABASE_URL，执行：

    corepack pnpm --filter @forgekit/db db:check

此命令只做连接 Ping，不会修改数据库结构。

## 迁移策略

Schema 定义在 packages/db/src/schema.ts，生成 SQL 到 packages/db/drizzle/。

    corepack pnpm --filter @forgekit/db db:generate

必须先检查 SQL、确认目标库和备份；只有明确获得数据库迁移授权后才执行：

    corepack pnpm --filter @forgekit/db db:migrate

当前 Schema 仅是 projects 和 asset_installations 的初始元数据模型；`0001` 迁移新增项目模板与能力配置字段。用户/组织/权限模型尚未定案。

## 安全底线

- 凭证仅在环境或秘密管理器中存放，不写入代码、日志或 PR。
- 最小权限、限制连接数与超时、数据库备份和迁移审批。
- 数据库连接问题需从端口映射、网络、权限逐项验证，不猜测密码。
