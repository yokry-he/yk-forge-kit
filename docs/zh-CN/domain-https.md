# 自定义域名与自动 HTTPS（B13）

先完成 [B12 SSH 静态部署](./ssh-deploy.md)，再从「部署目标与历史」进入「管理自定义域名与 HTTPS」。本功能配置专用 Caddy 实例，跟随目标的 `current` 目录；后续发布和站点回滚继续走 B12。只支持静态站点，不安装软件、不操作云账号。

## 运营准备

显式执行增量迁移 `0012_b13_domain_https.sql`，应用启动不会自动迁移。API 和可信 Worker 继续使用同一 `FORGEKIT_DEPLOY_ENCRYPTION_KEY`、DATABASE_URL 和 REDIS_URL；Worker 继续需要 B12 制品目录。不要向构建容器传入这些凭据。

API 的 `FORGEKIT_DOMAIN_TLS_MODE` 决定新增绑定的 CA 模式，写入绑定后不随环境改变：

- `internal`（默认）：离线内部 CA，浏览器默认不信任；客户端需单独信任此主机 CA。
- `staging`：Let's Encrypt 测试 CA，浏览器默认不信任，仍需要公网可达的域名和挑战端口。
- `production`：Let's Encrypt 生产 CA，需要有效公网 DNS、开放 TCP 80/443、持久化 Caddy data 及主机访问 CA 的网络；注意 CA 限流。

内部 CA 测试通过不代表生产 ACME 签发通过。切换模式需先移除原绑定，再按新模式创建。用户请求不能覆盖 CA 模式。NAT/CDN 与 SSH 主机解析地址不一致、通配符、DNS-01 插件和自带证书暂不支持。

## 准备专用 Caddy 主机

由主机所有者安装 Caddy 2.10.2、Python 3、OpenSSL，以及 B12 所需工具。Caddy 与 SSH 使用同一专用非 root 用户；基础目录由该用户独占。将仓库的 `infra/caddy-host/prepare.py` 复制到主机，在该用户下运行：

```bash
python3 prepare.py /srv/forgekit
caddy run --config /srv/forgekit/.forgekit-caddy/caddy.json
```

初始化拒绝覆盖已有目录。默认 HTTP/HTTPS 为 80/443，测试可用第二、三个参数指定不同的非特权端口。管理员应为专用 Caddy 服务配置开机启动、重启策略及绑定低端口的权限（例如 systemd 的 CAP_NET_BIND_SERVICE）；部署用户不需要 sudo。启动须使用上述确认配置，不能用 `--resume` 读取可能尚未确认的 autosave。

同一 basePath 下的多个目标共享一个 Caddy 实例与锁。不同实例不能争用同一地址的 80/443；不要指向正在管理其他站点的系统 Caddy/Nginx。`.forgekit-caddy` 目录为 0700，管理端只监听 Unix socket。备份其中的配置、状态和 `data`（包含 CA 私钥/证书），不能公开该目录或管理 socket。生产主机应保护专用账号、临时目录及 Caddy 数据；SSH 继续严格校验 B12 保存的公钥。

## 绑定与验证

1. 用 OIDC 项目 owner/editor 身份登录，选择已有成功发布的 SSH 目标，输入域名，例如 `www.example.com`。不含协议、端口、路径或通配符；国际域名请使用 IDNA A-label。viewer 可读记录和日志，本机匿名模式不能管理。
2. 将域名所有 A/AAAA 记录指向 SSH 主机的地址集合。目标填写主机名时使用其解析后的 IP；仅 IPv4 目标不能同时配置不匹配的 AAAA。
3. 在 DNS 服务商添加页面给出的 TXT：名称 `_forgekit-challenge.<域名>`，值 `forgekit-domain=<随机值>`。部分服务商只需输入区内相对名称，避免重复后缀。保留记录以便重验。
4. 点击「验证并启用 HTTPS」。DNS 未就绪时显示等待 DNS；校验通过后获取唯一声明，Caddy 签发并检查证书，证书就绪后才启用静态路由，最后检查 HTTPS index.html。查看操作日志定位固定错误码。成功后可打开站点。

签发/配置失败不会释放域名声明，需重试或安全移除；未验证记录不会抢占其他项目域名。同一目标的域名任务和 B12 发布互斥，冲突返回 409，请等待并刷新。每项目最多 100 个有效绑定；页面最多显示 100 个绑定和最近 100 次操作。

Caddy 自动续期，平台每天观测一次，也可「刷新证书状态」更新实际到期时间与指纹；刷新不强制签发。启用路由前及最终健康检查均验证实际 TLS 叶证书的域名和有效期（`notBefore <= now < notAfter`），未来生效或已过期证书不能启用；生产模式继续验证系统信任链。

