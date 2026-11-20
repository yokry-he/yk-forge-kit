# ADR-0012：自定义域名与自动 HTTPS

- 状态：Accepted（B13）
- 日期：2026-11-20
- English title: Custom domains with Caddy

## 决策

延续 ADR-0011 的静态发布模型，在专用主机上使用 Caddy。证书签发和续期由 Caddy 负责；控制面只编排验证、配置和观测。默认采用内部 CA，生产模式必须显式启用。自动化测试使用离线 CA。

## 边界

新增迁移 `0012`：域名、操作、日志；部署目标复用 B12。目标行锁使域名操作与部署互斥。未验证的重复记录不占用域名；DNS 通过后用全局唯一 nullable claim 消除跨项目竞争。声明在签发失败后仍保留，只有远端移除成功才能释放。每项目最多 100 个未移除绑定，列表和历史各返回 100 条。

域名只接收受限 ASCII DNS 名（可显式提供 IDNA A-label）；不接受 URL、IP、通配符、端口及配置片段。验证要求所有 A/AAAA 都属于目标主机地址集合，并有本绑定随机 256 bit token 的 `_forgekit-challenge` TXT。DNS 暂未生效保持 pending_dns，不触发 SSH；解析失败与记录不匹配分开记录。NAT、CDN 或与 SSH 主机地址不同的入口不在本次支持范围。

API 仅允许 OIDC 项目成员；owner/editor 写、viewer 读，沿用部署限流。TLS 模式由运营环境控制，不能由请求选择。独立 BullMQ `domains` 队列只包含 operationId，Worker 通过 DNS/DomainHost 能力接口集成解析器及固定 SSH 程序。继续采用 B12 的 AES-GCM 密钥存储、严格公钥 pin、参数数组、私有临时文件及固定错误码；不接受任意命令，不持久化远端原始输出。SSE 使用独立一次性票据命名空间，沿用持久化回放、权限复核、背压和连接上限。网关限额应覆盖构建、部署和域名三类流。

## 主机配置与失败恢复

主机管理员预先安装 Caddy 2.10.2、Python 3、OpenSSL 和 B12 工具，以专用部署用户运行 `prepare.py` 初始化私有目录。Caddy 与该用户共用专用配置/数据目录，admin 只监听 Unix socket；不修改既有系统 Caddy/Nginx 配置，不给 Worker sudo。每个 Caddy 实例只管理一个 basePath，不能共用公共监听端口；多目标共享此实例时由 flock 串行化配置更新。域名跟随 B12 `current`，新发布及站点回滚无需重写域名配置。

固定远端程序写候选 JSON 并校验，通过 admin API 应用；先签发、检查 hostname/有效期，再启用静态路由并通过 SNI HTTPS 检查 index.html 为 200。启用路由前和最终健康检查均验证实际 TLS 叶证书满足 `notBefore <= now < notAfter`，未来生效与已到期证书不能提交为可用。只为已启用域名返回 HTTP 308；未知主机返回 404。production 使用系统 CA 验证链；internal/staging 不验证公共信任链，但检查 hostname、有效期和 SHA-256 指纹。测试客户端另用本次根证书验证链与 hostname。

配置和状态原子替换，`previous.json` 保留上一次确认版本，失败时 reload 旧配置；回滚失败保留标记并返回明确错误。下次操作首先恢复。启动必须读取 `caddy.json`，不能用 `--resume` 恢复尚未确认的 runtime autosave。强杀后须核对主机，不宣称跨 SSH/MySQL 恰好一次。远端预算 240 秒加 5 秒 kill grace，本地 270 秒；pending 超过 30 秒补投，running 超过 330 秒且 Redis 无活动 job 则失败并要求核对远端。

Caddy 独立自动续期；Worker 每日观测 active/expired 绑定，手动 refresh 同样只观测，不强制签发。刷新失败不能沿用 active；以 failed（或历史证书已到期时 expired）记录未确认的可用性，保留声明及历史证书。曾取得证书、仍有声明且已验证的 failed 绑定也参与每日观测，与健康状态分开判定；同时要求最近检查和失败更新时间早于 24 小时阈值，避免 SSH、超时、队列或丢失 Worker 导致永久停查或每次心跳重试。重试成功恢复 active，移除后不再观测。配置变更失败且已确认回滚时仍可保留此前 active，不能将此规则用于纯观测失败。数据库状态是最近检查结果，序列化时过期证书不会显示 active。remove 删除路由和自动化策略，不调用 CA 吊销、不清除缓存。未验证绑定直接移除。存在未移除绑定时禁止删除部署目标。

## 依赖

不新增 npm 依赖。采用已有 SSH 边界及官方 Caddy；[Apache-2.0 许可](https://github.com/caddyserver/caddy/blob/v2.10.2/LICENSE)兼容仓库，[自动 HTTPS](https://caddyserver.com/docs/automatic-https)及 [admin API](https://caddyserver.com/docs/api)提供所需能力。升级需审查上游维护/安全公告并重跑真实签发、reload 和 SSH 集成。Python/OpenSSL 是主机依赖，替换成本限定在 DomainHost 适配器。

默认 internal 不向公网 CA 发请求，浏览器默认不信任；staging/production 由运营方显式启用，要求公网 DNS、80/443、CA 限流管理及持久化存储。测试不访问公共 ACME，不能证明生产签发成功。暂不支持 DNS-01 云插件、泛域名、自带证书、吊销、CDN、动态服务或集群配置同步。

## 验证、回退

单元测试覆盖输入、授权、DNS、状态机、SSE 和控制台。真实回环 DNS 不访问外网；Caddy 测试覆盖签发、重复应用、reload 失败回滚、恢复标记、多域名隔离和移除。MySQL 覆盖并发 claim、目标锁、单调日志及迟到终态。CI 保留 B12 镜像及 SSH 测试，再运行 B13 DNS/sshd/内部 CA 全链路，门禁显式开启，不允许 continue-on-error。

回退时先停止域名写入口和消费者，核对活动任务，在主机恢复最后确认配置或移除绑定。已配置 Caddy 会继续服务与续期；保留增量表、历史、主密钥及 Caddy data，优先前向修复，不自动反向 DDL。中文权威，公开发布前补齐英文对应指南。实际验证限制记录在交付摘要。
