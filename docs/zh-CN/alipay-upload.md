# 支付宝小程序上传与预览（B20）

本功能面向 `uniapp` 模板项目：选择成功的 `mp-alipay` 构建制品，使用支付宝官方 **`minidev@2.2.5`** 上传开发版本、上传后设置为体验版，或生成真机预览二维码。API / 控制台是本期入口，不包含提审、正式发布、支付接入或 iOS 打包。实现边界见 [ADR-0019](../adr/0019-alipay-upload-preview.md)，微信路径见 [微信上传指南](./weapp-upload.md)。

官方 SDK 的 `upload({ experience: true })` 支持上传后设置体验版，**需要对应账号权限**。默认只上传开发版本；勾选体验版也不代表审核或正式发布。`preview()` 生成的预览码与开放平台的体验版码分别管理。本平台展示预览码，不把它标为体验版码。

## 账号与真机准备

1. 登录[支付宝开放平台](https://open.alipay.com/)，在控制台进入对应的**小程序应用**，复制 16 位数字 AppID。操作账号需具备该小程序的开发 / 上传权限；设置体验版还需相应权限。不要使用微信 AppID、PID 或 toolId 代替 AppID。
2. 进入[工具密钥管理](https://open.alipay.com/dev/workspace/key-manage/tool)，按当前页面创建 / 查看工具并复制 **toolId**。这是工具授权标识，与小程序 AppID 分开保存。此入口需要登录，不是微信「代码上传密钥」菜单。
3. 使用支付宝官方[密钥工具](https://opendocs.alipay.com/common/02kipl)生成 RSA2（2048 位）密钥对，将**公钥**配置到上述工具密钥管理中，保留对应的**私钥**用于平台上传。此处是工具密钥，不是支付业务的应用加签配置，也不是「支付宝公钥」。指南及格式以[官方 CLI 授权说明](https://opendocs.alipay.com/mini/02q29w)和账号当前页面为准。
4. 将完整、无口令的 RSA PEM 私钥粘贴到 YKForgeKit 配置。推荐 PKCS8（`BEGIN PRIVATE KEY`）；平台也接受 RSA PKCS1 PEM，并在内存中转换为 PKCS8。密钥工具若显示无头尾的文本，先使用工具导出 / 转换为完整 PEM。**不要将私钥提交到 Git、放进 manifest、环境变量构建配置、日志、截图或聊天消息。** 公钥不能代替私钥。
5. 若工具密钥启用了 IP 白名单，请向部署人员确认上传执行主机经过 NAT / 代理后的**实际出口 IP**，按工具管理页面配置。B20 不要求套用微信的强制上传白名单，不自动探测或修改支付宝配置；是否开启、允许范围和账号权限由开放平台决定。
6. 在小程序设置中完成合法请求域名、业务权限及测试 / 体验成员配置。用具有相应权限的支付宝账号扫码验收首页、tabBar、列表、详情、接口请求和异常反馈。编译或上传成功不能代替真机验收。

官方入口：[支付宝开发工具](https://open.alipay.com/tool)、[CLI 指南](https://opendocs.alipay.com/mini/02q17h)、[指令列表](https://opendocs.alipay.com/mini/02q29z)。包和接口核实依据为 [npm 包](https://www.npmjs.com/package/minidev/v/2.2.5)及其发布包中的 `README.md`、`index.d.ts` 和实现；不使用第三方上传包装器。

## 控制台操作

进入 uniapp 项目详情 →「支付宝上传与预览」。owner / editor 可配置并执行，viewer 可读配置元数据、任务、日志和二维码；本机匿名模式不能使用。

1. 填写 AppID、toolId 和上传私钥并保存。之后只显示「已配置（仅可替换）」，API 不返回明文或密文。私钥留空保留当前值；首次配置、更换 AppID 或 toolId 必须提供新私钥。删除配置会删除加密值，保留历史任务。
2. 点击「创建支付宝构建」，或在构建页使用 `template:uniapp` 并选择「支付宝小程序」。B09 Runner 执行固定的 `build:mp-alipay`，输出 `dist/build/mp-alipay`；H5、微信制品均不能用于支付宝上传。
3. 成功后回到上传页刷新，从最近 100 次构建中选择成功的支付宝制品。版本必须是三段数字，例如 `1.0.0`，各段无多余前导零、每段不超过 2147483647；描述少于 200 个字符。版本号用于上传，预览的版本标识由官方生成。上传版本还需满足开放平台的远端版本约束，平台不自动递增或删除旧版本。
4. 选择「上传并生成预览」「仅上传」或「仅生成预览」。上传目标可选择开发版或「上传并设置体验版（需权限）」；仅预览时固定开发目标，不修改体验版。每项目同时允许一个 queued / running 任务。
5. 在任务记录中打开详情，查看 queued / running / succeeded / failed、创建 / 开始 / 结束时间、错误码和实时日志。日志断线可重连并按序号补读。预览成功后显示需登录授权读取的二维码，使用支付宝扫码；二维码不是公开静态链接。

任务固定 AppID 与 toolId，启动时读取当前私钥。配置删除或任一标识改变会失败；标识不变时轮换私钥会使之后启动的任务使用新私钥。任务中不保存私钥快照，队列消息只有 jobId。

上传、设置体验版、生成预览不是一个跨系统事务。设置体验版或预览失败之前，开发版本可能已经上传；超时 / 中断也可能发生在服务端完成之后。**先在支付宝开放平台对应小程序的版本管理中核对版本和体验版状态，再决定是否重建任务或手动设置体验版。** 本平台不会将失败伪装为体验版生效，也不自动重复不确定的上传。审核与发布始终由账号管理人员按官方流程处理。

二维码时效由支付宝控制，平台不承诺固定有效期、不自动刷新。过期后创建新的预览任务；体验版码请在开放平台查看。

## 部署与隔离要求

先按 [Docker Runner 指南](./docker-build-runner.md)准备非 root Worker、MySQL、Redis 和私有制品目录：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @forgekit/db db:migrate
corepack pnpm build
# 构建可信镜像时下载官方编译器 / 资源；不提供任何账号密钥。
docker build --target final -f infra/alipay/Dockerfile -t forgekit-alipay:b20 .
```

生产镜像固定 npm SDK，并预下载固定 `cube 0.100.12` 编译器及官方资源；部署者需扫描并固定镜像 digest，验证下载完整性和资源大小。编译器不开启运行时 latest 检查。镜像构建与真实容器路径尚需在可用 Docker 主机验收；不把单元 mock 结果视为 SDK 服务端验收。

| 配置 | 进程 | 用途 |
| --- | --- | --- |
| `DATABASE_URL`、`REDIS_URL` | API / Worker | 既有数据库与队列 |
| `FORGEKIT_DEPLOY_ENCRYPTION_KEY` | API / Worker | B14 风格 AES-256-GCM 主密钥，32 字节 / 64 位十六进制 |
| `FORGEKIT_ARTIFACT_DIR` | API / Worker | 相同的私有制品存储绝对路径 |
| `FORGEKIT_BUILD_RUNNER=docker` | Worker | 生成真实构建制品；noop 不能生成制品 |
| `FORGEKIT_ALIPAY_IMAGE` | Worker | 可信支付宝镜像；未设置时不启动上传消费者 |
| `FORGEKIT_ALIPAY_NETWORK` | Worker | 专用出口网络名，必填；拒绝 host / bridge / default / none |
| `FORGEKIT_BUILD_WORKSPACE_DIR` | Worker | 可选绝对路径，存放本次隔离输入 / 输出目录 |

主密钥由部署秘密系统注入 API / Worker，不能提供给构建或上传容器。丢失或替换会影响原有 B12 / B14 / B17 / B18 及本期密文；没有自动密钥迁移。

上传使用独立容器，不在 API 进程运行 CLI，也不将私钥交给项目安装 / 构建脚本。容器非 root、只读根、cap-drop、禁止提权、默认 seccomp、资源限制、log-driver=none；工作目录是 `/tmp`，使用 768 MiB tmpfs。仅挂载本次只读输入和可写输出，不挂载 Docker socket 或平台凭证。

**私钥仅通过 stdin 单次传入，入口在加载 SDK 前读尽管道，然后调用内存 `config.useRuntime`；不使用 login、config.set、identityKeyPath、环境变量或临时密钥文件，即使 tmpfs 内也不写私钥。** 输入和上传项目目录没有密钥；source map 的文件读取不能取得一个密钥文件。可信入口替换项目 CLI 配置，关闭原始 SDK 诊断，只输出固定步骤文字，Worker 在存储及 SSE 之前再次脱敏。

`docker network create` 不能替代出口策略。部署者应在专用执行主机放行 SDK 所需的支付宝公网服务 / 上传存储 / 官方资源及二维码 CDN，阻断控制面、宿主、内网与元数据地址，验证实际网络策略。QR 下载仅接受 HTTPS 的 `alipay.com` / `alipayobjects.com` 及其子域，不接受重定向、凭证 URL 或任意地址；仅保存至多 1 MiB 的 PNG / JPEG。若官方改变 QR 域名，需经过适配器变更，不能临时关闭校验。

容器内期限 300 秒，Worker 期限 330 秒；先确认 kill / rm 完成才读取输出或删除工作目录。无法确认删除时保留私有目录供运维核对；宿主断电 / SIGKILL 的残留需人工恢复。二维码和日志保留期自动清理留待后续。

API 不探测消费者是否在线。上线前确认 `alipay_worker_ready`、镜像、专用网络和制品目录。queued 任务每 30 秒补投递；running 丢失且超过 390 秒时标记失败，不重放上传。未启用消费者时任务可能持续排队。

## API

均以 `/api/v1/projects/:projectUUID/alipay` 为前缀，复用 OIDC Bearer、项目 deploy:read / manage / run 授权和独立写入限流。

| 方法与路径 | 用途 |
| --- | --- |
| GET / PUT / DELETE `config` | 读取安全元数据、保存 / 替换 / 删除配置 |
| POST `jobs` | `{buildId, action, target, version, description}`；action 为 upload / preview / upload_preview，target 默认为 dev，可选 experience |
| GET `jobs` / `jobs/:jobId` | 最近 100 条记录 / 详情 |
| GET `jobs/:jobId/logs?seq=0&limit=500` | 按序号读取持久化脱敏日志 |
| POST `jobs/:jobId/log-stream-ticket` | 签发 60 秒、一次性且绑定项目 / 任务的 SSE 票据 |
| GET `jobs/:jobId/logs/stream?ticket=…&after=0` | 续传日志、状态及终态；不把 Bearer 放在 URL |
| GET `jobs/:jobId/qr` | 授权读取私有 PNG / JPEG，no-store / nosniff |

非 uniapp 返回 400；缺少配置、非成功 / 非同项目 / 非 mp-alipay / 无完整制品或项目已有活动任务返回 409；无权限返回 403 或不暴露项目的 404。服务未配置 / 入队失败返回 503。接口不回显底层 SDK / SQL / 加密异常。任务错误摘要为固定码，例如 `alipay_execution_failed`、`alipay_timeout_or_shutdown`、`alipay_worker_lost_check_platform`。

## 验证与限制

自动化使用合成 AppID / toolId、运行时生成的测试密钥、官方 SDK mock、二维码响应 mock 和 Docker mock；不请求支付宝。覆盖加密只写、跨项目 / 跨用途隔离、构建前置条件、授权、Worker 成败 / 中断、日志脱敏与 SSE、私有 QR、密钥不落盘与 source map 回归。真实 Docker fixture 使用 internal 网络和 mock SDK，缺少 Docker 时跳过；MySQL 测试沿用 opt-in CI 数据库。

template-smoke 在已有 uniapp 安装之后增加无凭证的 `build:mp-alipay`，验证 app.json / app.js / mini.project.json 和 AXML，不新增独立慢任务。真实账号上传、体验版权限及真机扫码仍需部署后验收。

当前中文指南为权威；英文对应文档尚未翻译，对外发布前必须补齐并检查同步状态。
