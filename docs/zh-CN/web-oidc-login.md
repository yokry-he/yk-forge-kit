# Vue 用户中心与 OIDC 登录

状态：已实现前端授权码 + PKCE 客户端、回调、会话 UI 与项目路由保护。CI 已通过使用临时 HTTPS JWKS 与 MySQL 8.0 的后端 HTTP 鉴权测试，但**尚未接入真实第三方身份提供方或验证浏览器 PKCE 回调**。

## 设计

- 使用维护成熟的 `oidc-client-ts`，由身份提供方完成登录。ForgeKit Vue 端不收集或存储用户密码。
- Authorization Code + PKCE，浏览器使用 public client，不在前端放 Client Secret。
- 用户会话由库管理，当前保存在 `sessionStorage`；全局 Vue 响应式状态只保留展示用信息，不复制访问令牌。
- 暂不自动静默续期，过期后提示重新登录；后续可视身份提供方能力设计刷新策略。
- 浏览器中令牌过期、用户会话被身份提供方注销，或 API 检测到令牌已失效时，同步清除公开展示会话；若正在项目页面则返回登录页并保留受限的内部返回路径。
- 并发恢复会话会共用同一个恢复 Promise，避免路由切换与根布局同时重复恢复时出现竞态或加载状态闪烁。
- 项目与资产 API 使用 `Authorization: Bearer` 发送 Access Token；令牌不拼接到 URL、路由参数或日志。
- 用户中心在展示浏览器会话的同时请求 `/api/v1/auth/whoami`，展示独立的 API 身份验证状态，并核对服务端验证的 Subject 与当前会话一致；验证失败时可重试，但不把浏览器会话当成服务端授权结果。
- 首次进入已登录的用户中心时，验证通过后通过幂等 `POST /api/v1/auth/account` 建立与 OIDC issuer + subject 绑定的 ForgeKit 账户；这一操作不会加入任何项目。重复操作返回同一账户，项目访问仍由成员关系决定。

## 配置

开发时将 `apps/console/.env.example` 复制到 `apps/console/.env.local` 并配置：

```text
VITE_AUTH_MODE=oidc
VITE_OIDC_AUTHORITY=https://idp.example.com/realms/forgekit
VITE_OIDC_CLIENT_ID=forgekit-web
VITE_OIDC_RESOURCE=forgekit-api
```

在身份提供方注册 public SPA 客户端、允许的 Web Origin 和下列回调：

- `http://localhost:5173/auth/callback`
- `http://localhost:5173/auth/logout-callback`

这些地址是本机开发示例；正式环境必须使用对应 HTTPS 域名。具体 API Access Token 的受众取决于提供方配置：`VITE_OIDC_RESOURCE` 只是某些提供方支持的 Resource Indicator，**不能保证所有提供方会据此签发目标 Audience**。实际令牌必须通过后端 `OIDC_API_AUDIENCE` 检查。

后端需设置 `AUTH_MODE=oidc` 及 OIDC_ISSUER、OIDC_JWKS_URL、OIDC_API_AUDIENCE。两端配置的身份提供方与 API 受众必须一致。

## 路由与行为

- `/auth/login`：用户中心；触发 OIDC 登录、展示会话与退出。
- OIDC 模式下，访问 `/projects`、`/projects/new`、`/projects/:slug` 会先恢复有效会话；未登录时转到 `/auth/login`，带上受限的内部返回路径。`/assets` 目录与登录、回调路由保持可访问。
- `/auth/callback`：处理授权码回调后返回发起登录前的内部项目地址；缺失或格式异常时退回项目列表，不能接受外站跳转。
- `/auth/logout-callback`：处理退出回调、清除本机会话并返回登录页。
- 无有效访问令牌时，项目 API 会返回 401；控制台提示重新登录。
- `VITE_AUTH_MODE=local` 下没有假登录身份，只展示本地开发说明。

## 上线前安全检查

1. 真实身份提供方配置、回调白名单、Issuer/Audience、TLS 和 CSP。
2. 账号与 `external_identities` 映射、项目权限和旧项目认领迁移。
3. 跨用户访问、访问令牌过期、回调失败、退出、刷新行为测试。
4. SPA 持有 Access Token 需遵守 XSS 防护。更高安全要求可考虑以后使用 Backend-for-Frontend，把令牌移至后端并用安全 Cookie 管理会话。

参考：[oidc-client-ts UserManager](https://authts.github.io/oidc-client-ts/classes/UserManager.html)、[OWASP OAuth2](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)。
