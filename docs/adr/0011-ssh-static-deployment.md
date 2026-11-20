# ADR-0011：自有 Linux 主机 SSH 静态发布

- 状态：Accepted（本次 B12 指定范围）
- 日期：2026-11-20
- English title: Pinned SSH deployment of static build artifacts

## 边界与数据

延续 ADR-0007–0010。不创建平行的目标/发布模型：扩展 B07 `deploy_targets`、`deployments`，首次部署在同项目下复用或创建 `production` environment。迁移 `0011` 新增字段均有默认值或可为空，已有占位记录保持可读，缺少公钥/密钥/目录的目标不能执行。数据库迁移不随应用启动执行。

目标新增主机公钥、基础目录、保留数（1–50，默认 5）、当前 release UUID、软删除时间和私钥密文。部署新增 action（deploy/rollback）、release UUID、回滚来源部署 ID、触发者、retained 和固定错误码。一次回滚创建新部署记录，以 B07 `rolled_back` 表示该回滚操作完成；原始成功发布记录继续表示保留版本，不被反复覆盖。`deploy_audit` 原子记录目标创建/修改/删除、部署/回滚请求；不存密钥、公钥摘要、请求正文或底层异常。`deploy_log_chunks` 沿用 B10 单调序号及 16 KiB 分块边界。

同一目标的目标修改/删除与任务创建通过目标行锁串行化；pending/running 时拒绝并发写操作。目标保存事务沿用 ADR-0007 的事务级 `READ COMMITTED`，避免不同项目首次创建目标时缺失行锁定读产生共享间隙锁死锁，不改变数据库全局隔离级别。应用只允许一个目标有一个待执行/运行中的任务。不同目标的目录以项目与目标 UUID 隔离。已有部署历史后禁止改变 host/port/username/basePath，迁移必须创建新目标，避免历史回滚写到另一台机器。删除软停用目标并清空密文，保留历史与审计；不通过 SSH 删除服务器上的文件。

## 密钥与连接

使用 Node 标准库 AES-256-GCM，随机 96 bit IV、128 bit tag；解密严格校验 IV 为 12 字节、tag 为 16 字节，并显式指定 `authTagLength: 16`，拒绝截短标签。以项目/目标 ID 为 AAD，防止跨记录替换。密文格式 `v1.iv.tag.ciphertext`（各段 Base64）。32 字节主密钥由部署环境提供，与数据库/备份分离；API 和可信 Worker 持有，构建容器不继承。API 明确列白名单序列化，不返回密文或私钥。编辑不传 privateKey 则保持原值。MVP 使用用户在本机生成的专用无口令密钥，API 拒绝加密私钥；不接收密码、passphrase、agent、云账号凭据或任意连接选项。

可信 Worker 通过 OpenSSH CLI 适配器连接，不新增 SSH npm 库。`spawn` 参数数组、`-F /dev/null` 禁止本地配置注入，固定 `StrictHostKeyChecking=yes`、私有 known_hosts 和 HostKeyAlias，只允许指定 hostKey 的算法；关闭系统 known_hosts、密码、交互、agent、转发和自动更新主机密钥。公钥必须由用户通过可信控制台核对，不能自动信任 ssh-keyscan 的网络结果。每个任务私有临时目录 0700、identity/known_hosts 文件 0600，任务结束后删除，解密 Buffer 及时清零；主机和运维方还须保护 tmp、进程内存、swap、core dump 与备份。进程强杀不能保证临时文件已删除。

输入只接受 IPv4/普通 DNS 名、1–65535 端口、非 root 的标准 Linux 用户及受限绝对基础路径。拒绝参数/通配符/URL/shell 字符、明显元数据地址、链路本地及组播 IPv4。允许回环与私网以支持本地测试和自有网络；语法检查不提供 DNS/SSRF 隔离，可信 SSH 执行面必须用出站 ACL 隔离控制面/元数据网段。不给用户传任意远端命令的接口。

## 执行与恢复

独立 BullMQ 队列 `deployments`，job name `deploy`，载荷只有 `{ deploymentId }`，jobId 等于数据库记录 ID。复用 B08 的 Redis 参数及 Worker 进程生命周期，不从 API 发起 SSH。启用密钥但缺少绝对制品目录时 Worker 启动失败；未配置主密钥则部署消费者关闭，既有构建消费者可工作。

只支持 B09 的静态目录。通过 ArtifactStore 的安全枚举/读取边界拷贝到私有工作区，重算排序文件清单 SHA-256 与构建摘要比对；最多 100 MiB、10000 文件，必须有 index.html，不跟随链接，不执行产物脚本。打包时将站点目录权限统一为 0755、文件为 0644，不受 Worker umask 影响；不改变私钥及 known_hosts 的 0600 权限。保留 `DeployArtifact` 静态/镜像的类型边界供未来适配器扩展；当前数据库没有镜像摘要模型，未实现镜像或 Node 服务发布。

