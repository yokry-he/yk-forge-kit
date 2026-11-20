# 部署到自有 Linux 主机（B12）

B12 将成功构建的**静态站点**通过 SSH 上传到你自己的 ECS/CVM/普通 Linux 主机，提供目标管理、实时部署日志、历史和保留版本回滚。不调用云厂商 API，不需要提供阿里云/腾讯云账号、AccessKey 或日常登录私钥。域名、HTTPS、Nginx/Caddy 安装配置与站点健康探测留待后续功能。

## 准备主机与专用密钥

支持 GNU/Linux（例如 Debian/Ubuntu）与 OpenSSH server，远端需有 sh、GNU tar/coreutils 和 util-linux flock。不支持仅 SFTP 的受限账号、Windows、IPv6 地址输入或缺少上述工具的精简系统。

在**你自己的电脑**生成仅用于此站点的密钥，不复用日常个人/管理员密钥。MVP 仅支持无口令私钥；由平台加密存储，权限应限定到专用账号和发布目录。命令由主机所有者执行，不要把真实私钥粘贴到聊天、Issue 或 PR。

```bash
ssh-keygen -t ed25519 -f ./forgekit-site-deploy -N '' -C forgekit-site-deploy
```

在主机的云控制台/已有管理员会话创建非 root 账号（示例 `deploy`），准备归它所有的 `/srv/forgekit`，在该账号 `~/.ssh/authorized_keys` 添加生成的 `.pub` 文件内容，`.ssh` 权限 0700、authorized_keys 0600。可给该公钥添加 `restrict` 限制，额外用 `from="可信Worker出口IP"` 限制来源；不能加 `command=` 强制替换命令，因为发布器需要执行固定发布脚本。账号只需拥有发布目录，不需要 sudo。SSH 防火墙只允许可信 Worker 出口。

通过**云控制台终端等可信通道**取得并核对主机公钥：

