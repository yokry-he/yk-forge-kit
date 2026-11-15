# 使用现有 Docker MySQL

状态：第一版数据库基础设施。尚未连接用户自己的 Docker MySQL，也未执行迁移。

## 技术方案

- 数据库：用户现有 Docker MySQL。
- 驱动：mysql2 连接池。
- ORM 与迁移：Drizzle ORM / Drizzle Kit。
- 数据包：@forgekit/db，独立于 Vue UI 和 NestJS 业务层。
- 不创建新 Docker 数据库容器，也不在应用启动时自动执行迁移。

## 连接配置

环境变量使用 DATABASE_URL，格式为 mysql://user:password@host:port/database。仓库根目录 .env.example 仅是占位示例，不包含真实凭证。

- API 运行在 Docker 宿主机：连接已映射的宿主机地址和端口，例如 127.0.0.1:3306。
- API 与 MySQL 运行在同一 Docker 网络：使用 MySQL 容器或服务名，以及容器内部端口。
- 远程执行环境无法直接访问用户电脑的 localhost；不要为方便调试而暴露 MySQL 公网端口。

建议为 ForgeKit 使用独立数据库、最小权限账号和独立业务表，不使用 root 账号。创建数据库及授权需先确认现有实例情况。

## 本地开发与检查

将 .env.example 复制为 apps/api/.env，再配置实际 DATABASE_URL（该文件被 Git 忽略）。启动 API 后：

- GET /api/v1/health：进程存活，不依赖数据库。
- GET /api/v1/ready：数据库 Ping 成功返回 200，否则 503，不暴露驱动错误或密码。

若需单独检查连接，可在 packages/db/.env 配置 DATABASE_URL，执行：

    corepack pnpm --filter @forgekit/db db:check

此命令只做连接 Ping，不会修改数据库结构。

## 迁移策略

Schema 定义在 packages/db/src/schema.ts，生成 SQL 到 packages/db/drizzle/。

    corepack pnpm --filter @forgekit/db db:generate

必须先检查 SQL、确认目标库和备份；只有明确获得数据库迁移授权后才执行：

    corepack pnpm --filter @forgekit/db db:migrate

当前 Schema 仅是 projects 和 asset_installations 的初始元数据模型，用户/组织/权限模型尚未定案。

## 安全底线

- 凭证仅在环境或秘密管理器中存放，不写入代码、日志或 PR。
- 最小权限、限制连接数与超时、数据库备份和迁移审批。
- 数据库连接问题需从端口映射、网络、权限逐项验证，不猜测密码。
