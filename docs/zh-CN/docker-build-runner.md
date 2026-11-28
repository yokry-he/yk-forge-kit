# Docker 构建 Runner 与本地制品（B09）

已实现模板工程的隔离安装/静态构建、逐行日志、受限本地制品存储与读取能力。默认仍使用 NoopRunner；B10 [实时日志与控制台构建页](./build-console.md) 已实现；[B11 带令牌的独立预览 HTTP 服务](./preview-links.md) 已实现。中文为当前权威，英文待翻译，对外发布前需补齐对应指南。安全与后续预览边界见 [ADR-0009](../adr/0009-build-and-preview-security-model.md)，队列/授权见 [B08](./worker-build-queue.md)。

## 设计与源码来源

`BuildProcessor → BuildRunner → DockerBuildRunner`，后者组合 `WorkspaceSource`、`DockerCommand`、`BuildLogSink`、`ArtifactStore`。宿主通过 Node spawn 的参数数组调用 Docker CLI，不依赖 dockerode，不在宿主 shell 执行项目命令。Worker 持有数据库/队列能力；容器只得到代码目录和固定非敏感环境，不得到平台密钥或 Docker socket。

当前项目表只登记 slug/template/features，B07/B08 的 sourceRef 只是引用字段，平台没有保存 CLI 生成的源码、上传快照或 Git checkout。因此真实 Runner 只接受 `template:vue-web`、`template:vue-admin`、`template:nuxt-site`，必须匹配项目与构建记录的模板，渲染项目当前 slug/features。它不会构建用户在本地改过的文件，也不会应用 DB 资产登记对应的本地源码改动；不是不可变快照或可复现构建。模板和依赖升级后重建结果可能变化。任意路径、URL、分支或 `snapshots/...` 都会失败，不会静默回退；NoopRunner 保留 B08 行为。

一次构建使用随机临时目录，安装与构建各启动一个容器，共享本次目录中的 node_modules/Corepack 缓存，不跨构建共享。安装运行 `corepack pnpm@10.18.3 install --no-frozen-lockfile --store-dir /workspace/.pnpm-store`；模板还没有锁文件。构建按 project-core 的 `build` 元数据调用 `pnpm build` 或 `pnpm generate`；Vue 的输出是 dist，Nuxt 的输出是 .output/public。无元数据时依次探测这两个目录。必须生成常规 index.html。

两阶段都非 root、只读根文件系统、cap-drop ALL、禁止提权、默认 seccomp、CPU/内存/swap/PID/文件句柄限制，只有本次 workspace 可写及有限 `/tmp` tmpfs。构建强制禁网；stdout/stderr 逐行持久化并提供背压，两个阶段共享日志额度，超限使任务失败。日志先脱敏，再分成不超过 16 KiB 的 UTF-8 块；未换行缓冲限制 64 KiB。可通过 DockerBuildRunner 最后一个构造参数传入额外脱敏 hook，使用 `redactBuildLog(line, knownSecrets)` 组合已有规则；不要为脱敏而把平台密钥传入容器。

BuildRunner 返回 `{ exitCode, artifact?, runnerInfo? }`，处理器在 B07 状态事务中同时写入成功状态和制品 key/size/sha256，不新增数据迁移。非零退出不发布制品。取消/超时/日志失败后，CLI 只终止自己的子进程并等待退出，Runner 只 kill/rm 当前随机命名容器，确认删除后再移除 workspace；独立清理期限不受已取消信号影响。清理错误使构建失败，处理器等待 Runner 完成后才释放任务槽位；无法确认容器删除时保留私有 workspace 供恢复，避免遍历可能仍被用户代码并发修改的路径。可通过镜像、阶段、构建 ID 和持久化日志定位失败；调度日志不记录项目原始输出、代理凭证或底层连接串。

## 宿主准备

本机从环境配置到控制台构建、打开预览的完整步骤，见 [本地 Docker 构建与预览](./local-docker-preview.md)。

1. 使用独立 Linux 执行宿主/虚机、受支持且及时修补的 Docker Engine 与默认 seccomp、启用 cgroup CPU/内存/PID 限制。控制台/API 不与不可信构建共享执行宿主，禁止暴露未认证 Docker TCP API。Worker 需 Node 22（与仓库一致）和 corepack pnpm。
2. 以专用非 root 用户运行 Worker，并授予其访问专用 Docker daemon 的权限。Runner 使用该用户 UID/GID 运行容器，确保 bind mount 可写；root 启动会在构建前被拒绝。该 daemon 权限相当于宿主高权限，不能视为普通项目用户权限；rootless/userns-remap 部署需另行验证 UID 映射、挂载权限及资源限制。
3. 以该用户创建工作根与制品根，目录权限 0700，不经过不可信用户可写的祖先或符号链接，制品目录放在工作目录外。Docker daemon 必须是本机或与 Worker 具有一致的 bind mount 路径；不支持任意远程 daemon 路径映射。工作盘使用独立配额文件系统和磁盘/inode 告警，按并发数预留内存与磁盘。制品大小限制不能限制 node_modules 或安装脚本写盘。
4. 预先拉取并扫描可信镜像，例如 `docker pull node:22`；生产建议将 FORGEKIT_BUILD_IMAGE 固定到已扫描的 digest。基础镜像须含 Node 22、Corepack、sh 和 GNU timeout，默认 Debian 系 node:22 满足；Runner 使用 pull=never，不自动下载镜像。需要额外 runtime 时先由管理员安装注册，再配置 runsc/Kata，不允许构建脚本选择任意 runtime。
5. 为安装配置受限 registry 出口，或在无平台可达服务的隔离测试宿主上显式选择 outbound。默认 none 对无预装依赖的普通镜像会安装失败，属于预期安全行为。

