# 本地 Docker 真实构建与静态预览

本指南串起控制台触发、Docker 模板构建、制品保存和独立预览进程，适用于隔离的本地开发 Linux 主机/虚机。执行边界见 [Docker Runner](./docker-build-runner.md)，预览权限与安全模型见 [静态预览链接](./preview-links.md) 和 [ADR-0009](../adr/0009-build-and-preview-security-model.md)。中文为当前权威文档；英文对应指南待对外发布前补齐。

## 前置条件

- Linux，已安装 Docker Engine，`docker` CLI 在 Worker 用户的 `PATH` 中；该用户执行 `docker info` 成功，能够访问 Docker socket。
- **Worker 必须以非 root 用户运行**，容器使用该用户的 UID/GID；不要用 `sudo pnpm dev`。Docker daemon 访问权限等同宿主高权限，仅授予可信开发用户，不向构建容器挂载 socket。使用本机 daemon，确保 bind mount 与 Worker 看到相同的绝对路径。
- Node.js 22 或更高版本、Corepack，使用仓库声明的 pnpm 版本，见 [本地开发](./getting-started.md)。镜像也需包含 Node 22、Corepack、sh 和 GNU timeout，默认使用 `node:22`。
- 可用的 MySQL 8.0（已完成当前仓库迁移）和 Redis 7；连接配置见 [MySQL 指南](./mysql-docker.md) 与 [构建队列](./worker-build-queue.md)。迁移需按 MySQL 指南先确认目标库和授权，不使用生产库或生产凭证。
- 控制台和 API 均已配置 OIDC，并使用项目 Owner/Editor 登录；可按 [本机 Keycloak 联调](./keycloak-development.md) 配置身份服务与 `apps/console/.env.local`。默认 `local` 模式只支持查看构建，不能触发构建或管理预览链接。

以将要运行 Worker 的用户检查 Docker 并预拉镜像：

```bash
id -u
docker info
docker pull node:22
```

`id -u` 应为非零值。Runner 使用 `--pull=never`，不会在构建时自动下载镜像；配置其他镜像时也须先拉到同一个 daemon。

## 准备持久目录

推荐使用 `/srv/forgekit/work` 与 `/srv/forgekit/artifacts`，均由 Worker 用户持有、权限为 **0700**。本地 API、Worker、预览进程使用同一可信用户，便于读写私有制品。若父目录需要管理员权限，以 Worker 用户执行以下一次性准备命令：

```bash
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" /srv/forgekit/work /srv/forgekit/artifacts
stat -c '%a %U %n' /srv/forgekit/work /srv/forgekit/artifacts
```

也可使用 `/workspace/forgekit-data/work` 与 `/workspace/forgekit-data/artifacts`，前提是它们在 Git 仓库外、权限同为 0700，且属于 Worker 用户；配置中同步替换为对应绝对路径。祖先目录不能由不可信用户写入，不经过符号链接，制品根必须位于工作根之外。

这两个目录承载运行数据，**不要命名为 `dist`、`build` 或 `out`**，也不要放进仓库、临时目录或会被构建清理的目录。模板内部的 `dist` 等构建输出由 Runner 管理，与这里的持久根目录不同。

## 配置环境

仓库根目录提供无秘密的 [.env.docker-preview.example](../../.env.docker-preview.example)。若尚无 `apps/api/.env`，在仓库根目录执行：

```bash
cp .env.docker-preview.example apps/api/.env
chmod 600 apps/api/.env
```

已有 `apps/api/.env` 时手动合并所需配置，保留已验证的数据库与 OIDC 设置，不要覆盖现有文件。示例中的数据库用户名、密码、库名均为 `replace_me`，必须自行填写；Redis 端口也需与本机服务一致。示例使用上述本机 Keycloak 配置，控制台需按联调指南另行配置，并通过 `http://127.0.0.1:5173` 打开。

本地推荐值如下：

