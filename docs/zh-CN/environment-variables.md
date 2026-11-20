# 环境变量与秘密值（B14）

项目详情 →「环境变量」可以按 preview、production 或自定义环境管理配置。仅已登录的 OIDC 项目成员可访问；owner/editor 可添加、替换、删除，viewer 可看普通值和秘密名称。环境列表中的默认名称在首次写入或创建相关任务时落库，复用现有 `environments`。

## 添加和替换

选择环境，填写名称、类型和值后保存。名称使用大写字母/下划线起始，后接大写字母、数字、下划线，最多 128 字符；环境名使用小写字母起始，后接小写字母、数字、下划线、连字符，最多 64 字符。每环境最多 100 个变量。

普通值对项目成员可见，允许空串。秘密值保存后只显示 `••••••`，无法读取或找回；「替换秘密值」始终打开空表单。秘密值及其每个非空行至少 4 个字符，不能是纯空白。两类值上限均为 16 KiB UTF-8，不接受 NUL。改成普通变量时必须重新填写新的可见值，不能显示旧秘密。删除不影响已启动任务或已有发布目录。变量名修改需要新建后删除旧名。

平台保留 `FORGEKIT_*`、`DOCKER_*`、`LD_*`、`DYLD_*`，以及 GCONV_PATH、GLIBC_TUNABLES、SSL_CERT_FILE、SSL_CERT_DIR、 PATH、HOME、CI、NODE_OPTIONS、LD_PRELOAD、LD_LIBRARY_PATH、ENV、BASH_ENV、COREPACK_HOME、COREPACK_ENABLE_DOWNLOAD_PROMPT、NUXT_TELEMETRY_DISABLED、HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、NO_PROXY。应用自己的 DATABASE_URL 可使用；它不替换 API/Worker 的数据库配置。

## 构建和发布何时使用

构建表单可填写环境，留空默认 preview。API `POST /api/v1/projects/:id/builds` 可提供 `environmentName`。创建构建时记录环境；旧构建执行时补记 preview。Worker 在任务开始时读取变量快照，Docker 仅在 build/generate 阶段提供，依赖 install 阶段没有项目变量。修改之后启动的任务会读取新值，运行中的任务保持快照。

变量通过容器 env 提供；命令参数仅含变量名，不含值，也不会写入 Dockerfile 镜像历史。平台加密主密钥不会进入构建容器。容器管理员、Docker inspect 和用户代码仍可读取注入值。**前端打包可能把变量写入公开 JS/HTML；秘密类型不能保证打包产物保密。只给可信项目代码必要的凭据。**

SSH 静态部署沿用 B12 的 production 环境，写入：

```text
<basePath>/forgekit-<projectId>-<targetId>/environments/<releaseId>/.env
```

文件内容采用 POSIX shell 赋值语法（逐值字面量引用，支持换行和引号，不应使用简化的 dotenv 逐行解析器）。父目录为 0700、文件为 0600，位于公开的 `releases`/`current` 之外。在确认配置写入后才原子切换 current。失败清理 staging 和未启用的新配置，保留期删除旧 release 时一并清理对应配置。回滚使用原 release 的 .env；B12 旧 release 没有 .env 时仍可回滚。

`.env` 是 POSIX shell 的字面量赋值文件，单引号及换行经过安全引用；不是 JSON，也不承诺所有第三方 dotenv 解析器兼容。文件不会自动运行或加载到静态网页。服务运维如需加载，须使用兼容 POSIX shell 的方式并限制文件访问权限。静态浏览器配置应在相应构建环境中提供；preview 构建后部署到 production，不会重新打包浏览器参数。

## API 与审计

- `GET /api/v1/projects/:id/environments`：可管理的环境名称。
- `GET .../environments/:environment/variables`：name、kind、updatedAt、updatedBy；仅普通变量返回 value。
- `PUT .../environments/:environment/variables/:name`：请求必须包含 `{ "kind": "plain", "value": "example" }` 或 kind=secret 与新值，统一新建/替换。
- `DELETE .../environments/:environment/variables/:name`：删除，成功返回 204。

没有秘密读取接口，也不返回密文。接口响应禁止缓存，变量写入每身份每小时限 60 次。创建/更新/删除与审计同事务记录；`variable_audit` 包含操作者、时间、项目、环境 ID、名称、类型、动作，不含明文/密文。本 MVP 没有审计查询 UI，运营方可通过受控只读 SQL 查询。

API 在应用边界将 JSON 解析失败统一返回 400「请求体不是有效 JSON」，不回显解析器的请求正文片段或提交的秘密值；其他参数校验错误沿用现有处理。

## 运维与保护边界

显式应用 Drizzle `0013` 迁移；应用启动不会自动执行。API 与可信 Worker 使用 B12 已有的 `FORGEKIT_DEPLOY_ENCRYPTION_KEY`，为 64 位 hex（32 字节）密钥，与数据库和备份分开保存。可以沿用 [SSH 部署指南](./ssh-deploy.md) 中的本机随机生成方式；不要把真实密钥放入项目变量、日志、源码或构建容器。未配置有效主密钥时，普通变量仍可管理，秘密写入/使用会失败关闭。已有 B12 私钥密文不需要迁移。

构建 stdout/stderr 在入库和 SSE 之前按任务快照脱敏，支持跨输入 chunk、CRLF、非空行及 JSON 转义的单行形式；部署不保存远端原始 stdout/stderr，处理器也脱敏步骤日志。不要依赖它防止恶意程序泄密：任意编码/拆分、产物和已公开的文件不在扫描范围，运行任务不会动态加载后来新增的秘密。

进程内存、swap、core dump、宿主 `.env`、私有临时 tar 和备份仍需要系统权限保护。强杀可能留下私有临时文件；远端切换后数据库故障仍须按 B12 核对 current。丢失主密钥无法恢复秘密。删除数据库秘密也不会擦除备份或旧 release；必要时主动撤销上游凭据。

当前不含 KMS、自动轮换界面、外部 Vault、秘密历史版本、环境删除或运行服务重启。实现决策见 [ADR-0013](../adr/0013-environment-variables-secrets.md)。英文指南尚待公开发布前补齐。

## 验证与回退

运行 `corepack pnpm typecheck`、`corepack pnpm db:migrations:check`、`corepack pnpm test`、`corepack pnpm build`。MySQL 额外使用现有 `FORGEKIT_DB_INTEGRATION=1` 和一次性测试数据库，运行 `pnpm db:test:integration`；Docker 与 SSH 仍由现有 `FORGEKIT_DOCKER_RUNNER_TEST` / `FORGEKIT_SSH_DEPLOY_INTEGRATION` 门禁及 CI 执行，本地默认跳过。

回退前停止变量写入口与相关任务消费者，核对活动任务。保留新增表、审计、主密钥和主机配置，优先前向修复，不自动反向迁移。旧 Worker 不支持本项注入，回退会改变之后任务行为。
