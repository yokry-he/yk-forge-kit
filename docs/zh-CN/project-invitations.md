# 项目成员邀请

状态：实现邀请码创建、兑换、撤销及生命周期审计，待真实 OIDC + MySQL 8.0 集成验证。

## 使用流程

1. 项目 Owner 在项目详情页选择 `Editor` 或 `Viewer`，生成邀请码。
2. 邀请码仅在生成成功时返回一次；Owner 应通过可信渠道私下发送给受邀者，不应放在公开工单或日志中。
3. 受邀者使用 OIDC 登录控制台，在登录页的邀请区粘贴邀请码并确认加入。
4. 成功后创建项目成员记录并导航至项目详情页；邀请码立即失效，不可二次兑换。

邀请码为 32 字节随机数的 base64url 编码，有效期七天。数据库只存储 SHA-256 摘要，不持久化明文。邀请码是持有即授权的敏感凭据，泄露时应视为可被他人抢先兑换。Owner 可以撤销仍有效且未兑换的邀请码；已兑换或已过期的邀请码不可撤销。

## API

| 方法与路径 | 授权 | 用途 |
| --- | --- | --- |
| `POST /api/v1/projects/:slug/invitations` | OIDC + Owner | 请求 `{ "role": "editor" }` 或 `viewer`；返回一次性 `code`、`role`、`expiresAt` |
| `GET /api/v1/projects/:slug/invitations` | OIDC + Owner | 最近 50 条邀请的时间、角色、兑换状态；**不返回 code** |
| `DELETE /api/v1/projects/:slug/invitations/:invitationId` | OIDC + Owner | 撤销未使用且未过期的邀请码；保留历史记录 |
| `POST /api/v1/invitations/redeem` | OIDC 登录 | 请求 `{ "code": "..." }`；成功返回 `projectSlug`、`role` |

`local` 开发模式下禁止创建、撤销或兑换邀请码。邀请码过期、已撤销、已兑换、无效或当前用户已是项目成员时，服务端返回明确错误。兑换、撤销都通过 MySQL 事务及行锁保证状态变更互斥。创建、兑换、撤销均写入不含邀请码明文和哈希的 `project_invitation_audit` 事件表；写审计失败时事务回滚。

## 防滥用限额

- OIDC 身份每小时最多创建 **10** 个邀请码（跨项目共享配额）。
- OIDC 身份每 15 分钟最多尝试兑换 **30** 次；包括格式错误、无效、已过期和已使用的邀请码。
- 计数器保存在 MySQL `invitation_rate_buckets`，通过唯一键与原子 `INSERT ... ON DUPLICATE KEY UPDATE` 在多个 API 实例之间共享。超过限额返回 HTTP `429`；配额按固定时间窗口重置。
- 数据库只保留 issuer/subject 的 SHA-256 摘要组合成桶键，不保存原始 OIDC 身份标识。
- 需要定期清理旧桶记录（建议只删除超过七天的窗口）；当前未实现自动清理。

此限额是按**已认证身份**约束，不能替代 API 网关按来源 IP/网段、全局请求量的防护。公网部署前还应配置网关限流、防自动化监控与告警，并通过真实 MySQL 并发测试验证限额。

## 数据库和部署

`0005_luxuriant_trauma.sql` 新增 `project_invitations` 表及索引，`0006_first_gideon.sql` 增加撤销时间/操作者和邀请审计表，`0007_curved_stingray.sql` 增加共享限流桶表。迁移**不会**随着 API 启动而自动执行；对真实数据库执行前应先备份并取得操作授权。

尚未实现：邮件投递、API 网关来源限流、限流桶自动清理、真实身份提供商及 MySQL 的端到端测试。**当前不能直接作为公网生产邀请服务开放**，必须先完成基础设施级防护及集成验证。
