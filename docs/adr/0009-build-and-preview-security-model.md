# ADR-0009：构建与预览安全模型

- 状态：Accepted（B09 构建实现；预览约束由 B11 实现）
- 日期：2026-11-19
- English title: Build and preview security model

## 背景与威胁模型

路线图 MVP 将构建沙箱安全列为最大技术风险。[ADR-0007](./0007-build-data-foundation.md) 已定义构建、制品摘要和只存摘要的预览令牌，[ADR-0008](./0008-worker-build-queue.md) 已定义队列、取消与清理契约。安装依赖的生命周期脚本与构建脚本均视为不可信代码，不能在 API 或控制台主机直接执行。

| 威胁 | 边界与对策 |
| --- | --- |
| 安装脚本、恶意依赖、任意构建命令 | 每阶段独立容器；非 root、只读根、能力清空、默认 seccomp、禁止提权 |
| 平台数据库、队列、云凭证及 SSH 密钥泄漏 | 平台凭证仅在可信 Worker；不向容器传递、不挂载配置、socket 或凭证目录；日志脱敏为补充防线 |
| 容器逃逸、内核漏洞 | 执行面独立 Linux 主机/虚机、及时修补内核/Engine/runtime；Docker 共享内核并非强租户隔离 |
| CPU、内存、进程、磁盘和日志滥用 | CPU/内存/swap/PID/文件句柄/临时盘限制、墙钟超时、日志字节上限；工作盘需宿主配额 |
| 网络外传、内网探测、元数据服务访问 | 构建阶段 `network=none`；安装阶段仅经 registry 出口，默认禁网，公网模式须显式启用并承担风险 |
| 制品路径穿越、链接逃逸、特殊文件和存储耗尽 | 容器删除后复制制品；限制相对路径、拒绝所有符号链接/多硬链接/特殊文件、总大小/条目数/深度上限 |
| 预览令牌泄漏、过期后仍可访问 | 256 位随机令牌、SHA-256 摘要持久化、期限和撤销每次校验、日志不记录令牌、禁止公共缓存 |
| 预览 HTML/JS 的 XSS、跨项目读取、控制台/API Cookie 泄漏 | 独立预览 origin，优先独立可注册域；按构建隔离 host；主应用使用 host-only Cookie；CSP、nosniff 与禁止跨源凭证 |

## 构建决策（B09）

1. MVP 使用 Docker CLI，由 `spawn` 传参数数组，宿主不使用 shell；相较 dockerode，现有 Node 标准库即可实现有限命令集，无新增第三方运行时依赖与 SDK 升级成本。Docker 是可替换适配器，编排器只依赖 `BuildRunner`。镜像默认 `node:22`，部署者预先拉取并扫描，生产建议固定 digest；`--pull=never` 避免构建期间隐式拉取。仅支持可信的 Node 22 Debian 系镜像（需 Corepack、sh、GNU timeout），不承诺任意镜像兼容。
2. 安装和构建各执行一次 `docker run`，共享本次专用工作目录，不共享其他构建的缓存。强制当前非 root Worker 的 UID/GID、`--read-only`、`--cap-drop=ALL`、`--security-opt no-new-privileges`；保持 Docker 默认 seccomp，不使用 unconfined/privileged/host PID/host network。默认 2 CPU、2048 MiB 内存、同额 memory-swap（禁额外 swap）、256 PID、1024 文件句柄、禁 core dump、256 MiB `/tmp` tmpfs。仅挂载本次 workspace（含构建输出），制品存储、Docker socket、宿主根和平台配置均不挂载。Docker CLI 在可信 Worker 上访问专用 daemon，该权限等同宿主高权限，应与控制面隔离。
3. 安装默认 `none`；冷缓存会明确失败。`registry` 模式接入部署者创建的 internal Docker 网络及无凭证 HTTP(S) 代理，代理仅放行 `registry.npmjs.org:443`（或自有镜像），并拒绝其他 CONNECT、私网/回环/链路本地地址、重定向后的非许可目的地及 DNS 重绑定。防火墙同时禁止构建网段访问控制面、宿主、元数据服务和绕过代理直接出网。代理配置本身不提供隔离，必须由网络/代理管理员落实和验证。MVP 为本地/CI 提供显式 `outbound`（bridge）选项；它允许安装脚本直接外传和探测内网，**未满足生产 registry 白名单要求**，只可在无平台可达服务的隔离测试宿主启用。构建始终 `--network none`，不传代理。
4. 只传固定的容器 HOME/CI/Corepack 缓存位置/禁遥测配置和可选无凭证代理；不继承 Worker 环境，不注入数据库、Redis、云或 SSH 密钥。Corepack 固定调用 pnpm 10.18.3；工具和依赖缓存保存在本次 workspace，第二阶段可离线使用。当前模板不含锁文件，因此安装使用 `--no-frozen-lockfile`；这不保证跨时间可复现，版本化源码/锁文件归后续源码接入解决。
5. 默认总墙钟期限 10 分钟；Runner 与处理器均响应 AbortSignal。每阶段另有容器内 `timeout`，降低 Worker 被强杀后脚本永久执行的风险。正常退出、失败、取消、超时均先终止本次 CLI 子进程并等待退出，再对本次随机唯一容器名执行 `docker kill`、`docker rm --force`，确认删除后再移除 workspace。清理使用独立期限；清理失败必须使任务失败，不能记录成功。若无法确认容器已删除，保留私有 workspace 供宿主恢复，避免在不可信进程仍可并发写入时遍历宿主路径。只操作自己创建的 PID/容器名，不按进程名批量结束。突然断电、SIGKILL、daemon 不可用仍可能遗留容器/目录，需要宿主恢复后按构建记录人工核对清理，不宣称崩溃下资源恰好回收。
6. stdout/stderr 按行、UTF-8 解码并 await 日志写入；默认合计 1 MiB，单块最多 16 KiB，未换行缓冲最多 64 KiB，超限失败并清理，禁止无限截断后继续运行。脱敏 hook 在分块前处理已知 secret、Bearer、token/password/secret 赋值和 URL 密码；Docker 日志驱动 `none` 避免旁路持久化。脱敏无法识别编码/拆散的任意机密，因此不能替代不注入机密。
7. 仓库只有项目登记元数据，没有源码文件表/上传快照/Git 获取实现。Docker Runner 仅接受 `template:<模板ID>`，且须与构建记录和项目模板一致；通过 project-core 渲染项目 slug、features。此引用代表当前版本模板重建，不是用户本地源码或不可变快照；其余 sourceRef 拒绝，不能当宿主路径或 shell 片段。模板元数据指定 build/generate 和输出路径，缺省探测 `dist`、`.output/public`；Nuxt 使用 generate。
8. 制品在所有构建容器删除后，由可信 Worker 拷贝到 `ArtifactStore`。MVP 的 LocalFs 实现以 `<build UUID>/<随机 UUID>` 发布独立目录，临时目录复制完成后 rename，拒绝链接、路径穿越与特殊文件，默认总量 100 MiB、10000 条目、最多 64 层；需存在常规 `index.html`。B07 `updateStatus` 在 running→succeeded 同事务保存 key、文件总字节数和 SHA-256（排序文件清单的摘要，非 tar 摘要）。读取接口按 key + 相对路径打开流，授权仍由 B11 调用方负责；不公开存储根，不跟随链接。存储根及祖先只允许可信服务修改，容器不可写；此条件和停容器后复制避免本地 TOCTOU 攻击。失败阶段不发布半成品；数据库提交/取消竞争仍可能遗留无引用目录，后续保留期清理需与 DB 对账，B09 不实现自动 GC。

