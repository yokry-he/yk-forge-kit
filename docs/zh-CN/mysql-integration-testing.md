# 独立 MySQL 8.0 集成测试环境

状态：GitHub Actions `CI` Run #43851543191 已成功启动 MySQL 8.0.46 服务容器，并完成空库迁移、CRUD 和事务回滚测试。当前代理执行环境仍没有 Docker 引擎；新增项目成员与邀请码数据库集成用例尚待下一次 CI 验证。

## 原则

- 使用 `compose.test.yml` 启动独立、无持久卷的 MySQL **8.0**，仅映射 `127.0.0.1:33306`，不占用已有实例通常使用的 3306 端口。
- 测试数据库固定为 `forgekit_test`，账号固定为 `forgekit_test`；数据库密码从未提交的 `.env.test` 注入。
- 仅在 `FORGEKIT_DB_INTEGRATION=1`、数据库名/账号完全匹配且连接到回环地址 3306 或 33306 时，代码才允许执行迁移与测试写入。
- 集成测试使用真实 Drizzle 迁移、MySQL 8.0 版本检测、项目创建/读取与事务回滚验证；并扩展 Owner/Viewer 角色、邀请创建/兑换/撤销、竞争兑换、审计和跨限流器共享配额。测试结束清理自己创建的 UUID 测试记录。
- 项目日常 API 和用户 Mac 上已有的 MySQL 不会自动改用此测试库。

## Mac/Linux 本地执行

在 ForgeKit 仓库根目录：

```bash
cp .env.test.example .env.test
# 在 .env.test 中填写只用于测试的两个密码，并保证 DATABASE_URL 中密码与测试用户密码一致
docker compose -p forgekit-integration --env-file .env.test -f compose.test.yml up -d --wait
set -a
. ./.env.test
set +a
corepack pnpm db:test:integration
corepack pnpm build
corepack pnpm --filter @forgekit/api exec vitest run test/mysql-project-flow.test.ts
```

检查完成后，可以显式关闭并删除测试容器：

```bash
docker compose -p forgekit-integration --env-file .env.test -f compose.test.yml down
```

**删除测试容器会丢失该容器内全部数据库内容**，因为未挂载持久卷。这是专用测试环境的预期行为；务必确认操作使用固定项目名 `forgekit-integration` 和 `compose.test.yml`，切勿对业务 Compose 文件执行 `down -v`。

`.env.test` 已加入 `.gitignore`，不要将真实密码粘贴到 PR、Issue 或测试日志。示例密码仅为占位符，必须自行更换。

## CI

GitHub Actions 的 `mysql-integration` Job 在 Runner 上使用 MySQL 8.0 服务容器和固定的、一次性 CI 测试账号；先检查 SQL 迁移一致性，再执行数据库迁移和数据库服务层集成测试。CI 测试数据库每次都是全新的，不能替代对已有数据迁移的演练。

默认 `pnpm test` 会跳过需要数据库的集成用例；必须显式运行 `pnpm db:test:integration` 并提供上述环境变量。没有配置 Docker 的执行环境可以继续运行类型检查、单元测试和编译后 API 的无数据库 HTTP 冒烟测试。

## 后续增强

- 增加从真实 OIDC 身份提供方到 HTTP Guard 的端到端登录、令牌校验与越权测试（当前数据库服务层测试直接构造经过验证的身份上下文，不验证 JWT）。
- 增加迁移升级兼容及备份恢复演练；新建空测试库验证不能代表已有业务库的数据兼容性。
