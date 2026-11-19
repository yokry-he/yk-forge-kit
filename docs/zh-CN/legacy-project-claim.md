# 旧项目认领（运维命令）

状态：已实现（B03）。认领由运维人员在服务器上显式执行，不提供 HTTP 接口，也不会自动执行。

## 背景

启用 OIDC 之前，在 `AUTH_MODE=local` 下创建的项目没有任何成员记录。OIDC 模式按成员关系授权，所以这些项目对任何登录用户都不可见（返回 404）。按照 [ADR-0004](../adr/0004-identity-authorization-foundation.md)，**不得**把旧项目自动交给首个登录者。按照 [ADR-0005](../adr/0005-product-positioning-and-cross-platform-stack.md)，当前采用私有化单租户部署，由控制面运维人员（通常就是项目所有者本人）确认归属后，再显式认领。

## 规则

- 只能认领**没有任何成员**的项目。已有成员的项目应由现有 Owner 通过[邀请码](./project-invitations.md)添加成员。
- 目标身份必须已经登录过控制台，并完成账户初始化（`POST /api/v1/auth/account`）。命令不会为写错的 issuer/subject 新建账户。
- issuer 和 subject 按原值精确匹配（区分大小写，不去除空格），与 API 鉴权一致。subject 以 `--` 开头或含空格时，使用 `--subject=<原值>` 形式。
- 默认只做检查（dry-run），追加 `--yes` 才会写入。
- 写入在一个 MySQL 事务中完成：先锁定项目行，再写入 `owner` 成员，并在 `project_member_audit` 中记录一条审计（`actor_user_id = operator-cli`，`previous_role = none`，`next_role = owner`）。并发认领只有一个能成功。

## 使用

1. 让项目归属人用 OIDC 登录控制台，并调用 `GET /api/v1/auth/whoami` 获取自己的 `issuer` 和 `subject`（与 API 的 `OIDC_ISSUER` 完全一致）。
2. 在能连接控制面数据库的服务器上，在仓库根目录执行（先 `pnpm build`；`DATABASE_URL` 从环境变量或 `apps/api/.env` 读取）：

```bash
# 列出没有成员的旧项目
pnpm --filter @forgekit/api claim:project -- --list
# 检查（不写入）
pnpm --filter @forgekit/api claim:project -- --slug my-site --issuer https://idp.example.com/realms/prod --subject 0f6c...
# 确认无误后执行
pnpm --filter @forgekit/api claim:project -- --slug my-site --issuer https://idp.example.com/realms/prod --subject 0f6c... --yes
```

对生产数据库执行前请先备份。命令只新增成员和审计记录，不修改项目本身的数据。

## 测试

- `apps/api/test/project-claim.test.ts`：参数解析（默认 dry-run，拒绝缺失、重复或未知参数）。
- `apps/api/test/project-claim.mysql.test.ts`：在真实 MySQL 上验证 local 模式创建的无成员项目、未初始化身份被拒绝、subject 大小写敏感、dry-run 不写入、并发认领只有一个成功、审计记录、已有成员时拒绝。CI 的 `mysql-integration` Job 会运行该测试。
- `apps/api/test/auth-config.test.ts`：生产环境默认使用 OIDC，拒绝 local 模式、缺失的 OIDC 配置和 HTTP 身份提供方（即使设置了开发用的回环例外）。
