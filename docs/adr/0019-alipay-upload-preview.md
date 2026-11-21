# ADR-0019：支付宝小程序上传与预览

- 状态：Accepted（B20）
- 日期：2026-11-22
- English title: Alipay mini-program upload and preview

## 背景与决策

[B16](./0015-uniapp-template.md) 预置了 `mp-alipay` 编译脚本，[B17](./0016-weapp-upload-preview.md) 已建立微信上传 / 预览链路。B20 在成功的支付宝制品与支付宝开放平台之间补充任务、只写凭证、隔离上传和私有二维码读取。已阅读并整合外部草稿的配置、任务与账号准备结构；最终包名、接口、体验版能力及安全限制以发布包核实结果和本实现为准。

1. builds.target 增加 mp-alipay，保持旧记录默认 h5 及 mp-weixin 路径。仅 uniapp 接受小程序目标；固定执行 `build:mp-alipay`，输出 `dist/build/mp-alipay`，要求 app.js / app.json / mini.project.json。上传入队与执行都要求同项目、uniapp、mp-alipay、succeeded 和完整制品 key / SHA-256；没有任意本地目录或源码上传入口。
2. 每项目一个 alipay_configs，AppID / toolId 可读，私钥只写。复用 B14 的 AES-256-GCM 格式和主密钥，以 `b20:<projectUUID>` AAD 隔离 B12 / B14 / B17 / B18 与其他项目。接受至少 2048 位、无口令的 RSA PEM，内存规范化为 SDK 需要的 PKCS8 后加密。首次配置、更换 AppID 或 toolId 必须提供新私钥。显式白名单序列化，API 不回传密文；审计只记录动作、操作人、项目和任务，错误固定文本，不原样记录驱动 / SDK 异常。
3. 新增独立 alipay_jobs / alipay_log_chunks / alipay_audit 与 `alipay` BullMQ 队列；消息只有 jobId。项目行锁串行化配置和创建，每项目最多一个 queued / running 任务。任务记录 AppID / toolId / 操作 / 版本，执行前读取当前私钥并重验两个标识；不保存秘密快照。标识不变时轮换密钥对之后启动的任务生效。数据库事务写任务 / 审计再入队，30 秒补投递、Redis jobId 去重、CAS 沿用 B08。有外部副作用的 running 任务不重新执行，390 秒后缺少有效队列任务则失败，要求人工核对开放平台。
4. 通过 Worker 内 `AlipayRunner` 能力接口运行**独立可信 Docker 步骤**，API 和 Worker 编排进程不加载 SDK。复用 B09 DockerCli / ArtifactStore、B10 有界日志及 B14 脱敏。将 B17 的有界制品复制、路径校验、文件数 / 大小限制及清单摘要校验抽到 mini-program-artifact，微信保留原有 materializeWeapp 包装入口与错误码。支付宝的 toolId、体验版、SDK 参数及二维码下载保留在适配器，避免给微信模型增加分支。
5. 上传容器非 root、只读根、cap-drop、禁止提权、默认 seccomp、无 Docker socket / 控制面凭证，CPU / 内存 / PID / 文件描述符 / core 限制及 log-driver=none。输入只读、输出可写、`/tmp` 768 MiB tmpfs；不执行项目安装脚本，不加载项目 plugins / node_modules。复制制品后覆盖 mini.project.json 和 CLI 配置，编译器来自预构建可信镜像。300 秒容器期限 + 330 秒 Worker 期限；确认容器删除后才读取 QR / 清理工作目录，无法确认时保留目录供运维恢复。宿主共享内核与网络出口隔离要求沿用 ADR-0009。
6. **私钥只经 Docker stdin 单次传入，入口在加载 SDK / 编译器前读尽管道。** 使用 `minidev.config.useRuntime({'alipay.authentication': {toolId, privateKey}})`，不使用 login、持久化 config.set、identityKeyPath、私钥路径、环境变量或密钥文件；即使 tmpfs 也不写私钥。官方该版本的 useRuntime 实现只修改内存 BaseConfig。只将应用元数据写入 job.json；source map 文件读取不能取得一个上传私钥文件。SDK 全部原始 stdout / stderr 诊断被屏蔽，只输出可信固定阶段文本；退出前清空 runtime 授权，Worker finally 清零解密 Buffer。
7. 官方 `upload({appId, project, clientType:'alipay', version, versionDescription, experience})` 支持上传后设置体验版，**有账号权限要求**；默认 dev，experience 时显式传 true。与微信不同，不声称必须手动切换。体验版目标还要求 SDK 返回 experienceQrCodeUrl 作为成功确认；设置失败或缺少确认会使任务失败，不报告体验版成功；上传可能已经完成，需要先在开放平台版本管理核对，必要时手动设置。`preview({appId, project, ...})` 返回 qrcodeUrl / version；它与体验版码分别管理。版本限制按 SDK 的 x.y.z / 每段 int32 上限，描述少于 200 字符；不自动删除版本或递增。仅预览不修改体验版。三种 action 为 upload / preview / upload_preview，无审核或正式发布 API。
8. 官方返回的预览 URL 仅在可信上传容器下载：HTTPS、alipay.com / alipayobjects.com 及子域、无凭证 / 自定义端口 / 重定向、15 秒期限、1 MiB 上限，接受 PNG / JPEG 签名，拒绝 HTML / SVG。停止容器后 Runner 再次验证，仅发布 qrcode.img 到独立私有制品目录，内部 key 不进入公共任务响应。API 每次鉴权，no-store / nosniff 并校验图片；控制台授权 fetch 后创建 Blob URL，切换 / 退出释放。不复用 B11 公开静态预览链接。不推测二维码有效截止时间。
9. 项目授权复用 deploy:read / manage / run；owner / editor 写入及执行，viewer 读取元数据 / 日志 / QR，本机模式拒绝。独立 alipay-write 限流。64 KiB 日志预算、16 KiB 单块，B14 秘密的完整 / 换行 / JSON 变体脱敏先于存储和流式输出；终态之前持久化日志。沿用 B17 一次性 60 秒 SSE 票据、序号续传、权限重验、high-water 终态、连接限制和慢连接关闭。控制台 Element Plus 页面按现有项目路由、授权和日志文本渲染模式接入。

