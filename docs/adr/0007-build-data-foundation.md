# ADR-0007：构建、日志与预览数据基础

- 状态：Accepted（B07 指定的数据基础范围）
- 日期：2026-11-19
- English title: Build, log and preview persistence foundation

## 背景与决策

B08–B11 需要稳定的构建状态、产物定位、日志续传和有期限预览契约。B07 明确要求保留 environments、deploy_targets、deployments，但本次不提前实现部署执行、密钥管理或 API。

1. 沿用 MySQL 8.0、Drizzle 与版本化 SQL 迁移。构建编号通过锁定项目行的事务分配；状态转换由 contracts 的纯函数定义，仓库以行锁和预期状态共同保护。终态记录不可重试回 running，重试创建新记录。
2. MVP 构建日志使用 MySQL `build_log_chunks`，以构建内单调序号支持续传。逐块写入锁定构建行，单块限制 16 KiB UTF-8；未来接收日志前还需补总量、保留期、脱敏和背压。架构规划未指定强制对象存储日志；保留 log_storage_key 供后续归档。
3. 预览令牌只持久化 SHA-256 摘要；TTL 限制为 5 分钟至 7 天，默认 24 小时。仓库不生成/接收明文令牌，B11 负责随机令牌生成、单次交付、项目权限和产物可用性验证。
4. 部署占位关系采用同项目组合外键；本次不存密钥、指纹、环境变量、发布版本或部署日志。项目删除级联清理新表依赖；有关联的用户不能物理删除。后续主机/环境删除 API 需再评估历史保留策略。
5. 引入 Zod 4 统一新契约的运行时校验与静态类型，不重写已有契约。它是持续维护的稳定库、无外部运行时依赖、MIT 许可，支持仓库严格 TypeScript 5.9 及 Node/浏览器；实际版本由 pnpm-lock.yaml 锁定。安全边界包括严格对象、摘要格式、数值/文本长度及 TTL 校验，不能替代授权或 Runner 隔离。升级需复跑契约、编译后 API 与控制台构建；替换成本限于新 schemas 及调用 `.parse` 的仓库边界。参考 [官方文档](https://zod.dev/) 和 [许可证](https://github.com/colinhacks/zod/blob/main/LICENSE)。
6. contracts 保留前端 ESM import 的源码入口，并新增 CommonJS 编译产物的 require 入口，使 db/API 编译后的 Node 进程能加载同一纯函数；无 NestJS、驱动或云 SDK 反向依赖。依赖方向为 db → contracts。

## 取舍与后续

MySQL 追加写入比对象存储日志更易实现精确续传，但高吞吐会增加控制面数据库压力；未来应明确归档切换和终态清理策略。项目行/构建行锁使并发规则清晰，但同一项目编号和同一构建日志追加会串行化。当前用保留记录的最大编号分配，不提供单构建删除接口；引入历史清理前必须增加不会复用编号的独立计数器。

部署记录仅是数据占位，不承诺完整状态机或回滚语义。Runner 沙箱、Artifact Store、预览子域/证书、密钥管理和完整日志存储策略由对应 backlog 另立 ADR。迁移验证、字段说明和回退策略见 [构建数据模型](../zh-CN/build-data-model.md)。
