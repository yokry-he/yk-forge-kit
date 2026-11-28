# 静态预览链接（B11）

已实现成功构建的链接创建、有效链接列表、撤销及静态 HTTP 预览。遵循 [ADR-0009](../adr/0009-build-and-preview-security-model.md)、[B07 数据契约](./build-data-model.md)、[B09 制品存储](./docker-build-runner.md) 和 [B10 构建控制台](./build-console.md)。中文为当前权威版本；英文尚未翻译，对外发布前须补齐对应指南。

## 链接与权限

控制台成功构建详情页提供预览面板。OIDC 项目 Owner、Editor 可创建和撤销，Viewer 只能查看有效链接元数据。本机模式不提供链接管理。NoopRunner 成功但没有制品的构建不能创建链接。制品的 `index.html` 必须可读；未配置预览服务或存储不可用时创建返回 503。

- `POST /api/v1/projects/:id/builds/:buildId/preview-links`：JSON `{ "ttlSeconds": 86400 }`；空对象使用默认 24 小时。只接受 300–604800 秒的整数，额外字段返回 400。返回 `{ previewLink, token, url }`，仅该响应交付完整凭证，响应禁止缓存。
- `GET` 同一路径：返回未撤销且未过期的元数据数组，含 `id`、`buildId`、`createdBy`、`createdAt`、`expiresAt`、`revokedAt`、`lastAccessedAt`。不返回 token、URL 或 SHA-256；B07 没有存储令牌前缀，界面使用链接 ID 区分记录。
- `DELETE .../preview-links/:linkId`：撤销该构建的链接，幂等返回无响应体的 204。控制台共享客户端直接完成请求，不解析 JSON；面板移除该记录并清除对应的一次性 URL。其他构建的 ID 不影响任何记录。

未认证返回 401；非成员、跨项目构建返回 404；角色权限不足返回 403；构建尚未成功或无制品返回 409。创建每身份每小时 30 次，撤销 60 次，超限返回 429；沿用数据库共享固定时间窗口限流，多 API 实例共用配额。`preview:read` / `preview:manage` 是独立的项目能力权限。

令牌由加密安全随机源生成 32 字节，以无填充 base64url 返回；只持久化 SHA-256。`preview_link_audit` 保存项目、构建、链接 ID、操作者和创建/撤销动作，不含凭证、URL 或摘要。操作与审计在同一事务提交；重复撤销不重复审计。新增迁移 `0010_b11_preview_link_audit.sql`，须先迁移再启用 API。

创建后完整 URL 只保存在当前组件内存中，可复制或关闭；切换构建、权限丢失、离开页面、过期或撤销时清除。刷新页面不能恢复 URL，需要创建新链接。链接是 bearer 凭证，持有者可访问并复制内容，不适用于需要身份强校验的机密内容。

## 独立进程与 origin

预览使用 API 包内的**独立 Node HTTP 入口** `preview-main`，不挂载 Nest API 路由、不加载应用认证中间件、不执行制品脚本。复用包和部署产物以减少依赖，进程、监听端口与对外域名独立。Worker 与预览实际共享的 B09 文件存储已抽到 `@forgekit/artifact-store`；Worker 保留兼容导出。网关仅依赖 `ArtifactStore.open` 读取能力。

`FORGEKIT_PREVIEW_BASE_URL` 是基础 origin，例如 `https://preview.example.net`。创建出的 URL 为 `https://<52字符凭证标签>.preview.example.net/`。标签是同一 256 位令牌的 RFC 4648 小写 base32 编码（无填充），避免 DNS 大小写折叠和 base64url 下划线问题；接收时还原 base64url 后计算摘要。**该标签同样是完整凭证，必须脱敏。** 凭证 host 会出现在 DNS 查询和 TLS SNI 中（仅使用路径令牌没有这一暴露面），TLS 本身不能隐藏它；部署方必须将 DNS/SNI 可见性纳入 bearer 链接的威胁模型，不把该预览用于机密内容。 不把令牌作为磁盘路径。