## 官方包与依赖评估

2026-11-22 核实 [npm registry](https://registry.npmjs.org/minidev) 的 latest 为 **minidev 2.2.5**（2025-02-27 发布，维护者含 `minicode-group` / `minicode@alibaba-inc.com`），`@alipay/minidev` registry 返回 404。发布包 README 指向[支付宝 CLI 官方指南](https://opendocs.alipay.com/mini/02q17h)，[官方工具入口](https://open.alipay.com/tool)列出上传、预览与体验码能力。检查 [2.2.5 发布 tarball](https://registry.npmjs.org/minidev/-/minidev-2.2.5.tgz) 的 index.d.ts 和 lib/index.js，确认 runtime 内存授权、upload 的 experience、versionDescription、preview 返回 qrcodeUrl，以及描述 / 版本约束；不采用第三方包装器、不自写支付宝签名和上传协议。

精确版本只加入 Worker，传递依赖锁定 pnpm-lock.yaml；不允许 API 使用 SDK 类型或协议。Node 22 可信镜像提前运行官方 `download-assets --with-compiler`；固定 `compiler.version.cube=0.100.12` 和 skipLatestCheck，运行时复制预下载缓存到 tmpfs，避免随 SDK 的远端 latest 调度切换编译器。资源及编译器属于额外下载供应链，部署者需扫描并固定完整镜像 digest；不能只锁 npm 包就宣称所有远端资源均有仓库内校验。

维护与许可存在限制：该稳定版本距核实日期已有较长间隔，依赖包含已弃用的 request / request-promise-native、superagent、tar 等旧链路。**npm 元数据没有 license 字段，发布包也没有顶层 LICENSE；捆绑的 LICENSE.txt 是第三方代码声明，不能据此推断 minidev 自身使用 ISC / MIT。** 生产分发前需确认支付宝 SDK / 下载编译器的使用许可与镜像安全，不将它们重新许可为本仓库 Apache-2.0。本次 `pnpm audit --prod` 报告整个生产依赖图 77 项告警（7 critical、37 high、27 moderate、6 low），包含既有依赖及新 SDK 链路，不能将总数全归因于 B20。未强制 override 上游依赖，以免无验证地破坏上传协议。替换成本限制在容器入口 / Runner，数据模型与 UI 不耦合 SDK 类型。

代价是独立镜像、额外编译器资源与出口策略。专用 Docker 网络名不能证明生产隔离，部署人员须阻断内网 / 元数据 / 控制面并验证实际出口；支付宝工具若启用 IP 白名单，人工配置该出口 IP，不套用微信菜单或声称全账号强制要求。AppID / toolId / 工具公钥 / 开发与体验版权限仍需用户在开放平台准备。

## 验证、限制与回退

单元、HTTP、组件测试使用官方 SDK / Docker / QR 下载 mock、合成标识及运行时生成测试密钥，不请求支付宝。覆盖配置加密 / 只写 / 规范化 / 脱敏、跨用途隔离、错误状态与构建目标、项目授权、Worker 成败 / 中断 / 不重放、私钥不在挂载文件或 source map 中、二维码存储和私有读取、SSE 票据与终态。微信回归保留；原 B17 “未知构建目标”测试改用仍不支持的 mp-baidu，因为 mp-alipay 已成为合法构建目标。

已有 template-smoke 复用 uniapp 安装增加无凭证支付宝编译，不另建慢作业。Docker opt-in fixture 使用 internal 网络、mock SDK 和 mock QR 响应，检查 stdin 已耗尽、非 root / 只读根 / 无平台凭证、SDK 原始输出拦截、文件树无密钥、成功 / 失败与清理；缺少 Docker 时跳过。新增 MySQL opt-in 测试加入既有集成命令，验证配置替换约束、构建前置条件、事务审计、并发互斥和日志顺序。

本次 `pnpm typecheck`、`pnpm db:migrations:check`、`pnpm test`（875 通过、32 项 opt-in 跳过）、`pnpm build` 均通过；另在临时目录真实生成 / 安装 uniapp 并通过 `build:mp-alipay`，确认所需制品与 AXML。当前执行会话无 Docker 命令，sudo 受 no-new-privileges 限制，未进行真实容器 / MySQL 验收；没有真实支付宝账号 / 设备验收。外部草稿中未证实的包名、笼统体验版占位与微信式 IP 要求均不作为交付事实。生产前仍需许可、安全扫描、镜像预下载 / tmpfs 容量、真实账号上传 / 体验版权限 / QR 扫码验收。日志 / QR 保留期、跨项目同 AppID 互斥和主密钥轮换迁移为后续。

迁移 0017 新增四表并扩展 builds.target，不引入 2038 之后的时间哨兵。回退前停用入口与消费者、核对在途外部副作用，保留审计和历史数据，回退应用并优先前向修复；不自动反向 DDL，不尝试回滚支付宝已接收的版本。用户操作、故障处置、部署与翻译状态见[支付宝上传指南](../zh-CN/alipay-upload.md)。
