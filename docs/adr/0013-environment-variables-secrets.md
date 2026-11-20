# ADR-0013：环境变量与秘密值管理

- 状态：Accepted（B14 MVP）
- 日期：2026-11-21
- English title: Environment variables and write-only secrets

## 数据和边界

复用 B07 `environments`，不引入平行环境模型。增量迁移 `0013` 新增 `environment_variables`（环境 ID + 名称主键，项目/环境复合外键）、`variable_audit`、`build_environments`（构建/项目、环境/项目复合外键）。变量只有一种类型：plain 或 secret。plain 仅存 plain_value，secret 仅存 encrypted_value；替换时一次写入新值并清空另一列，不读取/解密旧值。变量名不能重命名；需要新建后删除旧名。每环境最多 100 项，每项目变量管理最多 100 个环境。变量修改在项目行锁下串行化，变量与审计同事务提交，使用 READ COMMITTED。审计只存操作者用户 ID、时间、项目、环境 ID、名称、类型及 create/update/delete，不存请求正文、明文或密文。更新者按用户 ID 显示，不引入额外用户资料复制。

构建在创建事务中记录环境，API 可选 `environmentName`，默认为 preview；旧构建第一次执行时在项目锁下创建并记录 preview 关联。SSH 部署沿用 B12 已记录的 production environment。API 的环境列表包含现有环境及 preview/production 默认名称，读取空环境不会创建数据库记录；首次保存变量时按名称创建或复用环境。当前不提供环境删除/重命名、变量历史或批量导出。

## 加密与只写契约

抽取 B12 `deploy-secrets` 中的同一 AES-256-GCM 构造供 B12/B14 共用；B12 的 AAD 和密文兼容不变。随机 96 bit IV、128 bit tag，显式 authTagLength=16；格式仍为 `v1.iv.tag.ciphertext`。B14 AAD 为 `b14:` 加 JSON 序列化的 `[projectId, environmentId, name]`，隔离命名空间并防止跨项目/环境/变量调换。复用 `FORGEKIT_DEPLOY_ENCRYPTION_KEY` 的 64 hex 主密钥配置和检查，API 加密、可信 Worker 解密，构建容器不得持有。无有效主密钥时秘密写入/解密失败关闭；普通变量管理不依赖密钥。临时 Buffer 尽快清零，但 JS 字符串无法可靠清零。

`GET /api/v1/projects/:id/environments/:environment/variables` 及 `GET .../variables/:name` 返回明确白名单：name、kind、updatedAt、updatedBy；仅 plain 有 value。`PUT .../variables/:name` 必须同时提供 kind 与 value，新建/替换语义统一；DELETE 删除。不存在秘密读取或解密接口。secret→plain 必须提交新的可见 value，不能通过不带 value 的类型修改解密旧值。所有变量/环境响应带 no-store。API 捕获写入异常，返回固定中文错误，不暴露 SQL 参数、密文或解密异常。控制台仅显示秘密掩码及空白替换表单，保存时清空草稿，不存入 localStorage。

名称限定 `^[A-Z_][A-Z0-9_]*$`，1–128 字符；值最多 16 KiB UTF-8，拒绝 NUL；普通值允许空串。秘密值及其每个非空行至少 4 个字符，拒绝纯空白，避免短值脱敏破坏整个日志。环境名为小写字母起始，后接小写字母/数字/下划线/连字符，最多 64 字符。拒绝 FORGEKIT_、DOCKER_、LD_、DYLD_ 前缀及 GCONV_PATH/GLIBC_TUNABLES/SSL_CERT_FILE/SSL_CERT_DIR，保护宿主 Docker CLI 的连接和加载设置；同时拒绝 runner 保留名（PATH、HOME、CI、NODE_OPTIONS、LD_PRELOAD、LD_LIBRARY_PATH、ENV、BASH_ENV、COREPACK_* 指定项、代理等，完整列表以共享契约为准）。应用 DATABASE_URL 可用，只进入应用构建阶段，不替换控制面数据库连接。

## 注入与日志

