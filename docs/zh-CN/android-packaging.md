# Android APK / AAB 打包（B18）

B18 提供项目配置、签名替换、排队打包、实时日志和私有制品下载。使用 uni-app 的 App 资源及官方离线 Android SDK，在自己的 Docker 执行机上运行 Gradle 和签名工具，不调用 DCloud 云打包。

**当前边界**：与 B09 一致，平台从已登记的 uniapp 模板及项目参数重新生成工程，不读取你本地修改的源文件。尚无 Git / 上传源码快照入口。真实 SDK、AppKey 与真机链路尚待部署者验收；单元测试通过不等于已完成真实 Android 打包。iOS 不在本期范围，后续单独设计。

## 部署准备

需要 MySQL 8、Redis 7、OIDC 项目成员身份、非 root Worker 和独立 Docker 执行机。先按 [Docker Runner 指南](./docker-build-runner.md) 配置工作盘、制品盘、资源配额及 npm registry 出口；API/数据库/Redis 不应对用户容器可达。应用启动不自动迁移，备份后显式执行：

```bash
pnpm --filter @forgekit/db db:migrate
```

迁移 `0016_b18_android_packaging.sql` 为增量加表。API 和 Worker 均需设置同一 B14 主密钥 `FORGEKIT_DEPLOY_ENCRYPTION_KEY`、REDIS_URL、绝对路径 FORGEKIT_ARTIFACT_DIR，以及 FORGEKIT_ANDROID_IMAGE。未设置镜像时消费者关闭，API 拒绝新任务。API 不探测消费者在线状态，请观测 `android_worker_ready` / `android_reconcile_failed` 等固定事件和排队时长。

配置示例（主密钥另行安全配置，禁止提交真实值）：

```dotenv
FORGEKIT_ANDROID_IMAGE=forgekit-android:b18
FORGEKIT_BUILD_IMAGE=node:22.21.1-bookworm
FORGEKIT_ARTIFACT_DIR=/srv/forgekit/artifacts
FORGEKIT_BUILD_WORKSPACE_DIR=/srv/forgekit/work
FORGEKIT_BUILD_INSTALL_NETWORK=registry
FORGEKIT_BUILD_REGISTRY_NETWORK=forgekit-registry
FORGEKIT_BUILD_REGISTRY_PROXY=http://registry-proxy:3128
```

Android 消费者通过 FORGEKIT_ANDROID_IMAGE 独立启用，不要求把现有普通构建消费者改为 docker。它复用 B09 的 FORGEKIT_BUILD_* 安装/资源设置；未配置安装网络时默认 none，冷缓存安装会失败。registry 需运维真正实施白名单与防火墙；outbound 仅供无控制面可达服务的隔离测试机。App 编译、原生 Gradle 与签名始终禁网。不要为了缺失依赖开放任务网络；重建工具镜像。

## 构建私有工具镜像

Dockerfile 位于 [infra/android/Dockerfile](../../infra/android/Dockerfile)，须从仓库根执行。固定 Temurin JDK 17.0.17_10、Android command-line tools 19.0（13114758）、API 36、build-tools 36.0.0、Gradle 8.14.3、AGP 8.12.0。npm 构建使用独立 Node 22 镜像；部署前预拉取/扫描两个镜像，生产使用 digest 固定实际镜像。