每个链接有独立 host，因此不同构建、项目及同一构建的不同链接均隔离 origin、localStorage 与 Service Worker 作用域。单标签支持 `*.preview.example.net` 通配 DNS 和 TLS。构建号/项目在 API 中定位，公开 URL 不包含业务名称。仅精确匹配基础域名、单个凭证标签和配置端口，拒绝其他 Host、非法标签与非规范编码，不信任 `Forwarded` / `X-Forwarded-Host`。

## 配置与启动

本机真实构建、预览进程启动与域名解析配置，见 [本地 Docker 构建与预览](./local-docker-preview.md)。

API 和预览进程使用一致配置（Worker 使用相同制品目录）。以部署环境为例：

```dotenv
FORGEKIT_PREVIEW_BASE_URL=https://preview.example.net
FORGEKIT_PREVIEW_HOST=127.0.0.1
FORGEKIT_PREVIEW_PORT=3002
FORGEKIT_ARTIFACT_DIR=/srv/forgekit/artifacts
CONSOLE_ORIGIN=https://console.example.com
FORGEKIT_API_BASE_URL=https://api.example.com
NODE_ENV=production
```

另配置各进程的 `DATABASE_URL`，不要提交真实凭证。API 可在缺少预览配置时启动，创建链接返回 503；预览进程缺少有效配置则启动失败。生产要求 HTTPS、显式控制面 origins 和非本地域名；拒绝与控制面相同或父子关系的域名。部署者仍须选不同可注册域（代码不内置公共后缀列表），保证 Cookie 和组织域名策略正确。

```bash
corepack pnpm build
corepack pnpm --filter @forgekit/api preview:start
```

本地可用 `FORGEKIT_PREVIEW_BASE_URL=http://preview.localhost:3002`，以 `preview:dev` 启动。浏览器或 DNS 环境须将 `*.preview.localhost` 解析到回环地址；必要时配置本地 DNS。测试通过回环连接并传递真实 Host，无需外部 DNS。监听地址与 URL 端口可不同，便于反向代理终止 TLS；对外请求 Host 必须保留配置中对外端口，不能替换为内部 upstream 地址。

## 静态资源与响应策略

请求逐次检查摘要、有效期、撤销状态、构建成功状态与制品文件，不缓存授权结果。固定长度摘要使用安全比较，数据库查找只使用散列，不以明文进行匹配。未知、过期、撤销链接统一返回不含详情的 404 页面。存储/数据库故障返回通用 503。仅支持 GET、HEAD，其他方法返回 405。

解码路径一次，拒绝点段、绝对路径、反斜杠、控制字符、二次编码、编码分隔符及空段。ArtifactStore 再检查路径、符号链接、多硬链接与特殊文件。只按数据库中的制品 key 读取，请求不能指定存储 key。文件有明确 MIME，未知类型使用 `application/octet-stream`；所有响应含：