远端约定 GNU/Linux + OpenSSH server、sh、GNU tar/coreutils(timeout、mv -T)、util-linux flock。工作根是 `<base>/forgekit-<project UUID>-<target UUID>`。单次 SSH 内远端 flock 覆盖传输、切换和清理，timeout 300 秒（另有 5 秒终止宽限）；本地总预算 330 秒，连接超时 10 秒，keepalive 5 秒/2 次。GNU tar 解包到 `.staging-<operation UUID>`，验证 index.html，写完成标记后 rename 成 `releases/<release UUID>`；以同目录临时 symlink + `mv -Tf` 原子替换 current。显式失败退出检查不能只依赖 `set -e` 的 AND-list 行为。trap 清理临时目录/链接及未被 current 引用的新发布，失败不会切到不完整目录。

同一发布的已完成重投仅在 current 仍指向它时复用，不覆盖完整目录或反向覆盖新发布。正常业务重试创建新部署；running 重投不再次执行。pending 提交/入队间隙超过 30 秒后补投；running 遗失任务超过 330 秒 + 60 秒宽限且 Redis 无活跃任务后标记 failed。消费者停机先停止接收、abort 并等待本地进程清理。远端断线、Worker/数据库故障发生在切换后可能造成“远端完成、数据库未知”；该记录失败错误码明确要求核对主机，不宣称跨 SSH/MySQL 的恰好一次或自动灾难恢复。此时先核对 current/完成标记与发布记录，再选择已有保留版本回滚或发起新发布。即使 SQL 仍将该保留版本标为当前，也允许创建回滚任务并幂等切换；远端已经指向它时，仅重新确认该版本，不拒绝恢复请求。

切换成功后按数据库中该目标发布的创建时间保留最近 N 个版本（含本次），只删除已知 release UUID，不扫描/删除任意基础目录。回滚只切换仍 retained 且有完成标记的原始成功发布，不重新上传、不改变保留顺序。远端手工改动或清理会使回滚失败；不自动恢复被运维删除的制品。清理失败会使任务失败，current 仍可能已指向完整新版本，需人工核对；下次成功发布会重试已知旧版本清理。

## 日志、权限与依赖

仅持久化固定步骤和经过白名单筛选的错误码，任意 SSH stdout/stderr、解密异常和原始 Error.message 不入库。远端响应只用于识别固定完成标记及 host-key/auth 失败；stdout/stderr 合计 64 KiB，超限失败。owner/editor 可管理目标与发布/回滚，viewer 可查看历史与日志；local 匿名模式全部拒绝。使用既有原子身份限流（deploy-write，60 次/小时）。

部署 SSE 复用 B10 的协议/数据库回放策略：独立 Redis `deploy-stream-ticket` 命名空间、一次性 60 秒摘要票据、每连接 500 块读取、背压/心跳/权限复核/终态 high-water、每身份 4/进程 100 连接。构建流与部署流的票据不能互换；网关总限额必须覆盖两类流。控制台复用日志文本净化和显示上限，渲染纯文本，断线续传有序补齐。

本项明确要求 Element Plus；既有 console 尚未使用它，新增固定 2.14.8（MIT）的成熟 Vue 3 组件库，仅业务部署视图使用。参考[官方安装与兼容说明](https://element-plus.org/en-US/guide/installation.html)、[许可证](https://github.com/element-plus/element-plus/blob/dev/LICENSE)。支持现有 Vue 3.5/TS5.9/Vite7，锁定传递依赖，无新增构建脚本授权。迁移成本限于部署表单和按钮，布局/业务状态仍归 console，不抽取 yk-forge-ui。使用延迟页面/面板与组件样式导入降低首屏影响；升级需复跑组件/无障碍及打包验证。OpenSSH 的安全选项参考[官方手册](https://man.openbsd.org/ssh_config)，GCM 参数参考 [Node crypto 文档](https://nodejs.org/docs/latest-v22.x/api/crypto.html)。

## 验证与回退

测试覆盖密文认证/随机性/AAD、输入拒绝、主机校验选项和错误分类、异常不泄密、真实本地脚本的部署/重投/回滚/保留/失败清理、API 授权与 SSE、控制台表单与日志续传。独立 CI `ssh-deploy-integration` 使用专用 MySQL/Redis 及 Docker sshd，测试 key/hostKey 每次生成，无云凭据；使用与其他集成测试相同的 opt-in 环境门禁，本地默认跳过，CI 必须运行而非 continue-on-error。

本次环境无 Docker socket 权限，真实容器集成未在本地运行，不能将本地脚本测试当作容器端到端通过。回退时先停止部署入口与消费者，核对所有 pending/running，保留历史、日志、密钥主密钥和增量表列，前向修复优先。需要恢复站点时人工切回已有完整版本。不自动执行反向 DDL。中文权威，英文关键指南尚待公开发布前翻译。
