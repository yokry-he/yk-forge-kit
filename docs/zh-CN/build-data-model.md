# 构建、日志与静态预览数据基础（B07）

状态：B07 已提供数据表、共享 Zod 契约、数据仓库及测试；B08 已新增 [队列 Worker、构建 API 与查询/取消能力](./worker-build-queue.md)。Docker Runner、对象存储、SSE、预览网关或部署执行能力仍由 B09–B15 交付。决策见 [ADR-0007](../adr/0007-build-data-foundation.md)。当前中文为权威版本，英文未翻译，对外发布前须补齐。

## 表与边界

迁移 `0008_b07_build_deploy_data_model.sql` 在已有 0000–0007 之后新增六张表，不修改已有业务表。

| 表 | 字段与约束 | 生命周期 |
| --- | --- | --- |
| `environments` | UUID、`project_id`、`name`、创建/更新时间；`(project_id, name)` 唯一，名称如 preview、production | 仅环境定义，不包含环境变量或密钥 |
| `deploy_targets` | UUID、项目、`kind=ssh`、名称、可空 host/port/username、`created_by`、创建/更新时间 | 允许尚未填写主机的记录；不包含私钥、凭证、指纹或连接检测结果，留待 B12 |
| `builds` | UUID、项目、项目内 `number`、template、source_ref、status、triggered_by、queued/started/finished/created/updated 时间；exit_code/error_message；artifact_key/size/sha256；log_storage_key；runner_info JSON | `(project_id, number)` 唯一；`(project_id, status)` 索引；终态不可重开 |
| `build_log_chunks` | build_id、seq、stream（stdout/stderr/system）、content、ts；`(build_id, seq)` 主键 | MySQL 为 MVP 构建日志的权威存储；按构建递增序号回放 |
| `deployments` | UUID、project_id、build_id、environment_id、deploy_target_id、status、创建/更新/开始/结束时间 | pending/running/succeeded/failed/canceled/rolled_back；只定义记录，不提供部署状态机；按项目/环境/状态索引 |
| `preview_links` | UUID、build_id、唯一 token_hash、expires_at、revoked_at、created_by、last_accessed_at、created_at | 仅存 64 位小写十六进制 SHA-256 摘要；按构建/过期时间及过期时间索引 |

部署关系采用 `(project_id, id)` 组合外键，构建、环境和部署目标必须属于同一项目。项目、构建及其依赖数据按外键级联删除；删除环境或目标也会删除关联的部署占位记录，B12/B13 添加删除接口时必须先确定历史保留策略。触发者/创建者引用 `users`，存在引用时禁止物理删除用户。数据仓库不承担用户身份与项目授权，调用方必须先授权；不能直接暴露按 ID 查询的方法作为接口。

仓库返回数据库行（时间为 `Date`），跨进程前应转 ISO UTC 字符串并通过契约校验。新表时间精度为毫秒，`updated_at` 由 Drizzle 的 `$onUpdateFn` 或仓库显式设置；直接 SQL 写入必须自行维护更新时间。`artifact_size` 使用无符号 BIGINT，契约与仓库限制为 JS 安全整数；`artifact_sha256` 为 64 位小写十六进制。`source_ref` 是不可变源码快照键或已解析的提交引用，`template` 是构建时的模板 ID 快照；不保存源码或可变分支的隐式解析结果。存储键是不透明标识，B09 必须在适配器边界校验路径，不能直接信任为本地文件路径。runner_info 仅含 runnerId、image 和可选 containerId，不包含凭证。

## 状态与并发

`@forgekit/contracts` 导出 `BuildStatusSchema`、`BuildSchema`、`canTransition(from, to)`、`BuildLogEventSchema`、预览创建请求/响应、Environment/DeployTarget/Deployment 对应 Schema 与推断类型。

| 当前状态 | 可进入状态 |
| --- | --- |
| queued | running、failed（调度失败）、canceled |
| running | succeeded、failed、canceled、timed_out |
| succeeded / failed / canceled / timed_out | 无 |

同状态写入也拒绝；重试需要新建构建记录。queued 不直接超时：构建执行超时仅发生于 running，队列调度失败可进入 failed。B08 的空构建允许没有产物；B09/B11 再在业务层要求可预览的成功构建具有可用产物。

- `BuildRepository.create`：在显式 `READ COMMITTED` 事务内锁定项目行，再以当前锁定读查询最大构建号并加一，首次构建为 1。父行锁保证同项目串行分配；该隔离级别避免不同项目首次写入时争用共享索引间隙锁。两个数据库连接池并发调用也不会重复。失败的事务不消耗编号。B07 不提供删除单个构建的方法；未来若删除最大编号的构建，需先引入独立计数器以保证历史编号永不复用。
- `get` / `listByProject`：按 ID 读取；项目列表按编号倒序，`beforeNumber` 是排他游标，默认 50 条，最多 1000 条。
- `updateStatus(id, from, to, patch)`：验证共享转换表及元数据白名单，事务行锁校验当前状态仍等于 from。竞争调用只有一个成功；过时或非法转换抛 `BuildTransitionError`，项目/构建不存在抛 `BuildNotFoundError`。running 设置 started_at，终态设置 finished_at，保留已有 started_at；更新元数据必须随合法状态转换进行。