- `Cache-Control: private, no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。
- `X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`，不能嵌入控制台 iframe；用户复制链接独立打开。
- CSP 默认拒绝资源，仅允许自身脚本、样式、字体、连接，自身或 data 图片；禁止 object、base、表单提交和 worker。样式沿用 ADR 允许内联，脚本不开放 `unsafe-inline`。
- Nuxt hydration 内联脚本按每页精确内容生成 SHA-256 CSP hash；扫描游标仅向前移动，未闭合脚本不生成 hash，重复未闭合标签不会触发反复扫描。HTML 最多缓冲 8 MiB，超过预算拒绝。第三方脚本、API、字体等仍可能被 CSP 阻止，外部连接不属于本次支持范围。
- `Cross-Origin-Resource-Policy: same-origin`、限制摄像头/麦克风/定位的 Permissions Policy；无 CORS 放行或 Set-Cookie。忽略请求 Cookie/Authorization，不转发任何主应用凭据。

Vue 先读取请求文件/目录索引；无扩展名路由缺失时回退 `index.html`，缺失 JS/CSS 等资源返回 404。目录索引自动 308 到尾斜杠路径，原样保留查询参数，使目录内相对引用正确解析。Nuxt generate 读取请求文件或 `目录/index.html`，缺失时使用 `404.html` 并保留 404 状态，无该页面则返回通用 404。

**资源基路径无需改写或修改模板。** 每个凭证 host 的根目录就是该构建制品根；`/assets/...`、`/_nuxt/...`、相对资源引用、Vue history 路由以及 Nuxt 根 baseURL 均保留原有语义。不存在 `/p/token/` 前缀导致的资源路径错位。不要把这个入口再代理到某个路径前缀下。构建应保持与自身路由匹配的 base；面向其他固定子路径的自定义制品不在当前模板构建范围内。

成功提供文件时更新 `last_accessed_at`；数据库条件使同一链接最多每 60 秒写一次，跨实例也生效，不影响逐请求鉴权。此时间是近似访问记录，不代表用户读完响应或精确流量统计。

## 部署与日志

在独立域部署预览，TLS 由反向代理终止，使用通配 DNS 和通配证书（如 ACME DNS-01）；网关可只监听私有回环或服务网络。反向代理保留经匹配后的 Host，不允许任意 host 进入控制面 upstream。配置防火墙与独立服务账号，预览账号仅需读取制品和查询 builds/preview_links、更新 last_accessed_at；API 账号负责创建/撤销/审计。制品通过只读挂载提供给预览进程，容器构建面不能写该存储。

主应用 Cookie 必须 host-only，禁止覆盖预览域的 Domain，建议 `__Host-` + Secure/HttpOnly/SameSite。API CORS 仅放行已配置控制台 origin，不放行预览 host 携带凭据。独立端口不能替代生产域名隔离。

内建访问日志仅记录固定 `preview/[redacted]`、GET/HEAD/OTHER 和状态码；不记录 URL、Host、query、Cookie、Authorization 或错误对象。部署时反向代理、CDN、DNS、TLS/SNI 分析、APM 和错误追踪也不得留存凭证标签或完整 URL，关闭请求/响应体捕获；API 创建响应同样不能记录。可使用只包含状态码和固定路由名称的专用日志格式。关闭预览 CDN 缓存，不能覆盖 no-store、CSP 或 Referrer Policy。不要把真实链接放在 PR、Issue 或分析事件中。

## 验证、范围与回滚

`pnpm build && pnpm typecheck && pnpm test` 覆盖凭证、路由、响应头、路径穿越、失效/撤销、Vue/Nuxt fallback、内联 CSP、日志脱敏、HTTP 鉴权、TTL 和控制台。opt-in 端到端测试使用真实 MySQL 与 fixture 制品，覆盖 API 创建 → 存储摘要/审计 → 预览 index/asset → 过期/撤销失效、跨实例可用的访问节流以及审计失败回滚。它不依赖 Docker Runner，CI `mysql-integration` 显式运行；真实模板容器构建继续由 B09 Job 验证。

```bash
# 仅可连接一次性回环 forgekit_test 数据库/同名账号，沿用现有安全 gate
export FORGEKIT_DB_INTEGRATION=1 FORGEKIT_PREVIEW_INTEGRATION=1
# DATABASE_URL 由专用测试环境注入
corepack pnpm --filter @forgekit/api... build
corepack pnpm --filter @forgekit/api exec vitest run test/preview-links.integration.test.ts
```

不提供构建内容的后端执行、公共下载目录、对象存储实现、自动清理、证书/DNS 自动配置或撤销已下载内容的能力。链接撤销阻止后续请求，不能收回浏览器内已加载的页面；CSP 禁止新 Service Worker 注册。生产安全仍依赖独立域、TLS、日志策略和存储只读权限。

回滚时先关闭创建入口并停止预览进程/路由，保留制品、已有链接和审计供恢复；撤销高风险链接。`0010` 仅增加审计表，通常保留，不必回退 B07 或删除数据。风险在于 bearer URL 外传、域名/日志错误配置及页面 CSP 兼容性，部署时须按上述约束验证。
