# OIDC 令牌验证基础（尚未启用登录）

状态：开发阶段认证与项目级成员授权基础已接入 NestJS，Vue 端已新增登录/回调客户端；**尚未实现旧项目认领或真实身份提供方端到端验证**。详见 `docs/zh-CN/web-oidc-login.md`。

## 为什么先做验证器

YKForgeKit 面向 Web、桌面端与 CLI。使用成熟 OIDC 身份提供方，避免在业务服务内自建密码存储、重置邮件及独立会话体系。具体提供方（自托管或托管）尚待选择，数据模型用 `(issuer, subject)` 绑定稳定身份。

`@forgekit/identity-core` 的 `createOidcTokenVerifier` 使用 `jose` 和可信 JWKS，明确校验签名、固定 issuer、API audience、允许的算法（RS256/ES256）、过期时间、签发时间和 subject。使用公开配置而不是从令牌中自动选择 issuer 或密钥地址。

## 预期配置

未来 API 接入时由服务端配置以下项（这里不是可直接运行的 `.env` 规范）：

```text
OIDC_ISSUER=https://idp.example.com/realms/forgekit
OIDC_API_AUDIENCE=forgekit-api
OIDC_JWKS_URL=https://idp.example.com/realms/forgekit/protocol/openid-connect/certs
```

当前验证器要求可信 issuer 和 JWKS 同源并使用 HTTPS；如果身份提供方的密钥域名不同，需要明确评审信任边界后扩展配置，不允许根据传入 JWT 的 `iss`、`kid`、`jku` 等字段直接决定外部请求目标。

## 认证与授权是两件事

- **认证：** 服务端验证令牌签名与主体身份，得到 `(issuer, subject)`。
- **身份关联：** 通过 `external_identities` 找到 YKForgeKit 内部用户。
- **授权：** 通过 `project_memberships` 和 `@forgekit/identity-core` 的权限矩阵检查具体项目与操作。

任何一步失败都不得授予项目权限。仅验证令牌不能证明请求者有权访问某个项目；也不能把 ID Token 错当成 API Access Token。必须为 API 配置独立 audience，并在服务端的每个入口执行资源级授权检查。

## 尚待实现

1. 选择 OIDC 身份提供方和前端授权码 + PKCE 登录流程。
2. NestJS 守卫、主体映射与项目归属迁移；默认拒绝无权限访问。
3. CLI 设备授权/短期凭据、撤销、密钥轮换与审计。
4. 令牌校验异常、跨项目访问与回归端到端测试。

## 当前 NestJS 接入方式

`AUTH_MODE` 支持：

- `local`：仅允许非生产环境，且 API 监听 `127.0.0.1`、`::1` 或 `localhost`。项目 API 保持现有本机开发行为；`GET /api/v1/auth/whoami` 返回 503，不生成假用户。
- `oidc`：必须设置 `OIDC_ISSUER`、`OIDC_API_AUDIENCE` 和 `OIDC_JWKS_URL`。`GET /api/v1/auth/whoami` 从 `Authorization: Bearer <token>` 中验证签名和声明，返回 `(issuer, subject)`，非法令牌返回 401。

生产模式要求 `oidc` 配置，否则启动失败。项目 API 在 OIDC 模式下要求通过令牌认证，未认证请求返回 401；访问具体项目时按数据库成员角色授权，非成员不能访问，也不能通过错误响应获取项目存在性。

- 创建项目：首次使用可信 `(issuer, subject)` 时建立内部用户与身份关联，并在数据库事务中同时创建项目和 owner 成员关系。
- 列表：只返回当前身份所属的项目（最多 50 条）。
- 详情：非成员返回 404；成员按 `project:read` 策略授权。
- 资产记录查询与计划登记：分别检查 `asset:read`、`asset:plan`；Viewer 不能登记计划。
- 旧项目如果没有成员关系，OIDC 身份不能访问。**不得通过自动认领将旧项目交给首次登录者**，迁移前必须确认归属。

项目成员列表及角色调整已接入：`GET /api/v1/projects/:slug/members` 和 `PATCH /api/v1/projects/:slug/members/:userId`。仅 Owner 能调整已有 Editor/Viewer，且由服务端事务锁定目标行并写入审计。详情见 `docs/zh-CN/project-members.md`。

注意：目前还没有用户登录界面，也没有真实身份提供方的全流程集成测试。项目级授权实现不能代替部署前的权限审计和测试。

不要将本机开发模式用于公网或生产环境，也不要把当前的 `whoami` 当作已完成登录流程。

参考：[jose JWT 验证](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)、[OWASP JWT](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html)、[OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html)。
