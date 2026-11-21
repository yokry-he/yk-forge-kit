# ADR-0014：已部署站点在线运行日志

- 状态：Accepted（B15 MVP）
- 日期：2026-11-21
- English title: Bounded online runtime logs over pinned SSH

## 决策与边界

延续 ADR-0010–0013。主机是日志主存储，控制面仅保留短时、已脱敏的最近日志。API 不连接 SSH：创建 `runtime_log_sessions` 后，BullMQ `runtime-logs` 队列仅传 `{ sessionId }`，可信 Worker 从数据库解析站点/部署目标并执行固定 SSH 读取程序。不新增 npm 依赖或日志代理。迁移 `0014` 连同 Drizzle journal/snapshot 增量交付，须运维显式执行，应用启动不迁移。

来源枚举严格限制为 `caddy-access`、`caddy-error`。只接受已部署、已验证且仍保留域名声明的本项目绑定；目标 ID、SSH 地址和路径都由绑定推导。B13 的固定配置生成器新增按绑定 UUID 隔离的 JSON 文件：`<basePath>/.forgekit-caddy/logs/<domain UUID>/{access,error}.jsonl`。Caddy HTTPS/HTTP server 的 hostname→logger 映射与 `http.log.access.site_<UUID>` / `http.log.error.site_<UUID>` include 精确对应；禁记未映射 host，不把整个 Caddy 实例日志暴露给某个项目。error 是站点 HTTP 请求处理错误，包含 DEBUG 级 4xx 诊断；TLS/ACME/启动等实例日志不在此来源内。文件每份 16 MiB 滚动、保留 3 个备份/7 天，由主机 Caddy 管理。

新验证自动生成配置；旧 B13 站点需成功刷新证书状态或重新验证一次。刷新只观测证书并按原有 previous/config 恢复模式升级日志配置，不强制续签；现有路由/current 保持原有语义。运维可继续使用旧配置服务，但没有固定日志文件时 B15 明确失败，不回退读取共享系统日志。[Caddy 2.10.2 hostname logger 源码](https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddyhttp/logging.go)和[请求错误 logger 源码](https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddyhttp/server.go)是此隔离方式的依据；真实 Caddy 测试验证两个域名的访问及错误日志不会交叉。

## SSH 与读取

复用 `sshArguments` 的 B12 公钥 pin：StrictHostKeyChecking、私有 known_hosts、IdentityAgent=none、禁密码/配置/转发，不增加信任降级。私钥解密后写入私有 0700 临时目录中的 0600 文件，完成后删除；Buffer 及时清零。新增流式执行边界沿用固定 OpenSSH argv、固定错误码、受限环境；不把任何 stdout/stderr/原始异常写入进程日志。

客户端 strict DTO 不接受 path、glob、unit、argv、host 或 command。Worker 再次验证来源、UUID、B12 basePath 和行数；shell 仅接收固定程序及受限的服务器派生路径，关键词等筛选内容完全不进入远端参数。固定 Python 3 程序通过逐级 `openat`/O_NOFOLLOW 拒绝目录和文件软链接，只读普通文件；先从文件末端最多扫描 1 MiB，取最近 N 个完整行，再以同一文件位置跟随。轮换 inode 或截断后重新读取，不扫描备份；同 inode 截断后迅速增长的竞态可能丢行。末尾不完整行不发布，防止强制中断时暴露秘密片段。Linux/Python3/GNU timeout 均已是 B13 主机前置条件，测试 sshd fixture 增加 Python3，无须 systemd。

远端单进程在 60 秒后结束，外围 timeout 65 秒 + 2 秒 KILL 宽限；Worker 本地截止时间从会话创建计算，SSH 在客户端断连、访问撤销、租约到期、停机或目标撤销时中止。没有单独 tail 子进程。SSH 本地 TERM 后 1 秒 KILL；正常断线通常关闭远端程序，但网络分区、sshd/主机故障及强杀不能保证即时清理，远端 timeout 是额外保护，不宣称无孤儿进程。

## 脱敏、筛选与持久化

复用 B14 `redactBuildLog`、完整 UTF-8 行重组和 `CappedBuildLogs` 分块。Worker 在会话启动读取本项目所有当前环境秘密及其当前密文脱敏项（静态产物可来自 preview 构建），不将值放进队列。SSH 适配器先额外遮蔽私钥、密文及主加密密钥；处理器再次按 B14 秘密快照脱敏，之后才筛选、检查存储预算及入库。SSE/REST 只读已脱敏块，不存在原始日志下载接口。