```dotenv
DATABASE_URL=mysql://replace_me:replace_me@127.0.0.1:3306/replace_me
REDIS_URL=redis://127.0.0.1:36379/0
FORGEKIT_BUILD_RUNNER=docker
FORGEKIT_ARTIFACT_DIR=/srv/forgekit/artifacts
FORGEKIT_BUILD_WORKSPACE_DIR=/srv/forgekit/work
FORGEKIT_BUILD_IMAGE=node:22
FORGEKIT_BUILD_INSTALL_NETWORK=outbound
FORGEKIT_PREVIEW_BASE_URL=http://preview.localhost:3002
FORGEKIT_PREVIEW_HOST=127.0.0.1
FORGEKIT_PREVIEW_PORT=3002
```

- Docker 模式必须设置 `FORGEKIT_ARTIFACT_DIR`。API、Worker、预览进程必须使用**同一个制品目录**和同一个开发数据库；API 与 Worker 使用同一个 Redis 队列。
- API 与预览进程统一设置预览 URL、host、port；URL 用于 API 生成链接，host/port 用于预览进程监听。不要把监听地址改成对外地址来绕过 DNS 问题。
- API 与 `preview:dev` 默认读取 `apps/api/.env`。Worker **开发入口**依次加载 `apps/worker/.env` → `apps/api/.env` → 仓库根 `.env`，已存在的变量不覆盖，进程环境变量优先；`DOTENV_CONFIG_PATH` 可改为指定文件。检查旧配置是否仍为 `noop` 或指向其他目录，不能只修改根 `.env` 就假设覆盖成功。
- `outbound` 仅供隔离的本地/开发环境安装依赖，安装脚本可外传数据或探测可达内网。生产应使用管理员配置的受限 `registry` 出口或 `none`；普通冷缓存 `node:22` 在 `none` 下通常无法安装依赖。构建阶段始终禁网。网络隔离细节见 [安装出口策略](./docker-build-runner.md#安装出口策略)。

## 启动服务

在仓库根目录、以非 root Worker 用户运行；数据库、Redis、OIDC 应已就绪：

```bash
corepack enable
corepack pnpm install
corepack pnpm dev
```

此命令构建共享依赖后同时启动控制台、API 和 Worker。确认 Worker 的 `worker_ready` 日志含 **`"runner":"docker"`**；若为 `noop`，重新检查上述配置优先级。出现 `worker_disabled` 时检查 `DATABASE_URL` 和 `REDIS_URL`。

待共享依赖构建完成，在第二个终端进入同一仓库根目录，使用同一用户启动独立预览进程：

```bash
corepack pnpm --filter @forgekit/api preview:dev
```

确认日志出现 **`YKForgeKit preview listening`**。预览监听 `127.0.0.1:3002`；访问基础地址本身没有凭证，返回 404 属正常行为，应通过下述创建出的完整链接访问。修改环境文件后重启相关进程。

## 确保预览域名解析到本机

`preview.localhost` 和 **`*.preview.localhost` 必须解析到 `127.0.0.1`**。不能假设所有系统、浏览器或代理的 `.localhost` 行为一致；例如解析器将子域映射到 `198.18.0.1` 时，即使服务已监听，预览链接也无法打开。可先用无凭证测试域名检查：

```bash
getent ahostsv4 preview.localhost
getent ahostsv4 probe.preview.localhost
```

解析不正确时可选以下方式之一：

- 在本机 `/etc/hosts` 中添加基础域和**本次生成链接的具体凭证 host**。hosts 文件不支持通配符，单独添加基础域不能覆盖子域。下面第二行的 `token-label-from-created-url` 是占位符，需替换为本次 URL 中完整的 52 字符凭证标签；新链接通常要增加新的 host。

  ```text
  127.0.0.1 preview.localhost
  127.0.0.1 token-label-from-created-url.preview.localhost
  ```

- 启动 Chromium 时使用以下解析规则，覆盖基础域和所有预览子域。先退出已有 Chromium 进程，确保新进程使用该参数；也可使用独立的本地浏览器配置目录。

  ```bash
  chromium --host-resolver-rules="MAP *.preview.localhost 127.0.0.1,MAP preview.localhost 127.0.0.1"
  ```

保留生成链接的域名与 `:3002` 端口，不要直接改成 `http://127.0.0.1:3002`；预览服务通过 Host 中的凭证定位链接。

## 从控制台构建并打开预览

1. 打开 `http://127.0.0.1:5173`，通过 OIDC 登录；创建一个 Vue Web 项目，或选择自己具有 Owner/Editor 权限的 `vue-web` 项目。
2. 在项目详情进入“查看构建”，填写来源键 `sourceRef=template:vue-web`，点击“触发构建”。引用必须与项目模板一致，例如 `vue-admin` 使用 `template:vue-admin`，`nuxt-site` 使用 `template:nuxt-site`。这里重建当前项目配置对应的模板，不读取用户本地源码，不接受 Git 地址或任意宿主路径。
3. 打开构建详情，等待 Docker 安装、静态构建完成，状态为 `succeeded` 且存在制品。**Noop 构建即使成功也没有制品，不能创建预览链接**；需切换 Docker runner 后重新触发。
4. 在“预览链接”卡片选择有效期，点击“创建链接”。完整 URL 仅展示一次，点击“复制链接”；若使用 hosts 方案，此时为本次凭证 host 添加解析记录。
5. 将完整 URL 粘贴到浏览器**新标签页**打开，应能看到页面并加载静态资源。预览响应禁止 iframe 嵌入，不能在控制台 iframe 中打开。刷新控制台或离开详情页后无法恢复原始 URL，需要创建新链接。

创建返回 409 时确认构建成功且有制品；503 时检查 API 的预览配置、共享制品目录及数据库。链接打不开时先确认预览进程日志与 DNS；已过期、已撤销或错误 host 会返回 404。接口、日志与权限说明见 [构建控制台](./build-console.md) 和 [静态预览链接](./preview-links.md)。

## uni-app H5 真实构建验证

已验证的本地流程使用 `uniapp` 模板项目，目标为 `h5`，沿用上述 Vue Web 的 Docker runner 与 `FORGEKIT_BUILD_INSTALL_NETWORK=outbound` 安装配置。在控制台进入“查看构建”，填写来源键 `sourceRef=template:uniapp` 后触发构建；也可通过 `POST /projects/:id/builds` 触发。来源键必须与项目模板一致。

热缓存下，本次构建约 17 秒成功，从触发到完成约 22 秒，状态为 `succeeded`，退出码为 0，日志以 `DONE  Build complete.` 结束。静态制品约 14 个文件、220 KB，包含 `index.html` 与 `assets`。pnpm 输出了涉及 `core-js`、`esbuild` 的 `Ignored build scripts` 警告，本次验证中无害，不影响构建与预览。

构建成功后创建预览链接，按上文确保 `*.preview.localhost` 解析到本机，并在浏览器**新标签页**打开；预览禁止 iframe 嵌入。实际访问返回 HTTP 200，显示 uni-app 首页及底部“首页 / 列表 / 我的”标签栏。

本次仅验证 H5 目标；微信 / 支付宝小程序、Android / iOS、Tauri 未验证。

## 安全与停止

预览 URL 是 **bearer 凭证**，凭证子域本身也等同完整凭证。不要将真实 URL 或凭证 host 粘贴到 Git、PR、Issue、日志或分析系统；本机 hosts 中的记录也不要复制到仓库。不要提交真实 `.env` 文件，仅提交无秘密示例。撤销链接可阻止后续请求，但不能收回已加载内容，详见 [ADR-0009](../adr/0009-build-and-preview-security-model.md)。

本指南的 HTTP、回环监听和 `outbound` 配置仅供本地开发；生产须遵循独立执行面、受限出口、独立预览域、HTTPS 和凭证日志脱敏要求。停止时分别在两个终端按 Ctrl+C，让 Worker 完成当前容器清理；保留持久目录供已有制品继续使用。