示例（在已经准备的专用执行宿主上，以 Worker 用户执行；数据库/Redis 地址按 B08 配置）：

```bash
mkdir -m 700 -p /srv/forgekit/work /srv/forgekit/artifacts
docker pull node:22
export FORGEKIT_BUILD_RUNNER=docker
export FORGEKIT_ARTIFACT_DIR=/srv/forgekit/artifacts
export FORGEKIT_BUILD_WORKSPACE_DIR=/srv/forgekit/work
# 仅隔离开发/CI：安装可外网访问；生产改用下述 registry 方案。
export FORGEKIT_BUILD_INSTALL_NETWORK=outbound
corepack pnpm build
corepack pnpm --filter @forgekit/worker start
```

API 仍使用 B08 成员权限，示例请求体改为 `{"sourceRef":"template:vue-web"}`（项目须为 vue-web）。不接收客户端命令、镜像、挂载路径或敏感环境参数。可用现有 build 查询读取制品元数据；B09 提供 ArtifactStore.open 供可信服务流式读取，尚无公开 HTTP 下载/预览路由。

## 安装出口策略

| 模式 | 行为与要求 |
| --- | --- |
| none（默认） | 安装、构建均 network=none；适用于经验证内置依赖的镜像/关闭云构建，普通冷缓存安装会失败 |
| registry | 安装连接 FORGEKIT_BUILD_REGISTRY_NETWORK，并传入无凭证 HTTP_PROXY/HTTPS_PROXY；构建仍 none，无代理环境 |
| outbound | 安装连接 Docker bridge，可向任意可达地址出网；仅隔离开发/CI，存在安装脚本外传与内网探测风险 |

registry 模式需要宿主管理员预建 internal 网络（例如 `docker network create --internal forgekit-registry`）与出口代理。代理是唯一可出网的成员，由代理侧严格 allowlist 约束 npm registry（或内部镜像），拒绝非许可 CONNECT 端口、私网/回环/169.254.169.254 等链路本地目的地、DNS 重绑定和越界重定向。防火墙禁止构建网段直连宿主、数据库、Redis、云元数据及外网；internal 网络本身不能代替对宿主地址的防火墙策略。不要仅设置代理变量后就假设脚本无法绕过它。依赖含 Git/tarball/自定义下载地址时应失败，由管理员审查后最小化增加允许的 registry 镜像，不给 Git/云 API 全网通行。

```bash
export FORGEKIT_BUILD_INSTALL_NETWORK=registry
export FORGEKIT_BUILD_REGISTRY_NETWORK=forgekit-registry
export FORGEKIT_BUILD_REGISTRY_PROXY=http://registry-proxy:3128
```

本项提供接入配置与强制构建禁网，不安装/管理出口代理或宿主防火墙。上线前需从同一网络验证允许的 registry 可达，其他公网/内网/元数据地址均不可达；代理/daemon 不可用时让构建失败。容器环境不包含代理认证凭证。

## 配置

以下变量均属于可信 Worker 启动配置，不从构建请求读取。

| 环境变量 | 默认与限制 |
| --- | --- |
| FORGEKIT_BUILD_RUNNER | noop；仅 noop/docker，noop 不执行源码、不生成制品 |
| FORGEKIT_BUILD_IMAGE | node:22；须预拉取，支持固定 digest |
| FORGEKIT_BUILD_RUNTIME | 不设置，使用 daemon 默认；可设置 runsc 等已注册名称 |
| FORGEKIT_BUILD_WORKSPACE_DIR | 系统临时目录；配置时须绝对路径、已存在、Worker 可写 |
| FORGEKIT_ARTIFACT_DIR | docker 模式必填，绝对路径；可信专用目录，不挂载给构建容器 |
| FORGEKIT_BUILD_INSTALL_NETWORK | none；仅 none/registry/outbound |
| FORGEKIT_BUILD_REGISTRY_NETWORK | registry 时必填，专用网络名称，拒绝 host/bridge/none/default |
| FORGEKIT_BUILD_REGISTRY_PROXY | registry 时必填，无用户名/密码/query 的 HTTP(S) origin |
| FORGEKIT_BUILD_MEMORY_MB | 2048，整数 1–16384 MiB；memory-swap 同额 |
| FORGEKIT_BUILD_CPUS | 2，整数 1–16 |
| FORGEKIT_BUILD_PIDS_LIMIT | 256，整数 1–4096 |
| FORGEKIT_BUILD_LOG_MAX_BYTES | 1048576，整数 1–16777216；两阶段 stdout/stderr 合计脱敏后字节数 |
| FORGEKIT_ARTIFACT_MAX_BYTES | 104857600，整数 1–1073741824；制品常规文件总字节数 |
| BUILD_TIMEOUT_MS | 沿用 B08，600000，整数 1–3600000；总构建期限，阶段另有同上限的容器内 timeout |

