# 微信小程序上传与预览（B17）

本功能面向 `uniapp` 模板项目：选择成功的 `mp-weixin` 构建制品，用官方 `miniprogram-ci` 上传开发版本、生成预览二维码，或执行两项操作。支付宝小程序上传与预览是下一步，不在本期范围内；也不包含微信审核、正式发布、App 打包。

**开发版本与体验版本不同。** 官方 CI 的 `upload` 上传开发版本，`preview` 生成预览二维码，没有直接指定体验版本的参数。需要体验版本时，上传后由管理员在微信公众平台的版本管理中手动选择；平台不会把上传成功报告为体验版已生效。实现边界见 [ADR-0016](../adr/0016-weapp-upload-preview.md)。

## 账号与真机准备

1. 登录[微信公众平台](https://mp.weixin.qq.com/)，使用具有相应权限的小程序管理账号。进入「开发管理 / 开发设置」（后台菜单名称可能调整），找到 AppID。
2. 在「小程序代码上传」相关设置中生成并下载上传私钥。妥善保管下载的 PEM 文件，**不要提交到 Git、粘贴到日志或通过截图传播**。不使用 AppSecret 代替上传私钥。
3. 向部署人员确认 **上传容器访问公网时的实际出口 IP**，包括 NAT、代理及多节点出口。在微信后台配置代码上传 IP 白名单。平台不自动探测出口 IP，也不调用微信管理 API 修改白名单。
4. 项目还需配置合法请求域名、业务权限和测试人员 / 体验成员。预览成功不等于这些设置正确，也不等于已完成真机验收。
5. 在已登录相应微信账号的真机扫码，检查首页、tabBar、列表搜索、详情返回、API 请求、权限与异常提示；需要体验版时另在公众平台手动选择并用体验成员验证。

官方操作与接口参考：[miniprogram-ci 说明](https://github.com/wechat-miniprogram/miniprogram-ci-dist)。本地与 CI 测试使用 SDK mock、合成 AppID 与临时测试密钥，从不访问微信；真实账号、真机和公网白名单需要部署后人工验收。

## 控制台操作

进入 uniapp 项目详情 →「微信上传与预览」。owner / editor 可配置与创建任务，viewer 可查看配置元数据、状态、日志和二维码；本机匿名模式不能使用这些接口。

1. 填写 AppID、粘贴完整 RSA PEM 上传私钥，可填写 IP 白名单备注。备注是供操作人员阅读的普通文本，不是自动设置，也不用于保存密钥。
2. 保存后页面只显示「已配置（仅可替换）」。API 不返回私钥或密文。留空私钥可修改同一 AppID 的备注；首次配置或更换 AppID 必须提供新私钥。「删除配置与私钥」删除加密值，不删除历史任务。
3. 点击「创建微信构建」，或在构建页使用 `template:uniapp` 并选择「微信小程序」。构建在 B09 Docker Runner 内执行 `build:mp-weixin`，输出 `dist/build/mp-weixin`。默认 H5 构建不能用于此功能。
4. 构建成功后返回上传页并刷新，或点击构建详情的「微信上传与预览」。选择最近 100 次构建中的成功微信制品，填写版本号、描述和机器人序号（1–30，默认 1）。版本号允许字母、数字、点、下划线、短横线，最多 64 字符。
5. 选择「上传开发版并生成预览」「仅上传开发版」或「仅生成预览」，创建任务。每个项目同时允许一个 queued / running 任务；更换机器人不会绕过此限制。
6. 点击任务记录查看 queued / running / succeeded / failed、创建 / 开始 / 结束时间、固定错误摘要和实时日志。预览成功后二维码通过需登录授权的 API 读取并显示，不能当作公开静态资源分享。

保存配置对之后启动的任务生效。任务记录固定 AppID；执行时读取当前密钥，如果配置已删除或 AppID 改变则失败。同 AppID 的密钥轮换会使用新密钥。上传和预览分两次 SDK 调用，第二步失败时第一步可能已完成。超时、网络中断或 Worker 丢失均需先核对微信后台，再决定是否创建新任务；平台不自动重复有歧义的上传。

二维码有效性由微信控制，平台不承诺固定有效期、不自动刷新，也不保存一个推测的有效截止时间。过期后重新发起预览。二维码对应的预览与公众平台体验版本分别管理。

## 部署与隔离要求

先按 [Docker Runner 指南](./docker-build-runner.md) 部署非 root 的 Worker、MySQL、Redis 和私有制品目录，并应用迁移：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @forgekit/db db:migrate
corepack pnpm build
# 在仓库根目录预构建可信上传镜像；正式环境扫描后固定 digest。
docker build -f infra/weapp/Dockerfile -t forgekit-weapp:b17 .
```

沿用 B14 的 `FORGEKIT_DEPLOY_ENCRYPTION_KEY`（32 字节、64 位十六进制），由秘密配置系统向 API 与 Worker 提供；不写入仓库。API 只加密，Worker 在上传前解密。丢失或更换此密钥会影响已有 B12/B14/B17 密文；本期不提供自动密钥迁移。

| 配置 | 进程 | 用途 |
| --- | --- | --- |
| `DATABASE_URL`、`REDIS_URL` | API / Worker | 既有数据库与队列 |
| `FORGEKIT_DEPLOY_ENCRYPTION_KEY` | API / Worker | B14 风格 AES-256-GCM 加密 |
| `FORGEKIT_ARTIFACT_DIR` | API / Worker | 相同私有制品存储，绝对路径；API 需能读取 QR |
| `FORGEKIT_BUILD_RUNNER=docker` 与既有构建配置 | Worker | 生成真实 mp-weixin 制品；noop 不生成制品 |
| `FORGEKIT_WEAPP_IMAGE` | Worker | 预先安装 CI SDK 的可信镜像，建议固定 digest；不设置时上传消费者禁用 |
| `FORGEKIT_WEAPP_NETWORK` | Worker | 独立的 Docker 出口网络名，必填，不允许 host / bridge / default / none |
| `FORGEKIT_BUILD_WORKSPACE_DIR` | Worker | 可选绝对路径，上传步骤也在此建立私有临时目录 |

`docker network create` 本身不构成生产网络隔离。部署人员必须在专用执行主机配置出口防火墙 / 网关，仅放行 SDK 所需微信公网服务（包括实际上传所用的存储端点），阻断宿主、控制面、内网与元数据地址，禁止绕过出口策略；用实际环境验证。其出口 IP 必须加入微信白名单。本期不内置微信域名列表或自动维护代理规则。

独立上传容器沿用 B09 的非 root、只读根、cap-drop、禁止提权、默认 seccomp、CPU / 内存 / PID / 日志限制，不执行 npm 安装或项目脚本。输入目录只读；SDK 在 `/tmp` tmpfs 处理副本，工作目录也设为 `/tmp`，供 SDK 写入相对路径编译缓存；输出目录可写。私钥经 stdin 单次传入，入口在加载 SDK 前读尽管道，仅作为 SDK 内存参数使用，不落盘、不进入参数或环境变量，防止 source map 越界读取私钥。容器只获得本次项目私钥，不获得数据库、Redis 或主加密密钥。300 秒容器内期限、330 秒处理器期限及清理期限约束执行；正常结束、失败、超时和停机都先 kill / rm 容器，再删除工作目录。

无法确认容器删除时保留私有目录，避免仍在运行的进程造成路径竞态；需在执行主机恢复后核对本次容器、停掉容器并清理目录。Worker 遭 SIGKILL / 宿主断电后的残留也需人工清理。日志脱敏是补充防线，不能替代容器与出口隔离。

API 不探测上传消费者在线状态。未启动消费者时任务可能保持排队；上线前检查 Worker 的 `weapp_worker_ready` 事件、镜像、Docker 与网络策略。数据库 / Redis 入队间隙沿用 B08 的 30 秒心跳补偿；过期 running 任务标记失败并提示核对微信后台，不重复执行。

## API

均以 `/api/v1/projects/:projectUUID/weapp` 为前缀，使用既有 OIDC Bearer 身份与项目授权。

| 方法与路径 | 用途 |
| --- | --- |
| GET / PUT / DELETE `config` | 读取安全元数据、保存 / 替换、删除配置 |
| POST `jobs` | `{buildId, action, target:"dev", version, description, robot}` |
| GET `jobs` / `jobs/:jobId` | 最近 100 条任务 / 详情 |
| GET `jobs/:jobId/logs?seq=0&limit=500` | 按单调序号续读日志 |
| POST `jobs/:jobId/log-stream-ticket` | 签发一次性、60 秒 SSE 凭证 |
| GET `jobs/:jobId/logs/stream?ticket=…&after=0` | B10 风格 SSE，定期重验权限与有界背压 |
| GET `jobs/:jobId/qr` | 已成功任务的 JPEG 二维码，no-store，需项目成员身份 |

首次配置缺密钥、跨项目 / 未成功 / H5 / 无制品构建、已有活跃任务返回 409；不支持的 target（如 experience）或输入格式错误返回 400。权限按既有 401 / 403 / 404 处理。底层数据库、SDK、加密错误不原样返回。

## 故障排查与验证

失败摘要只暴露平台固定代码，避免微信 SDK 错误携带凭证。依次检查：AppID 与密钥是否对应、是否已轮换密钥、实际出口 IP 与白名单是否一致、镜像是否预构建、Docker / 网络策略是否可用。SDK 原始诊断不进入日志；日志只报告受控进度，合计最多 64 KiB，仍保留 B14 已知秘密和通用凭证脱敏。

```bash
corepack pnpm typecheck
corepack pnpm db:migrations:check
corepack pnpm test
corepack pnpm build
# 仅对已配置的可丢弃 MySQL 测试库；CI mysql-integration 包含此测试。
FORGEKIT_DB_INTEGRATION=1 corepack pnpm db:test:integration
```

单元 / HTTP / 组件测试 mock SDK 和 Docker，覆盖只写加密、权限、构建前置条件、状态、密钥清零、日志与 QR 制品读取；MySQL 测试验证事务、并发、项目范围、日志序号与审计。CI 的 docker-runner-integration 会构建可信上传镜像和仅测试用 SDK mock 镜像，在 internal 网络上验证真实容器挂载、权限、成功 / 失败、QR 和清理，不调用微信。已有 Docker 集成测试仍由 CI 独立任务运行；没有 Docker 的本机不执行这些既有 opt-in 测试。没有使用真实微信账号作为 CI 门禁。

## 数据与回退

`0015_b17_weapp_upload.sql` 增加 builds.target（旧记录默认 h5）、weapp_configs、weapp_jobs、weapp_log_chunks 和不含配置内容 / 密文的 weapp_audit。所有时间均为当前运行时间，不使用超出 MySQL TIMESTAMP 范围的哨兵值。密钥 AAD 绑定项目及 B17 用途，不能互换到 B12/B14。

回退前停止入口与上传消费者，等待 / 核对在途上传，保留配置、任务、审计与制品，回退应用并前向修复。不要直接删除仍有引用的构建或 QR 目录。本期不实现 QR / 日志保留期自动 GC，需与数据库对账清理；删除配置可撤销之后任务使用本地私钥，但不会撤销微信后台已有版本。

中文为当前权威，英文对应指南尚未翻译；对外发布前需补齐并检查翻译状态。