## 预览决策（B11 实现约束）

预览服务使用独立 origin/host，优先选择与控制台/API 不同的可注册域，并为不同项目/构建隔离 host，避免同源脚本、localStorage、Service Worker 相互读取。主应用 Cookie 必须 host-only（建议 `__Host-`、Secure、HttpOnly、SameSite），禁止设置覆盖预览 host 的 Domain；预览端不发送/转发主应用 Cookie，也不设置主应用 Cookie。控制台/API CORS 不允许预览 origin 携凭证访问。Host 路由必须严格匹配，不信任请求中的任意转发头。

生成令牌使用加密安全的 32 随机字节（256 bit），无填充 base64url；只在创建响应交付明文，持久化 SHA-256。沿用 B07 的 5 分钟至 7 天 TTL、默认 24 小时，逐请求检查未过期、未撤销、构建成功及制品存在，并执行项目权限校验以创建/撤销令牌。API、网关、代理、访问分析、错误跟踪不能记录令牌、完整带令牌 URL 或 Authorization，配置 query/path 脱敏；返回 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`，避免通过 Referer 或公共 CDN 缓存扩散。链接本身是 bearer 凭证，接收者仍能复制或主动外传，不能将其当保密内容的强访问控制。

仅服务校验后的静态文件，严格 MIME，返回 `X-Content-Type-Options: nosniff` 和 CSP。初始策略以 `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` 为基线。Nuxt 的内联 hydration 等需要逐页 hash/nonce 或明确评估兼容策略，不为方便默认开放任意脚本/外部连接；控制台若需 iframe 嵌入须另行收紧允许的 frame-ancestors。预览脚本始终视为不可信，CSP 是纵深防御，不把预览 XSS 与主应用同源。路径需解码一次后交给 ArtifactStore 校验，不将令牌当文件路径。B09 不实现上述 HTTP 网关、令牌生成或预览 UI。

## 取舍、演进与验证

Docker 不能消除共享内核逃逸风险；后续可配置 `FORGEKIT_BUILD_RUNTIME=runsc`，由专用宿主安装注册 gVisor；Kata 也通过 runtime 适配，需重跑网络/文件系统/资源限制/清理测试后启用。当前不开启自动 runtime 安装、不承诺已验证 gVisor/Kata。

工作目录的 bind mount 没有 Docker 通用大小上限，必须配置宿主独立文件系统/项目配额与并发容量告警，tmpfs 限制和制品上限不能限制安装期间写盘。保留本地目录制品使 B11 可直接按文件读取；OSS/S3 实现仅替换 ArtifactStore，不把云 SDK 引入构建编排。首次外部复用时再评估适配器独立包，不因规划提前抽取。

单元测试覆盖参数、脱敏、日志上限、链接/路径/大小、超时/取消与清理；独立 Docker CI 构建 Vue 和 Nuxt，检查制品与容器内实际禁网。运行方式、风险、回滚见 [Docker Runner 指南](../zh-CN/docker-build-runner.md)。Docker 安全选项依据 [Docker 官方 run 文档](https://docs.docker.com/reference/cli/docker/container/run/)，Corepack 缓存依据 [Node Corepack 文档](https://github.com/nodejs/node/blob/main/deps/corepack/README.md)。