WORKER_CONCURRENCY 默认 2，按宿主能力调小。Docker 与制品存储错误会让构建失败；业务结果由状态/API 查询，BullMQ completed 仍仅表示编排结束。心跳只检查 DB/Redis，不能替代 Docker/磁盘健康检查。取消、超时会记 B08 通用错误码，详细构建诊断通过受限日志提供；Docker daemon 清理失败需宿主告警。

## 制品接口与存储边界

`ArtifactStore.put(buildId, directory, signal)` 返回 `{key,size,sha256}`；`open(key, relativePath)` 返回 `{size,body: AsyncIterable<Uint8Array>}`，调用者须消费或销毁流以关闭文件；`remove(key)` 删除指定制品。接口不携带本地绝对输出路径到 DB，不绑定云 SDK，后续可实现 S3/OSS 的相同能力。B11 已因 Worker/网关的真实共享将其抽到 `packages/artifact-store`，Worker 原路径保留兼容导出。`open` 另提供可选 `close()`，未消费或 HEAD 响应须关闭文件。

本地 key 为 `<构建UUID>/<发布UUID>`，先复制至临时目录再原子 rename，不覆盖既有制品。size 是所有常规文件的字节和，sha256 是按路径排序的每文件 `[相对路径,字节数,文件sha256]` JSON 加 LF 的清单摘要（不含空目录），不是 tar 包摘要。复制与读取逐层 lstat 检查、最终文件 O_NOFOLLOW，拒绝符号链接、硬链接数大于 1、特殊文件和路径穿越；默认最多 10000 条目、64 层。拒绝绝对路径、反斜杠、空段、`.`/`..`、控制字符、冒号和 `%`，HTTP 调用方须只解码一次，禁止双解码和目录列表。存储根及其祖先必须由可信服务独占修改。

根目录与子目录均通过 `opendir` 逐项遍历，文件和目录共享条目预算，遇到首个超限条目立即失败并关闭目录句柄、清理临时制品；不先读取或排序整个目录的文件名。仅对预算内的文件清单排序以生成稳定摘要，避免恶意大目录在检查上限前耗尽可信 Worker 内存。

本地制品是复制后的独立文件，不与 workspace/node_modules 共享硬链接。B11 先按项目/令牌授权，再从 DB 取得 key 并读取指定相对路径，不允许从请求直接指定任意存储 key。制品留存、配额与自动 GC 尚未实现；管理员应按 DB 引用清理，不能只按目录时间删除运行中或已引用产物。

## 验证、风险与回退

日常命令不需要 Docker，真实测试默认跳过：

```bash
corepack pnpm build && corepack pnpm typecheck && corepack pnpm test
```

专用非 root Linux 测试宿主预先拉取镜像后，准确的集成测试命令为：

```bash
docker pull node:22
FORGEKIT_DOCKER_RUNNER_TEST=1 corepack pnpm --filter @forgekit/worker exec vitest run test/docker-runner.integration.test.ts
```

独立 CI job `docker-runner-integration` 执行该测试，35 分钟 job 期限，每模板 11 分钟测试期限/10 分钟 Runner 期限。测试不依赖 MySQL/Redis，以真实模板渲染和 Docker CLI 构建 Vue/Nuxt，读取 index.html、校验摘要；在实际 build/generate 脚本前断言非 root、只读根、空有效 capabilities、无平台连接串/socket、只有 loopback，并真实尝试公网 TCP 连接应失败。单元测试验证 B07 成功状态与制品元数据传递，MySQL 真实持久化测试继续由已有集成 job 执行。此测试不等于宿主出口 allowlist、容器逃逸或 gVisor/Kata 认证。

Docker 共享内核、安装 outbound、工作盘无宿主配额、突然崩溃后的遗留资源均是显式运维风险，详见 ADR。容器内 timeout 只限制脚本执行，不保证 Worker SIGKILL 后容器元数据/工作目录已删除；恢复时按当前宿主的任务记录核对本项 `forgekit-<buildId>-<phase>-<随机UUID>` 名称与 `forgekit.build=true` 标签，再只清理确定归属本次任务的资源。禁止进程名匹配批量 kill、全局容器 prune 或删除其他 Worker 的活跃任务。

回退前停用新构建入口，正常停止 Worker 并等清理结束，再设 `FORGEKIT_BUILD_RUNNER=noop` 重启。保留已存在制品/日志/DB 记录；该回退不会让 noop 产生可预览产物。不需要回退数据库迁移；本项没有新增表或更改 B07 状态机。对外发布前须补齐英文关键指南并复核 preview 安全约束在 B11 的实现状态。