刷新遇到证书无效、HTTPS 健康检查失败、SSH 故障或超时，不再显示「HTTPS 可用」，而是「操作或检查失败，HTTPS 可用性未确认」（历史证书已到期时显示「证书已到期」）。声明、历史到期时间和指纹保留，不能据此推断当前服务正常。曾取得证书、仍有声明且已验证的绑定在失败后继续自动观测：距最近检查及失败更新均超过 24 小时后重试，成功后恢复可用；手动刷新无需等待此周期。丢失 Worker 或队列任务中断也不会永久停查。状态只代表最近主机检查结果，不能代替公网可用性监控。内部 CA 和测试 CA 页面明确提示浏览器默认不信任。

「移除域名」确认后异步删除路由和自动签发策略，成功才释放声明；不吊销证书、不清空 Caddy 缓存、不修改 DNS。目标删除要求先成功移除全部绑定。日志是固定步骤与安全错误码，支持 SSE 续传；不包含私钥或任意远端输出。

## 故障处理与回退

配置校验、reload、签发或健康检查失败时恢复上一次确认配置。`previous.json` 表示一次未完成操作，下一次操作会先恢复。Worker 本地预算 270 秒；恢复扫描会补投 30 秒以上未入队 pending，330 秒以上且无活动 job 的 running 标记失败。`domain_worker_lost_check_remote`、`domain_rollback_failed` 或强杀后，先核对 `current`、确认配置、状态和恢复标记，再重试；不要据数据库失败状态推断远端未变化。

回退应用前先停域名写入口与消费者、处理活动任务；主机所有者可恢复上一次确认配置并 reload。保留 Caddy data、密钥、数据库增量表和历史，优先前向修复，不自动反向迁移。移除路由与 B12 站点版本回滚是两个独立操作。

## 本地验证和 CI

不使用云凭据和公共 ACME。按 [MySQL 集成测试](./mysql-integration-testing.md) 准备一次性回环 `forgekit_test` 库与 Redis/15，先启动 `compose.test.yml` 并加载 `.env.test`。在仓库根目录：

```bash
export COREPACK_HOME=/tmp/forgekit-corepack
corepack pnpm typecheck
corepack pnpm db:migrations:check
corepack pnpm test
corepack pnpm build
corepack pnpm --filter @forgekit/api exec vitest run test/domain-dns.integration.test.ts

# 以下需要一次性数据库/Redis，且 sshd 全链路需要 Docker。
export FORGEKIT_DB_INTEGRATION=1
export FORGEKIT_SSH_DEPLOY_INTEGRATION=1
export FORGEKIT_DOMAIN_HTTPS_INTEGRATION=1
corepack pnpm --filter @forgekit/db exec vitest run test/domain-repositories.mysql.test.ts
docker build -t forgekit-sshd-test:b12 infra/ssh-test
docker build -t forgekit-https-test:b13 -f infra/https-test/Dockerfile .
corepack pnpm --filter @forgekit/api exec vitest run test/ssh-deploy.integration.test.ts
corepack pnpm --filter @forgekit/api exec vitest run test/domain-dns.integration.test.ts test/domain-https.integration.test.ts

# 安装与镜像相同版本的 caddy 后，不需要 Docker/数据库即可运行：
FORGEKIT_CADDY_INTEGRATION=1 corepack pnpm --filter @forgekit/worker exec vitest run test/domain-caddy.integration.test.ts
```

CI 的 `ssh-deploy-integration` 保留 B12 测试，增加 B13 数据库并发、DNS/sshd/内部 CA 全链路和非特权端口 Caddy 恢复测试。Docker 镜像先构建 B12，再以仓库根为上下文构建 B13。普通 workspace 测试跳过需外部服务的 opt-in 项，回环 DNS 始终执行。测试均有固定超时，失败不容许 continue-on-error。

HTTPS E2E 仅导出公开根证书，由测试进程写入本地私有文件，兼容通过本地 PATH wrapper 调用特权 Docker CLI 的环境；仓库与 CI 不依赖 sudo。失败会输出 curl 退出码、TLS/HTTP 诊断及容器状态、端口和最近 80 行日志，不输出私钥或容器环境变量。修改 HTTPS Dockerfile 后须重建镜像；Caddy 日志保留在容器日志中。测试结束（包括失败）会关闭消费者、API、DNS 并清理容器和临时目录。

中文为当前权威，英文对应指南待公开发布前补齐。边界及依赖取舍见 [ADR-0012](../adr/0012-domain-https.md)。
