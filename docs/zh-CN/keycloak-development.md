# 本机 Keycloak OIDC 联调（可选）

这套 Keycloak 仅供本机开发和测试，不替代生产身份服务。YKForgeKit 使用标准 OIDC，生产环境可更换身份提供方。

## 启动身份服务

1. 复制 `.env.oidc.dev.example` 为 `.env.oidc.dev`，更换为**仅供本地测试**的管理员密码（该文件不会提交）。
2. 启动：

   ```bash
   docker compose -p forgekit-oidc-dev --env-file .env.oidc.dev -f compose.oidc.dev.yml up -d
   ```

3. 检查 `http://127.0.0.1:18080/realms/forgekit-dev/.well-known/openid-configuration` 可访问。在 Keycloak 管理界面选择 `forgekit-dev` realm，手动建立临时测试用户，设置独立测试密码。不在仓库预置用户密码。

该容器只监听本机 `127.0.0.1:18080`，没有持久化数据卷，删除容器可能丢失测试用户。数据库 MySQL 8.0 与本机 API 的运行方式不变。

## 配置后端

在 `apps/api/.env` 的现有数据库配置之外添加：

```dotenv
AUTH_MODE=oidc
API_HOST=127.0.0.1
OIDC_ISSUER=http://127.0.0.1:18080/realms/forgekit-dev
OIDC_JWKS_URL=http://127.0.0.1:18080/realms/forgekit-dev/protocol/openid-connect/certs
OIDC_API_AUDIENCE=forgekit-api
OIDC_DEV_ALLOW_HTTP_LOOPBACK=true
```

## 配置控制台

在 `apps/console/.env.local` 添加：

```dotenv
VITE_AUTH_MODE=oidc
VITE_OIDC_AUTHORITY=http://127.0.0.1:18080/realms/forgekit-dev
VITE_OIDC_CLIENT_ID=forgekit-web
VITE_OIDC_DEV_ALLOW_HTTP_LOOPBACK=true
```

用 `http://127.0.0.1:5173` 打开前端，登录时使用刚创建的临时用户。`forgekit-web` 是不使用客户端密钥的公共 SPA 客户端；使用授权码 + PKCE S256。realm 为访问令牌添加 `forgekit-api` audience，后端验证签名、发行方、受众和有效期。不要把管理员账号用于产品登录。

## 安全边界与停止

- HTTP 例外必须显式开启，且仅能用于非生产环境和回环地址。生产运行时不接受 HTTP OIDC 配置，部署时使用真实 HTTPS issuer/JWKS。
- 开发服务器不得通过反向代理向公网开放。Keycloak `start-dev` 不具备生产安全保障。
- 若本地已有同名 realm，`--import-realm` 不会覆盖修改；需要通过 Keycloak 管理界面管理，或在确认可以丢弃**本地测试数据**后重建容器。
- 停止：`docker compose -p forgekit-oidc-dev --env-file .env.oidc.dev -f compose.oidc.dev.yml down`。这不会停止原有 MySQL。

## 自动化端到端测试

同一 realm 配置由 `apps/api/test/keycloak-oidc.mysql.test.ts` 在 CI（`keycloak-integration` Job）中自动验证：真实授权码 + PKCE 登录、令牌 audience 与签名校验、项目范围授权。运行方式见 [MySQL 集成测试](./mysql-integration-testing.md#真实-keycloak-端到端测试b01)。
