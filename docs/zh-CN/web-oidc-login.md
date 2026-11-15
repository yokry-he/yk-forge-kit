# Vue 用户中心与 OIDC 登录

状态：已实现前端授权码 + PKCE 客户端、回调与会话 UI，但**尚未接入真实身份提供方，也未完成真实 MySQL 的授权端到端测试**。

## 设计

- 使用维护成熟的 `oidc-client-ts`，由身份提供方完成登录。ForgeKit Vue 端不收集或存储用户密码。
- Authorization Code + PKCE，浏览器使用 public client，不在前端放 Client Secret。
- 用户会话由库管理，当前保存在 `sessionStorage`；全局 Vue 响应式状态只保留展示用信息，不复制访问令牌。
- 暂不自动静默续期，过期后提示重新登录；后续可视身份提供方能力设计刷新策略。
- 项目与资产 API 使用 `Authorization: Bearer` 发送 Access Token；令牌不拼接到 URL、路由参数或日志。

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
- `/auth/callback`：处理授权码回调并回到项目列表。
- `/auth/logout-callback`：处理退出回调并清除本机会话。
- 无有效访问令牌时，项目 API 会返回 401；控制台提示重新登录。
- `VITE_AUTH_MODE=local` 下没有假登录身份，只展示本地开发说明。

## 上线前安全检查

1. 真实身份提供方配置、回调白名单、Issuer/Audience、TLS 和 CSP。
2. 账号与 `external_identities` 映射、项目权限和旧项目认领迁移。
3. 跨用户访问、访问令牌过期、回调失败、退出、刷新行为测试。
4. SPA 持有 Access Token 需遵守 XSS 防护。更高安全要求可考虑以后使用 Backend-for-Frontend，把令牌移至后端并用安全 Cookie 管理会话。

参考：[oidc-client-ts UserManager](https://authts.github.io/oidc-client-ts/classes/UserManager.html)、[OWASP OAuth2](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)。