Worker 启动任务时读取环境变量快照，不把值或密文放进 BullMQ/Redis；队列仍只有记录 ID。Docker 仅在 build/generate 阶段注入，install 阶段不注入；参数为 `--env NAME`，由 Docker CLI 的子进程环境提供值，不在参数中放 `NAME=value`，不执行 Dockerfile ARG/ENV，不生成镜像历史。容器环境只显式传递允许的项目变量和已有 runner 固定值，Docker CLI 自身也移除主加密密钥。Docker inspect、宿主机管理员、同身份进程及用户构建代码仍可能读取容器环境。

SSH 静态部署将 POSIX shell 赋值格式的 `.env` 作为 0600 transport entry 放入私有工作目录内的 tar；它不属于静态制品摘要。远端在同一 flock 内解包到 staging，确认 index.html 后，先将该文件移至 `<releaseRoot>/environments/<releaseId>/.env`（父目录 0700、文件 0600），再完成 release rename 及原子 current 切换。该目录在公开 releases/current 之外。staging 环境目录先以 0700 创建并原子 rename；文件从创建到搬迁始终 0600。失败 trap 清理未启用的新目录；保留期同时清理对应环境目录。回滚沿用原 release 的 .env，不应用当前数据库变量；B12 旧 release 没有 .env 时仍可回滚。静态站不会在运行时自动加载 .env；需要公开到浏览器的参数必须由构建使用，构建/部署环境可以不同。

Docker stdout/stderr 先按 UTF-8 重组完整行，再按本次快照的秘密值及 CRLF/非空行/JSON 转义单行变体脱敏，之后预算检查、16 KiB 分块、入库。跨网络 chunk 的秘密不会被切开后写入；超长未终止行直接失败。部署日志在处理器入库前同样脱敏；SSH 远端原始 stdout/stderr 继续只用于固定标记/错误码判断，完全不转发。SSE 仅回放已经脱敏的数据库 chunks，实时读取及断线回放均在此边界之后，无含值的 Redis 发布。任务失败只存固定错误码。修改/删除秘密不会还原已脱敏日志。

## 权限、风险、验证与回退

仅 OIDC 项目成员可访问；owner/editor 有 variable:manage，viewer 只有 variable:read，未知角色默认拒绝。匿名/local 拒绝。变量写操作使用既有身份原子限流，variable-write 每小时 60 次。没有新增 npm/基础设施依赖。

加密保护数据库静态存储，不能保护可信 API/Worker 内存、swap/core dump、运维权限、主密钥与数据库同时泄漏。宿主 .env、tar 临时文件、Docker 元数据和备份需要额外访问控制与保留策略；强杀可能留下私有临时文件或已完成但未记录的远端版本。日志脱敏是尽力防护，不能阻止任意编码、分隔/变形输出或恶意构建主动泄密，也不扫描产物/镜像文件。前端构建可以将变量写入公开 JS/HTML，secret 类型不保证浏览器包保密；只向可信代码授予必要值。修改变量不会撤销已运行任务内的快照或既有 release 文件。密钥丢失后秘密无法恢复；备份和主密钥须分离保存。使用现有密钥意味着 B12/B14 同属一个主密钥故障域。

验证包括加密随机性/AAD/标签认证、只写响应、授权/校验、审计白名单、环境唯一性/事务回滚、Docker 注入和 stdout/stderr 脱敏、SSH 0600/私有路径/失败清理/回滚。MySQL 测试接入既有 db:test:integration；Docker/SSH 场景扩展现有 opt-in CI suites，本地默认跳过。数据库迁移必须运维显式执行，不随应用启动运行。

回退前停止变量写入及相关消费者，核对活动构建/部署，保留新增表、历史、主密钥和远端私有配置，优先前向修复。不自动反向 DDL，不自动删除主机配置；旧版本 Worker 不支持注入，不能宣称无损回退。本次不含 KMS、信封数据密钥、自动轮换 UI、外部 Vault、秘密版本 UI、运行服务重启或日志内容追溯重脱敏。中文权威，公开发布前补齐英文关键指南。