筛选为精确级别、最近 5/15/60 分钟起（或不限制）、区分大小写的安全子串。先取最近 N 行再过滤，不为凑足 N 个匹配扫描历史。时间起点固定为会话创建时间减窗口，实时日志继续接收；缺少合法 JSON level/ts 的行在启用相应过滤时排除。Caddy ts 秒数或 ISO 日期均支持。关键词最多 200 字符、拒绝控制字符，`.*` 等字符仅按字面值匹配。

每会话默认 200 行、最大 1000 行；SSH stdout 总计最多 1 MiB、单行最多 64 KiB，stderr 最多 64 KiB且不转发；持久化再限制 1 MiB、10000 块，每块最多 16 KiB。大小预算包含不匹配的原始 SSH 输出，无法借筛选绕过读取上限。会话最长 60 秒（含排队），到期后保留 10 分钟用于回放，Worker 每秒清理到期数据及级联 chunks。Worker 离线期间物理清理延后，API 仍拒绝超出保留期的数据；恢复 Worker 后清理。无长期历史采集。

## 权限、票据和负载

沿用 `deploy:read`：OIDC owner/editor/viewer 可发起只读会话；未知角色默认拒绝，local/匿名拒绝。每次创建、REST、签票、票据兑换及 SSE 持续读取复查项目权限；会话还绑定发起者用户 ID，不允许其他成员读取其会话。返回值仅有显式白名单 DTO，不序列化数据库行、主机地址、密钥、租约、筛选输入或 SSH 对象。

独立 `runtime-stream-ticket` Redis SHA-256 命名空间，32 随机字节、60 秒 TTL、GETDEL 单次消费、绑定项目/会话/身份；请求日志先清除整个查询串。继续使用 B10 log/status/end/stream-error、Last-Event-ID、单调 seq、MySQL 回放、终态 high-water、15 秒心跳、5 秒背压、进程 100/身份 4 连接和 10000 帧预算。断线重连可回放已缓冲数据；继续读取主机须新建会话，不自动反复启动 SSH。

使用现有身份原子限流：runtime-start 每分钟 12 次，runtime-poll 每分钟 120 次（含取票/REST/取消，内部 SSE 轮询不消耗此额度也不重启 SSH）。数据库 admission mutex 串行化跨副本准入：同用户 2、项目 4、SSH endpoint（规范化 host 字段 + port 摘要）4、全局 100 活跃会话；DNS 别名或不同 SSH 入口不视为同一物理主机，出站 ACL/网关仍需统一保护。会话初始租约 15 秒等候连接；每会话跨副本只允许一个流持有租约，活跃租约 5 秒，API 大约 500ms 刷新/复查权限；Worker 大约 500ms 检查，断连取消，API 崩溃按租约到期停止。慢客户端无法无限持有 SSH；跨进程配额不依赖 API 内存。队列不重试 SSH，running 重投不重复读取。

## 残余风险、验证与回退

原始日志仍在客户主机上，可能含查询参数、个人信息或秘密，需管理员配置访问控制与保留。B14 脱敏是尽力保护，不能识别任意编码/拆分、已删除/替换的历史秘密或恶意主机输出；会话只使用启动时秘密快照，修改秘密后应停止旧会话并新建。JS 字符串、进程内存、临时文件、swap/core dump/备份风险沿用 B12/B14。主机管理员能改写日志与目录；不提供日志真实性或完整性的强保证。按字节/时间/行限制可能截断历史和高吞吐日志，文件轮换/断线期间可能丢行，不是可靠日志投递服务。

测试包含 strict DTO/命令注入、固定路径、过滤、UTF-8/跨块脱敏、预算、租约/中止、公钥失败、授权/票据期限/SSE背压与回放、Vue 协议及交互、MySQL并发准入/序号/清理，以及真实 Caddy 的双站点访问/错误日志隔离。既有 ssh-deploy-integration CI 增加 B15 MySQL 测试并扩展 B12 Docker sshd 的种子日志→SSH tail→实时追加→脱敏持久化/SSE→取消全链路；默认 pnpm test 继续按现有 opt-in 跳过重型集成。

回退先停用运行日志 API/消费者，等待最多远端预算并核对主机。保留增量表，优先前向修复；不自动反向 DDL。新增 Caddy 文件日志不妨碍旧应用读取站点，按需通过 B13 已确认配置恢复。中文权威，公开发布前补齐英文指南。

范围外：journald（未开放任何 unit）、docker logs、动态服务/Node 日志、日志代理/主机守护进程、第三方日志平台、全文检索集群、跨轮换历史检索、原始未脱敏日志下载、长时会话与告警。
