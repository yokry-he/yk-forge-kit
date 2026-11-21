# ADR-0016：微信小程序上传与预览

- 状态：Accepted（B17）
- 日期：2026-11-22
- English title: WeChat mini-program upload and preview

## 背景与决策

[B16](./0015-uniapp-template.md) 提供 uniapp 模板和本地 mp-weixin 编译入口，平台构建此前只有 H5 静态计划。B17 沿用 B07 数据仓库、B08 BullMQ 补偿、B09 Docker / ArtifactStore、B10 SSE 和 B14 密钥处理，增加从成功小程序制品到微信开发版本及预览二维码的人工触发路径。

1. 为 builds 增加 h5 / mp-weixin 目标，默认 h5 兼容旧记录。仅 uniapp 支持 mp-weixin，模板源调用固定 `build:mp-weixin`，输出 `dist/build/mp-weixin`，必需 app.js / app.json / project.config.json；静态路径继续要求 index.html。上传入队与 Worker 执行均校验同项目、成功状态、目标与完整制品定位；复用 ArtifactStore，复制时再次检查链接、路径、大小、条目及清单 SHA-256。没有新增任意本地路径 / 源码上传通道。
2. 每项目一个 weapp_configs，AppID 和人工 IP 备注可读，RSA PEM 上传私钥仅写入。复用 deploy-secrets 的 AES-256-GCM 格式及 B14 主密钥，增加 `b17:<projectUUID>` AAD，用途与项目隔离。API 显式白名单序列化，不回传密文 / 明文；错误固定文本、审计仅动作 / 操作人 / 项目 / 任务标识，禁止原样记录驱动与 SDK 错误。首次设置和更换 AppID 要求新私钥；删除配置不抹除历史任务。
3. 采用独立 weapp_jobs / weapp_log_chunks 与 `weapp` 队列，消息仅 jobId。项目锁序列化配置 / 创建操作，每项目最多一个 queued / running 任务；任务保存版本、描述、机器人、操作与 AppID，不快照私钥。启动时使用当前密钥，AppID 变化 / 配置删除则失败。同 AppID 的轮换使用新密钥。事务写任务与无敏感信息审计，再入队；30 秒补投递、Redis 去重与 CAS 沿用 B08。上传有外部副作用，不对 running 重领执行；390 秒后无有效队列任务则失败，提示人工核对微信后台。
4. 上传使用 **独立 Docker 步骤**，通过 worker 内 `WeappRunner` 能力接口隔离 SDK 适配器。B09 安装 / 构建容器分别受 registry / 禁网约束，不能为上传放宽其网络或把私钥交给项目脚本；故复用 Docker CLI、日志上限与制品接口，另建可信的预装 SDK 镜像及独立出口网络。容器非 root、只读根、cap-drop、禁止提权、默认 seccomp、资源上限、log-driver=none；仅本次只读输入和可写输出挂载，无 Docker socket / 平台凭证。SDK 处理临时副本，替换 project.config.json，不加载项目插件 / node_modules，不运行构建或安装脚本。300 秒容器内期限 + 330 秒 Worker 期限；删除确认后才遍历输出 / 清理工作目录。不能确认删除时保留目录，运维恢复后清理。Docker 共享内核风险与宿主隔离要求沿用 ADR-0009。
5. 官方 [miniprogram-ci](https://github.com/wechat-miniprogram/miniprogram-ci-dist) 的 upload 上传开发版本，preview 生成 JPEG 预览二维码。支持 upload / preview / upload_preview，target 仅 dev；**没有把 experience 参数传给 SDK**。体验版本由管理员在公众平台手动选择，控制台 / 文档明示。组合任务的上传可能在预览失败前完成，超时也可能已到达微信，平台不承诺恰好一次或自动回滚微信版本。
6. SDK 只在可信容器入口动态加载，不在 API 或 Worker 编排进程中调用。屏蔽原始诊断，进度只输出固定文字并节流；B14 脱敏在分块前再次应用于输出和秘密的行 / JSON 变体，64 KiB 日志预算、16 KiB 单块。日志持久化先于终态，SSE 使用一次性 60 秒票据、序号续传、终态 high-water、权限重验、连接限制与慢连接关闭。控制台文本渲染并复用 ANSI 清理逻辑。
7. QR 只接受至多 1 MiB 的 JPEG，从容器停止后的目录复制到独立 ArtifactStore 目录，仅发布 qrcode.jpg。成功任务保存内部制品 key；API 不暴露 key，需项目授权下载，no-store / nosniff。控制台通过授权 fetch 转临时 Blob URL，切换 / 退出时释放。不复用 B11 的公开静态预览域或令牌，因为二维码属于项目成员可见的任务制品。二维码期限由微信决定，不推测有效时间，不自动刷新。
8. 权限复用 deploy:read / manage / run：已验证 owner/editor 配置与执行，viewer 读元数据 / 日志 / QR，本机模式拒绝。写入复用身份限流表独立 weapp-write 配额。API 只负责控制与持久化，外部服务知识留在 Worker 适配器。CLI 不新增并行实现，API / 控制台为本期入口。

## 依赖评估与取舍

B17 P1 修正：上传私钥经 Docker stdin 单次传入，可信入口在加载 SDK 前完整读尽管道，仅通过 SDK 的 `privateKey` 内存参数使用；不写入输入目录、项目目录、参数或环境变量，避免 source map 越界文件读取把密钥嵌入制品。保留 source map，不能依赖删除现有 map 阻止编译期生成。容器工作目录固定 `/tmp` tmpfs，让 SDK 的相对路径编译缓存可写，同时保留只读根与原有隔离。

固定 `miniprogram-ci@2.1.31`（MIT，声明 Node >=16.1，平台采用 Node 22），使用官方持续集成 SDK，避免维护私有签名、包上传协议或安装完整 GUI 开发工具。版本与传递依赖锁定在 pnpm-lock.yaml，升级需重跑 SDK mock 契约、隔离参数、构建、数据库与真实账号人工验收。本次 `pnpm audit --prod` 报告整个生产依赖图 63 项告警（6 critical、28 high、24 moderate、5 low），包含已有 Drizzle 告警及 SDK 引入的旧编译 / 网络 / 解包依赖。例如 [form-data 随机边界](https://github.com/advisories/GHSA-fjxv-7rqg-78g4)、[Babel 编译恶意代码](https://github.com/advisories/GHSA-67hx-6x53-jw92)、[decompress 路径穿越](https://github.com/advisories/GHSA-hrh2-vp3x-79xf)。官方 SDK 的依赖约束和内置编译器使全局强制升级不能证明兼容性，本次不以无验证的 overrides 掩盖风险；真实账号使用前必须完成镜像安全评估与人工验收。SDK 有大量旧版编译 / 网络传递依赖和弃用包，不能视为零风险；不为它放开宿主权限或全局安装脚本，生产需扫描可信镜像并维护升级。SDK 仅 worker 依赖，替换成本限制在容器入口 / Runner 适配器，数据模型和 UI 不依赖 SDK 类型。

代价是多一个镜像、专用出口策略和人工微信配置。仅创建 Docker 网络不代表生产白名单已落实；部署者负责阻断控制面 / 内网 / 元数据并核实上传出口 IP，平台不自动获取或设置微信白名单。API 不探测消费者在线状态，未启动消费者的 queued 任务可能持续等待。

## 验证、限制与回退

单元与 HTTP / 组件测试使用合成 AppID、运行时临时测试密钥和 SDK / Docker mock，不请求微信。覆盖配置只写 / 脱敏 / 授权、目标与状态前置条件、上传与预览参数、Worker 成败 / 中断 / 密钥清零、不重放有歧义任务、制品摘要与 QR 私有读取、SSE 终态日志。CI 另构建生产镜像与 offline mock SDK 测试 target，在真实 Docker internal 网络验证可信入口、非 root / 只读挂载 / 平台凭证隔离、成功 / 失败和清理；该测试沿用 B09 的 opt-in 开关，本机无 Docker 时不启用。MySQL opt-in 测试验证配置保留 / 替换、项目约束、并发串行与审计事务，由现有 mysql-integration 命令执行。

无真实 AppID / 私钥 / 真机 / 白名单时不能宣称已完成微信服务端与设备验收。支付宝小程序上传 / 预览作为下一步；正式发布、审核、App 签名不在本期。QR / 日志保留期自动清理、跨项目共用 AppID 的全局互斥、主加密密钥轮换迁移均留待后续。

迁移 0015 为增量变更，旧构建默认 H5，不引入超出 2038 范围的哨兵时间。回退前停止入口及消费者，核对在途外部副作用，保留数据与审计、回退应用并优先前向修复，不自动反向 DDL。完整配置、真实账号 / 真机步骤、错误处置和翻译状态见 [用户指南](../zh-CN/weapp-upload.md)。
