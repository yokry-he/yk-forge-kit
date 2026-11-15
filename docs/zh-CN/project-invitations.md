# 项目成员邀请

状态：实现邀请码闭环，待真实 OIDC + MySQL 8.0 集成验证。

## 使用流程

1. 项目 Owner 在项目详情页选择 `Editor` 或 `Viewer`，生成邀请码。
2. 邀请码仅在生成成功时返回一次；Owner 应通过可信渠道私下发送给受邀者，不应放在公开工单或日志中。
3. 受邀者使用 OIDC 登录控制台，在登录页的邀请区粘贴邀请码并确认加入。
4. 成功后创建项目成员记录并导航至项目详情页；邀请码立即失效，不可二次兑换。

邀请码为 32 字节随机数的 base64url 编码，有效期七天。数据库只存储 SHA-256 摘要，不持久化明文。邀请码是持有即授权的敏感凭据，泄露时应视为可被他人抢先兑换；当前尚未实现主动撤销。

## API

| 方法与路径 | 授权 | 用途 |
| --- | --- | --- |
| `POST /api/v1/projects/:slug/invitations` | OIDC + Owner | 请求 `{ "role": "editor" }` 或 `viewer`；返回一次性 `code`、`role`、`expiresAt` |
| `GET /api/v1/projects/:slug/invitations` | OIDC + Owner | 最近 50 条邀请的时间、角色、兑换状态；**不返回 code** |
| `POST /api/v1/invitations/redeem` | OIDC 登录 | 请求 `{ "code": "..." }`；成功返回 `projectSlug`、`role` |

`local` 开发模式下禁止创建或兑换邀请码。邀请码过期、已兑换、无效或当前用户已是项目成员时，服务端返回明确错误。兑换时通过 MySQL 事务及行锁保证同一邀请码最多被成功使用一次。

## 数据库和部署

`0005_luxuriant_trauma.sql` 新增 `project_invitations` 表及索引。迁移**不会**随着 API 启动而自动执行；对真实数据库执行前应先备份并取得操作授权。

尚未实现：邀请撤销、邮件投递、邀请码使用审计与专门的速率限制、真实身份提供商及 MySQL 的端到端测试。上线前必须补齐相应安全与集成验证。
