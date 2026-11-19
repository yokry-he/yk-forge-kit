# ADR-0008：构建队列与 Worker 编排骨架

- 状态：Accepted（B08）
- 日期：2026-11-19
- English title: Build queue and worker orchestration skeleton

## 背景与决策

沿用 [ADR-0007](./0007-build-data-foundation.md) 的 B07 状态转换表、事务仓库与 MySQL 日志，不执行用户代码；Docker Runner、产物存储实现属于 B09，SSE/控制台属于 B10，预览属于 B11。

1. `apps/worker` 使用 Node 22 + TypeScript 普通进程。它只有队列消费、定时健康检查和能力接口组合，不需要 HTTP 容器、依赖注入框架或 NestJS 生命周期；API 继续使用 NestJS。业务处理器只依赖仓库能力与 `BuildRunner`、`BuildLogSink`，BullMQ 启停放在独立适配层。依赖方向 worker → db → contracts，API → db/contracts/identity-core，无应用间运行时依赖。
2. BullMQ 5 + Redis 7，队列 `builds`、job name `build`、严格载荷 `{ buildId: UUID }` 定义于 contracts。jobId 等于 buildId。数据库保存源码/模板/触发者与状态，载荷不含脚本、连接信息或凭证。队列重试用于基础设施异常，业务失败保留终态；用户重试创建新构建。
3. SQL 状态仓库是最终权威；API 先提交 queued 与 triggered 审计，再入队。入队报错使用 queued→failed CAS，不覆盖抢先进入 running 的任务。数据库与 Redis 不共享事务：worker 每次启动及心跳补投递 30 秒前的 queued 记录（每批 100 条）；相同 ID 入队去重，补偿提交后入队前崩溃。已在 Redis 永久 failed/completed 但仍 queued 的记录经守卫转 failed，避免失败任务去重导致永远排队。该方案有 30 秒以上调度延迟，不承诺严格事务消息/恰好一次。
4. 不在 worker 启动时把全局 running 一律失败。BullMQ 续租锁与 stalled 检测重领任务，避免重启一个副本误伤其他副本。持锁处理器重领 running 时经守卫转 failed（worker_lost），绝不再次执行。失去 Redis 任务或已永久 failed/completed 的 running 记录，在开始时间超过执行超时 + 60 秒后经扫描与 CAS 转 failed。仍处 active/waiting/delayed 的任务交给锁与重领机制。两种扫描均每批 100 条；Redis 必须持久化、使用 noeviction，不能将清空 Redis 当作重试机制。
5. API 通过 OIDC 成员授权，owner/editor 可触发/取消，viewer 可读；本地匿名模式不允许构建写操作。沿用项目接口 `/api/v1` 前缀，本模块按项目 UUID 寻址。新增 build_audit（迁移 0009），创建/取消审计和状态写入同事务。复用已有原子身份限流表，以独立 build-trigger/build-cancel 前缀隔离配额。
6. API 的 REDIS_URL 可缺省，保持本地无外部服务启动体验，触发时明确 503 且不建行；配置非空但无效则启动失败。连接延迟到首次触发，有限请求重试、连接/命令超时。worker 的 start 要求 Redis/MySQL；dev 在缺少任一地址时打印 disabled，便于根 dev 启动其他应用。退出时先暂停本消费者接收（不等待活跃任务），再中断当前 Runner、运行中构建写 failed；等待心跳和活跃任务完成后关闭消费者/生产者/数据库。取消、超时和停机均须等待 Runner promise 完成资源清理，处理器才可结束并释放并发槽位与队列锁。

## 依赖评估

[BullMQ 官方仓库](https://github.com/taskforcesh/bullmq) 采用 MIT，持续维护，提供 TypeScript 类型、锁续期和 stalled 恢复；[连接规范](https://docs.bullmq.io/guide/connections) 要求消费者无限请求重试、HTTP 生产者有限重试，[stalled 说明](https://docs.bullmq.io/guide/jobs/stalled) 明确重领行为。本次版本与传递依赖固定在 pnpm-lock.yaml，Node 22 编译、HTTP 冒烟和 Redis 7 + MySQL 8 集成测试验证兼容性。BullMQ 带来 Redis 运维、Lua 脚本与传递依赖风险；不增加可选 native 构建脚本授权，日志不输出连接串/底层错误。升级需复跑恢复、并发、取消和真实队列测试，并关注锁丢失、依赖安全公告与 Redis 版本。替换队列只涉及生产者/消费者适配器，状态与日志仓库和 Runner 接口不依赖 BullMQ。

本次 `pnpm audit --prod` 未报告新增 BullMQ 依赖问题，但报告已有 Drizzle ORM 0.44.7 的 [GHSA-gpj5-g38j-94v9](https://github.com/drizzle-team/drizzle-orm/security/advisories/GHSA-gpj5-g38j-94v9)（high，修复版本 0.45.2）。审查 B08 查询仅使用静态 schema/列，没有把用户输入传给标识符或别名构造；已有 ORM 升级留待独立变更，不混入本项。

## 限制与回滚

这是空构建闭环：NoopRunner 仅持久化三行固定输出，不访问 sourceRef、不生成产物。BuildRunner 必须响应 AbortSignal 并清理执行资源，日志写入须 await 提供背压；B09 仍需实现 Docker 隔离、失锁后的执行隔离/清理、日志总量/脱敏/保留期和 ArtifactStore。数据库状态成功不代表已生成工程或可预览。操作说明、状态图与边界见 [Worker 指南](../zh-CN/worker-build-queue.md)。

回退应用前先停用触发入口并停止 worker，保留构建/日志/审计。迁移 0009 为增量加表，优先保留并前向修复；确认可丢弃审计后才可单独删 build_audit 并恢复迁移记账，不自动执行反向 DDL。中文是当前权威；英文尚未翻译，公开发布前补齐。