数据库枚举负责状态取值，状态转换由仓库保护；直接写表会绕过转换规则。数据库错误继续上抛，由后续调用层提供任务标识、监控及脱敏日志，仓库不记录令牌、摘要或原始构建输出。

## 日志持久化与续传

架构规划未强制使用对象存储保存日志。MVP 选择 MySQL 分块，便于 B10 使用 SSE 的 Last-Event-ID 恢复连接；不新增 Redis 或存储服务依赖。`log_storage_key` 预留给 B09/后续日志归档，不改变分块表在 MVP 的权威地位，不在本项实现归档或双写。

`BuildLogRepository.append({ buildId, stream, content, ts? })` 在显式 `READ COMMITTED` 事务与构建行锁内分配从 1 开始的序号，串行提交同构建的并发追加，同时避免不同构建首次追加时争用共享索引间隙锁，防止客户端已越过较大序号后遗漏迟到的较小序号。每块最多 16 KiB（UTF-8 字节），支持多行文本；允许构建终态后补写系统收尾日志。`listSince(buildId, seq, limit)` 返回严格大于游标的序号，按序号升序，默认游标 0、500 条，最多 1000 条。轮询期间不可对活跃构建清理分块，否则可能复用序号。

全构建日志总量、保留期、脱敏、背压和清理任务未实现，B09/B10 必须在持续接收输出前补齐；分块大小限制不能代替总量限制。后续可在终态后归档并明确切换读取位置，删除或保留游标规则需同步更新。

## 预览链接

`PreviewLinkCreateRequestSchema` 的 ttlSeconds 默认为 86400（24 小时），仅接受 300–604800（5 分钟至 7 天）的整数。`PreviewLinkRepository.create` 接收 buildId、createdBy、tokenHash 和可选 ttlSeconds，计算到期时间，不接收原始令牌。B11 负责生成 32 字节密码学随机令牌（base64url 43 字符），SHA-256 后调用仓库；仅创建响应 `PreviewLinkCreateResponse` 返回一次明文 token。公开的 `PreviewLink` 元数据不包含 token 或 tokenHash，严格 Schema 拒绝额外字段。

`findValidByHash` 同时要求摘要匹配、未撤销、`expires_at > 当前时间`；过期时刻本身无效，未知摘要返回 null。查询不刷新访问时间；网关成功服务产物时调用带有效期条件的 `recordAccess`。`revoke(buildId, id)` 按构建范围撤销且不覆盖首次撤销时间，返回是否发生变更。撤销后查找/更新访问时间均无效。B11 必须在业务层校验项目权限、构建成功及产物可读；B07 只有持久化能力，尚不可通过 URL 访问预览。

## B08 增量

迁移 0009 增加 `build_audit`（项目、构建、操作者 ID、triggered/canceled、时间），创建构建与 triggered、取消状态与 canceled 分别在同一仓库事务提交。`create(input, true)` 开启触发审计，`updateStatus` 的第五参数为取消操作者；非取消转换不允许带取消操作者。build_audit 随项目/构建级联删除，不保存源码或凭证。

`listQueuedBefore` / `listRunningBefore` 是 worker 的有界恢复扫描（默认 100 条，最多 1000 条），按开始/排队时间和 ID 排序，转换仍须走状态守卫。恢复规则及双写窗口见 [Worker 指南](./worker-build-queue.md)。B08 不更改 B07 的终态不可重开和日志序号语义。

## 验证与迁移

默认 `corepack pnpm test` 跳过数据库测试。显式运行方式及一次性 Docker 环境见 [MySQL 集成测试](./mysql-integration-testing.md)。`corepack pnpm db:test:integration` 顺序运行：

1. 预 B07 迁移 → 写入旧项目 → 应用新迁移 → 重复执行迁移，检查旧数据和事务回滚。
2. B07 仓库真实 MySQL 测试：双连接池同父记录并发编号、不同项目/构建的首次及后续并发写入、状态竞争、元数据、日志序号与游标、链接摘要/默认期限/过期/撤销、外键、跨项目引用拒绝及级联删除；已有构建/日志/链接数据上再次执行迁移。

CI 的 mysql-integration Job 使用同一入口，固定开启 `FORGEKIT_DB_INTEGRATION=1`；测试沿用回环地址、3306/33306、forgekit_test 库和账号的强校验，不连接业务库。迁移工具通过 journal 记账实现重放无操作，SQL 文件本身不使用 IF NOT EXISTS。MySQL DDL 不能事务回滚；失败后须检查部分落表，不能盲目重跑。

本次是增量加表，已有接口与旧表保持兼容。上线前先备份并在副本演练。需要回退时先停用调用新表的服务，优先前向修复；只有确认可丢弃新增数据后才能按 deployments → preview_links/build_log_chunks → builds/deploy_targets/environments 的依赖顺序删除新增表，并恢复一致的迁移记账。不能仅删除迁移文件或回退应用来撤销已执行的 DDL。