```bash
# 在目标主机执行；这是公钥，可以复制到控制台的“主机公钥”字段。
awk '{print $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

控制台字段需要完整 `ssh-ed25519 AAAA...`，而非 `SHA256:...` 指纹，也不含 known_hosts 的主机名/注释。还支持 ecdsa-sha2-nistp256 和 RSA 公钥（RSA 连接使用 SHA-2）。ssh-keyscan 只能采集，不能证明主机身份；不要在未核对时直接信任其结果。更换主机密钥后应先在可信通道重新核对，再编辑目标，否则连接会报 `ssh_host_key_mismatch`，不会自动接受未知密钥。

## 添加、部署与回滚

1. 使用 OIDC 登录并进入项目的「部署目标与历史」。owner/editor 可新增、编辑、删除和部署；viewer 可查看目标元数据、状态、历史与日志。本机匿名模式不允许部署操作。
2. 添加目标：填写名称、IPv4/域名、端口（默认 22）、专用非 root 用户、已核对的主机公钥、基础目录和保留数（默认 5，范围 1–50）。基础目录支持 `/srv/<目录>`、`/home/<目录>`、`/var/www/<目录>`，仅普通字母数字、下划线及连字符的目录段。填写专用私钥，保存后不再读回；编辑留空保持原私钥。API 和代理必须通过 HTTPS，禁止请求/响应正文日志。
3. 在成功且有静态制品的构建详情页，选择目标并点击「部署此构建」。系统创建部署任务并打开状态/日志；同一目标同时只允许一个待执行或运行任务。目标正在部署时不能编辑/删除。
4. 完整站点上传后切换 `current`。实际根目录为 `<基础目录>/forgekit-<项目UUID>-<目标UUID>`，例如根目录下 `releases/<release UUID>/index.html` 和 `current -> releases/<release UUID>`。两个目标不会共享发布目录。站点文件统一为 0644、目录为 0755；基础目录及其父目录仍需允许站点服务账号遍历。Nginx/Caddy 的静态根指向该目录的 `current`。
5. 在历史中选择仍保留的成功发布，点击「回滚到此版本」并确认。回滚创建独立任务，验证完整标记后原子切换，不重新上传。数据库记录为当前的保留版本也可回滚，用于切换后数据库或日志写入失败的恢复；远端已指向该版本时可安全重复切换。已清理版本或已删除目标不能回滚。回滚不延长版本的保留顺序，下一次发布仍按创建时间保留最近 N 个版本。

发布过程先写临时目录，完成后原子改链接，失败上传不改变 current。每次新发布成功切换后清理超出 N 的已知发布目录；调整保留数在下一次新发布生效。目录必须由可信部署账号独占管理，不能让其他进程写入、替换为链接或删除完成标记。

删除目标会销毁数据库中的密文并隐藏目标，保留部署历史和审计，远端文件及 authorized_keys 不会被删除。请自行撤销不再使用的公钥并清理目录。已有部署历史后不能改主机/端口/用户/基础目录，迁移请新建目标；可以编辑名称、公钥、私钥和保留数。

日志只包含固定执行步骤和安全错误码，不回传任意远端 stdout/stderr。主机校验、认证、制品摘要等失败可由错误码定位；详细系统问题由主机所有者在可信终端排查。页面支持实时 SSE、断线重连、历史回放与手动刷新日志。

## 故障边界

连接超时 10 秒；远端脚本最多 300 秒（另有 5 秒终止宽限），本地任务预算 330 秒。SSH/Worker/数据库断线可能发生在链接已经切换之后，任务失败不必然意味着远端没有变化。看到 `deploy_worker_lost_check_remote`、清理失败或不确定错误时，先由主机所有者核对 `readlink <根目录>/current`、对应 index.html 与 `.forgekit-complete`，再回滚到已保留版本或新建部署。不要删除活动目录或直接把同一历史记录改回 running。远端磁盘满、目录被手工清理及强杀残留需要运维处理。

成功状态表示静态制品和链接切换完成，不表示 DNS、TLS、Web 服务和外部访问已经验证。当前没有镜像/Node 服务部署、自动 Web 健康检查或失败后自动健康回滚。源码来自现有模板构建能力，不能把构建 sourceRef 当作本机任意目录。

## 运营与开发配置

API 与可信 Worker 配置同一个 `FORGEKIT_DEPLOY_ENCRYPTION_KEY`（64 个十六进制字符），示例生成方式：

```bash
openssl rand -hex 32
```

通过密钥管理器/部署环境注入，**不要提交生成值**。Worker 还需要 DATABASE_URL、REDIS_URL 和绝对路径 FORGEKIT_ARTIFACT_DIR，与 B09/B11 存储保持一致。宿主需要 OpenSSH client（ssh、ssh-keygen）和 GNU tar；构建容器不需要这些部署凭据。新增迁移 `0011_b12_ssh_deploy.sql` 需按既有数据库流程审查并显式执行，应用启动不迁移。

未配置主密钥时部署写操作返回 503、部署消费者不启动；已有构建仍可工作。主密钥一旦配置错误，不能解密既有目标。部署账号只能访问发布存储及所需主机，应在独立可信执行面运行，禁止构建面访问平台数据库/Redis/SSH 密钥。不要用任意目标输入替代出站防火墙：回环/私网为测试和私有主机保留，运营方仍须隔离控制面、元数据网段并限制出口。

数据库保存主机/端口/用户、公钥、目录、保留配置、当前版本、角色授权关联、历史状态/审计、固定步骤日志及 AES-256-GCM 私钥密文。私钥从未在创建响应中回显，也不存于 Redis；队列只有部署 ID。主密钥与数据库备份分离保存。`v1` 密文以项目/目标身份验证，随机 12 字节 IV 防止相同密钥呈现相同密文；解密只接受 12 字节 IV 和完整的 16 字节认证标签。版本没有 KMS 自动轮换接口；更换主密钥前需在旧密钥可用时离线重加密所有目标并协调 API/Worker 切换，不能直接改环境值。删除目标会清空当前密文，但旧备份仍须按备份策略处理。

Worker 每任务 0700 临时目录中短暂写入 0600 identity，执行完成/失败后删除；Buffer 清零不保证 JS 字符串/系统缓存已物理抹除，进程强杀可能残留目录。使用可信私有临时盘，限制 core dump/swap 和备份范围，主机恢复后按任务核对清理。代理/APM 不应记录目标写接口正文、Authorization、日志票据 query 或 API 响应。

## 本地 Docker 假主机与 CI

测试不使用任何真实云凭据。沿用 [MySQL 集成测试](./mysql-integration-testing.md) 的一次性回环 forgekit_test 库和 Redis/15；不要连接应用库。准备 `.env.test` 后在仓库根目录：

```bash
docker compose --env-file .env.test -f compose.test.yml up -d --wait
docker build -t forgekit-sshd-test:b12 infra/ssh-test
set -a
. ./.env.test
set +a
export FORGEKIT_SSH_DEPLOY_INTEGRATION=1
corepack pnpm --filter @forgekit/api... --filter @forgekit/worker build
corepack pnpm --filter @forgekit/api exec vitest run test/ssh-deploy.integration.test.ts
# 完成后停止一次性数据库/Redis；测试自身负责删除 sshd 容器与测试数据。
docker compose --env-file .env.test -f compose.test.yml down
```

测试启动随机端口、仅监听回环的 sshd 容器，现场生成用户私钥/主机密钥，从容器取得可信公钥种子，走真实 API → MySQL/Redis 队列 → Worker → SSH 上传 → current 文件读取 → SSE → 二次部署/回滚/保留数 → 错误 pin 拒绝 → 删除密文/保留历史。外部认证用测试身份适配器，角色和成员查询仍用真实数据库；真实 OIDC 验证由既有 Keycloak CI 负责。

常规测试（不依赖 Docker/数据库）：

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm db:migrations:check
# 可仅跑新增的安全/发布脚本单元测试
corepack pnpm --filter @forgekit/db exec vitest run test/deploy-secrets.test.ts test/deploy-repository.test.ts
corepack pnpm --filter @forgekit/worker exec vitest run test/ssh-release.test.ts test/ssh-deployer.test.ts test/deploy-processor.test.ts
corepack pnpm --filter @forgekit/api exec vitest run test/deploys.test.ts test/deploy-streams.test.ts
corepack pnpm --filter @forgekit/console exec vitest run test/deployments-page.test.ts test/deploy-log-stream.test.ts
```

CI `ssh-deploy-integration` 是独立 Ubuntu Job，与已有 Docker/数据库集成 Job 一样在 PR/push main 上运行，无云 secrets、无 continue-on-error。本地未设置 opt-in 时集成测试跳过，CI 显式打开；组织分支保护的 required checks 需在仓库管理侧按现有流程选择该 Job，本变更不修改远端设置。

本次本地环境 Docker socket 不可访问，容器集成留待有 Docker 权限的环境与 CI；浏览器视觉、键盘和浅色主题尚未完整人工验收。中文为权威，英文对应指南待公开发布前补齐。架构、失败窗口及回退见 [ADR-0011](../adr/0011-ssh-static-deployment.md)。