先从 [DCloud 官方下载入口](https://nativesupport.dcloud.net.cn/AppDocs/download/android.html) 获取与模板编译器 `3.0.0-5030420261029002`（5.34 系列）匹配的离线 SDK，核对发行说明与许可。此仓库不包含或自动分发闭源 SDK。不要拿“最新版本”替换匹配版本后直接上线。

在隔离的镜像制作环境整理以下**已审核**目录；不能使用项目上传文件作为 SDK：

```text
vendor-normalized/
  VERSION                 # 内容为 5.34，换行可有可无
  libs/                   # 官方 SDK 的 uni-app 基础 AAR/JAR
  assets/data/            # 官方 SDK 的 data，含 dcloud_control.xml 等运行配置
  res/                    # 官方 HBuilder-Integrate-AS / simpleDemo 的配套 res
```

libs 至少包含 lib.5plus.base-release.aar、uniapp-v8-release.aar、配套 GIF/oaid/breakpad 等官方基础库；res 保留 app_name、TranslucentTheme、DCloudTheme 及关联资源。具体内容以该版 SDK 文档为准。准备 Google Play AAB 时不能包含 install-apk-release.aar；支付、推送、地图、UTS 等模块不在本期支持范围。普通项目脚本不能修改此原生壳。修改 SDK / 依赖需重审镜像并做真机回归。

```bash
mkdir -p infra/android/vendor
tar -cf infra/android/vendor/dcloud-5.34.tar -C vendor-normalized .
# 分别从官方发布信息/可信分发渠道核验工具包 SHA-256；私有规范化包须先审核内容再算摘要。
# 以下变量由镜像制作环境设置，不是项目配置或签名凭证。
docker build -f infra/android/Dockerfile \
  --build-arg CMDLINE_SHA256="$ANDROID_CMDLINE_SHA256" \
  --build-arg GRADLE_SHA256="$ANDROID_GRADLE_SHA256" \
  --build-arg DCLOUD_SHA256="$ANDROID_DCLOUD_SHA256" \
  -t forgekit-android:b18 .
```

不得提交 vendor 压缩包，目录已忽略。构建镜像时会联网安装 SDK/Maven 工具依赖并执行 APK/AAB 预热，然后再次 `--offline` 编译两种产物，缺库/缓存不完整会使镜像构建失败。这是按需执行的重型冒烟路径，不加入每次 PR 的常规 CI。镜像制作会接受 Android SDK 许可，执行前确认有权接受；DCloud SDK 与二进制的存储/再分发亦由部署者核实。仅支持 Linux x86_64 这一工具归档，其他架构需另评估。

镜像生成一个**仅供调试**的开发证书，查看其 SHA-1/SHA-256：

```bash
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges forgekit-android:b18 \
  cat /opt/android/debug-certificate.txt
```

DCloud AppKey 需登记包名与证书指纹。Debug 使用该镜像的开发证书，release 使用你自己的发布证书。重建镜像会改变调试证书；重新登记或保留原镜像再构建。AppKey 可读且会嵌入安装包，**不是发布签名密码**。按所用证书登记相应 AppKey，不要把发布密码放入 AppKey 或环境变量。

## 控制台操作

1. 登录后进入 uniapp 项目 →「Android 打包」。owner/editor 可配置与触发，viewer 可查看配置、日志并下载。local/匿名和未知角色均拒绝。
2. 填写包名（如 com.example.app）、DCloud AppID（__UNI__ 开头）、对应 AppKey、版本名称、正整数版本号。升级需递增版本号。保存配置后才可打包。
3. Release 需选择 JKS/PKCS12 文件（最多 64 KiB），同时填写别名、Keystore 密码与密钥密码（至少 6 字符）。签名只写，保存后清空草稿；页面只显示“已配置”。留空保留旧签名；更换包名且未传新签名会清除旧签名。删除配置可清除已存签名，历史不删除。SDK/签名格式的最终校验发生在隔离容器，保存成功不代表口令已验证。
4. 选择 Debug/Release 与 APK/AAB，点击「开始打包」。队列只包含任务 UUID；每项目同时最多一个排队/运行任务，此时不能修改或删除配置。任务保存包名、版本、类型与格式快照。Debug 不读取发布签名，不能用于正式分发。
5. 打开任务详情查看排队、编译、Gradle 和签名日志。断线按序号续传，历史已脱敏；仅纯文本展示。单任务日志最多 1 MiB，超限失败。取消运行任务后先显示清理中，确认容器删除后终止；超时/停机同样等待清理。
6. 成功后核对包名、版本、类型、格式和原始文件 SHA-256，点击「校验并下载安装包」。下载需项目权限，浏览器校验摘要通过后才保存。APK 用于设备安装；AAB 是分发包，不能像 APK 一样直接安装，需商店或相应 bundle 工具处理。本期不上传商店。

签名文件及密码采用 B14 同源主密钥 AES-256-GCM 加密，绑定项目和用途；响应、审计、错误及日志不含明文或密文。发布签名仅通过 stdin 给独立禁网签名容器，在 0600 tmpfs 临时文件中使用，结束时删除。编译、安装和原生 Gradle 不接收签名；发布目录只包含 app.apk/app.aab。请备份自己的发布密钥与控制面主密钥，主密钥与数据库备份分离保存；丢失签名可能导致无法更新既有应用。

## API 与故障处理

所有路由位于 `/api/v1/projects/:id/android`，项目 UUID 寻址：

| 路由 | 用途 |
| --- | --- |
| GET /config | 读取公开设置及 hasSigning |
| PUT /config | 保存公开设置，可选 signing 全量替换 |
| DELETE /config | 删除配置和密文 |
| POST /jobs | `{ "buildType": "debug或release", "kind": "apk或aab" }` |
| GET /jobs、GET /jobs/:jobId | 最近 100 条任务 / 单条详情 |
| POST /jobs/:jobId/cancel | 请求取消 |
| GET /jobs/:jobId/logs?seq=0&limit=500 | 脱敏日志续读 |
| POST /jobs/:jobId/log-stream-ticket | 签发 60 秒单次票据 |
| GET /jobs/:jobId/logs/stream | SSE（票据、Last-Event-ID / after） |
| GET /jobs/:jobId/artifact | 授权下载附件 |

配置输入是 packageName/appId/appKey/versionName/versionCode，signing 可选，包含 keystore（Base64）、alias、storePassword、keyPassword。不得把 signing 放入 jobs、队列或环境变量。错误返回固定中文提示，SDK 原始诊断被屏蔽，避免泄露签名。写操作每身份每小时最多 60 次。

409 通常是任务占用或 release 缺签名；503 检查镜像、Redis、主密钥与服务设置。打包失败检查：镜像已预拉取且运行用户非 root；registry 策略正常；SDK 与编译器匹配、资源中 AppID 一致；AppKey/包名/证书正确；原生依赖已预热；签名格式、别名和两类口令正确；工作盘配额足够。失败只存固定错误码，重新执行创建新任务。不要为排障在进程日志中打印请求体、主密钥或底层签名异常。

重新领取 running 不再次执行；30 分钟加 60 秒后，无活跃队列任务的遗失记录转失败。强杀、daemon 故障可能遗留容器和私有工作目录；无法确认删除时保留目录，先按任务 UUID 确认/移除容器，再清理目录。不要在仍有容器写入时遍历工作盘。自动保留期、孤儿制品回收、KMS/轮换和源码快照仍待后续。

## 测试与真实验收

```bash
pnpm typecheck
pnpm --filter @forgekit/api^... --filter @forgekit/worker^... build
pnpm --filter @forgekit/contracts test
pnpm --filter @forgekit/db test
pnpm --filter @forgekit/api test
pnpm --filter @forgekit/worker test
pnpm --filter @forgekit/console test
pnpm db:migrations:check
python3 -m unittest discover -s infra/android -p 'test_*.py'
```

默认测试使用 Docker/队列/原生签名工具 mock，不安装 Android SDK、不请求 DCloud、无真实发布证书。MySQL 集成沿用 FORGEKIT_DB_INTEGRATION=1 和现有专用测试库。先构建私有镜像，再用测试项目依次执行 debug APK、release APK、release AAB，独立核验 apksigner/jarsigner 签名、aapt 包名版本及 sha256sum；实测取消、超时及失败后的容器清理。最后在 Android 真机安装 APK、验证启动/导航/四个模板页面、AppKey 和数据请求，再用目标商店工具验证 AAB。**当前环境未执行真实 Gradle、Docker、MySQL 或真机验收**。

回退前关闭入口、取消/排空任务并停止消费者，核对残留容器；保留增量表、历史、制品和主密钥，回退应用并优先前向修复，不自动执行删表。中文为当前权威，公开发布前需补齐英文对应关键指南。架构与取舍见 [ADR-0017](../adr/0017-android-offline-packaging.md)。
