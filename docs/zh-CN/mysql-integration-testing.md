# 独立 MySQL 8.0 集成测试环境

状态：2026-11-19 已在代理执行环境（Docker 27 + MySQL 8.0 + Keycloak 26.8.2 一次性容器）实际运行全部 6 个集成测试并通过：数据库迁移/CRUD/事务回滚（1）、项目成员与邀请并发（3）、本地 HTTPS JWKS + 签名 JWT HTTP 鉴权（1）、真实 Keycloak 授权码 + PKCE 登录与 API 鉴权（1）。GitHub Actions 的 `mysql-integration` 与 `keycloak-integration` Job 在每个 PR 上运行同样的测试。真实浏览器中的控制台登录回调与生产 OIDC 提供方对接仍待进行。

## 原则

- 使用 `compose.test.yml` 启动独立、无持久卷的 MySQL **8.0**，仅映射 `127.0.0.1:33306`，不占用已有实例通常使用的 3306 端口。
- 测试数据库固定为 `forgekit_test`，账号固定为 `forgekit_test`；数据库密码从未提交的 `.env.test` 注入。
- 仅在 `FORGEKIT_DB_INTEGRATION=1`、数据库名/账号完全匹配且连接到回环地址 3306 或 33306 时，代码才允许执行迁移与测试写入。
- 集成测试使用真实 Drizzle 迁移、MySQL 8.0 版本检测、项目创建/读取与事务回滚验证；并扩展 Owner/Viewer 角色、邀请创建/兑换/撤销、竞争兑换、审计和跨限流器共享配额。测试结束清理自己创建的 UUID 测试记录。
- 项目日常 API 和用户 Mac 上已有的 MySQL 不会自动改用此测试库。

## Mac/Linux 本地执行

在 YKForgeKit 仓库根目录：

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
corepack pnpm --filter @forgekit/api exec vitest run test/oidc-http.mysql.test.ts
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

## 真实 Keycloak 端到端测试（B01）

`apps/api/test/keycloak-oidc.mysql.test.ts` 针对**真实 Keycloak**（`infra/keycloak/forgekit-dev-realm.json` 导入的 `forgekit-dev` realm）与真实 MySQL 8.0 运行，默认跳过，只有同时设置 `FORGEKIT_DB_INTEGRATION=1` 和 `FORGEKIT_KEYCLOAK_E2E=1` 时才会执行。测试流程：

1. 通过 Keycloak 管理 API 临时创建两个随机测试用户（密码在运行时随机生成，不入库、不提交），测试结束后删除。
2. 使用 realm 中真实的公共客户端 `forgekit-web`，以**授权码 + PKCE S256** 完成登录（与浏览器相同的流程，无需开启密码直授）。
3. 以 `AUTH_MODE=oidc` 启动编译后的 API，验证：Keycloak 访问令牌可通过 `whoami`；SPA 的 ID Token（audience 不是 `forgekit-api`）被拒绝；篡改签名的令牌被拒绝；账户建立、项目创建、非成员 404、邀请码兑换后可访问、Viewer 无权创建邀请（403）。
4. 清理测试创建的项目、用户记录和 Keycloak 用户。

本地运行（需要 Docker，使用一次性容器，Keycloak 仅监听回环地址）：

```bash
# 一次性 MySQL 见上文；一次性 Keycloak：
docker run -d --name forgekit-keycloak-e2e -p 127.0.0.1:18080:18080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=<仅测试用管理员> -e KC_BOOTSTRAP_ADMIN_PASSWORD=<仅测试用密码> \
  -e KC_HOSTNAME=http://127.0.0.1:18080 \
  -v "$PWD/infra/keycloak/forgekit-dev-realm.json:/opt/keycloak/data/import/forgekit-dev-realm.json:ro" \
  quay.io/keycloak/keycloak:26.8.2 start-dev --import-realm --http-port=18080

export FORGEKIT_DB_INTEGRATION=1 DATABASE_URL=<测试库 URL> FORGEKIT_KEYCLOAK_E2E=1 \
  FORGEKIT_KEYCLOAK_ADMIN_USER=<同上> FORGEKIT_KEYCLOAK_ADMIN_PASSWORD=<同上>
corepack pnpm build
corepack pnpm --filter @forgekit/api exec vitest run test/keycloak-oidc.mysql.test.ts
```

**不要**把该测试指向任何非一次性的 Keycloak：它需要 master realm 管理员权限来创建和删除用户。CI 中的 `keycloak-integration` Job 使用 MySQL 8.0 服务容器和每次全新的 Keycloak 容器运行同一测试。

## 后续增强

- 已增加使用临时自签名 HTTPS JWKS、测试签名 JWT 和真实 HTTP API 的鉴权端到端测试：覆盖签名、Audience、有效期、项目范围授权及邀请兑换。证书/私钥在测试时临时生成，不提交至仓库。
- 已增加真实 Keycloak 的授权码 + PKCE 登录及 API 鉴权端到端测试（见上节）。仍需在真实浏览器中联调控制台的登录回调与前端会话，以及与生产 OIDC 提供方的对接。
- 增加迁移升级兼容及备份恢复演练；新建空测试库验证不能代表已有业务库的数据兼容性。

## B07 数据仓库回归

`db:test:integration` 同时构建 contracts/db，顺序运行原有迁移测试和 `packages/db/test/build-repositories.mysql.test.ts`，CI 的 mysql-integration Job 使用相同入口。新增测试覆盖预 B07 已有项目升级及迁移重放、双连接池并发构建编号与状态竞争、日志分块序号/续传、预览摘要/有效期/撤销、同项目组合外键和级联清理。详细边界见 [构建数据模型](./build-data-model.md)。默认单元测试仍跳过真实数据库用例。
