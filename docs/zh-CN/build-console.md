# 构建控制台与实时日志（B10）

已实现项目构建列表、触发、详情、取消、再次构建和 SSE 日志。设计见 [ADR-0010](../adr/0010-build-log-streaming.md)，执行边界见 [Docker Runner](./docker-build-runner.md)。中文为当前权威；英文对应指南待补，对外发布前必须完成。

## 页面与权限

项目详情的“查看构建”进入 `/projects/:slug/builds`，构建号进入 `/projects/:slug/builds/:buildId`。页面先按 slug 解析项目，再用 UUID 调用构建 API。列表每页 50 条，以最后的构建号加载历史，分页失败保留现有结果；可见时每 5 秒更新已显示的活跃构建，不为列表启动日志流。

owner/editor 可触发与取消，viewer 只读；权限未核实、核实中或核实失败均禁用写操作。进入、focus、重新可见及可见状态每分钟复核权限；服务端始终再次授权。local 仅限非生产回环监听，页面显示“本机模式仅支持查看构建”，不能触发/取消/签发票据。

当前 Docker Runner 只支持与项目模板匹配的 `template:vue-web`、`template:vue-admin`、`template:nuxt-site`。输入来源键后明确提交；不自动重试触发，避免重复构建。模板来源渲染当前项目配置，尚无 Git checkout、上传快照或不可变源码归档。再次构建会预填当前引用，但创建新的构建记录。成功状态和 artifact 元数据不代表有公开下载/预览入口；B11 预览尚未交付。

详情显示状态、来源、模板、时间、耗时、退出码和错误；取消遇到 409 刷新真实状态。401 清页面/会话并携带当前 returnTo 跳转登录；403/404 读取访问丢失清日志和连接。写入的 403 先复核权限，允许合法 viewer 保持只读。网络失败可重试，不退出登录。

日志支持自动滚动（可关闭）、连接状态、手动重连/终态刷新。颜色区分 stdout/stderr/system，并提供流类型的可访问标识。ANSI CSI/OSC/超链接/ESC 与危险控制字符经有界增量解析移除；Vue 文本插值转义 HTML，不执行终端控制或自动链接。块之间不添加换行。仅保留最近 5000 块、最多 2 MiB 清理后的 UTF-8 文本，截断提示“仅显示最近日志”；解析器和续传序号不随淘汰重置。当前仅深色主题，浅色尚未交付。

## SSE 契约

所有路径前缀 `/api/v1`；项目和构建 ID 是 UUID。

1. `POST /projects/:projectId/builds/:buildId/log-stream-ticket`：OIDC Bearer 鉴权，检查 build:read 与归属，201 返回 `{ticket, expiresAt}`，`Cache-Control: no-store`。票据为 32 随机字节的 43 字符无填充 base64url，有效 60 秒且只能原子消费一次。Redis 仅保存摘要键和绑定身份，不保存 access token。
2. `GET /projects/:projectId/builds/:buildId/logs/stream?ticket=...&after=0`：使用同源原生 EventSource，无需 withCredentials。local 可省略 ticket。握手再次授权，连接期间最多间隔 15 秒复核；票据期限也是流期限，到期发送 `stream-error(ticket_expired)` 并关闭，客户端重新获取票据。
3. `after` 是 `0..4294967295` 十进制整数，缺省 0。若有 Last-Event-ID 则优先使用该头，非法返回 400。只发送大于游标的块，严格升序，只有 log 帧有 `id: seq`。

示例帧（JSON 字符串中的换行保持转义）：

```text
event: log
id: 17
data: {"seq":17,"stream":"stderr","content":"error\n","ts":"2026-11-19T01:02:03.000Z"}

event: status
data: {"build":{"id":"...其余完整 BuildSchema 字段..."}}

event: end
data: {"buildId":"构建 UUID","status":"failed","lastSeq":17}

event: stream-error
data: {"code":"ticket_expired","message":"日志连接凭证已到期。"}

: heartbeat

```

status 的 build 实际是完整 BuildSchema 对象（示例为省略表示）；首次握手及状态变化发送。终态也先回放：观察终态后捕获最高日志序号 H，发送到 H 后再发终态 status、`end(lastSeq=H)`，关闭。之后追加的系统块不在这次快照内，点击“刷新日志”从 H 继续读取。空日志终态 H=0。

log payload 恰为 `{seq,stream,content,ts}`，无 buildId。每帧以空行结束；注释心跳每 15 秒，不改变日志游标。共享 strict schemas 在 `packages/contracts/src/build-streams.ts`。HTTP 握手错误：400 参数、401 票据无效/消费过/过期、403 权限不足、404 非成员或归属错误、429 连接配额、503 基础设施不可用。响应头已发后的错误用 stream-error（ticket_expired/access_revoked/unavailable），不泄漏底层异常。

客户端每次网络 error 立即 close，避免浏览器拿已消费票据自动重连；按 1/2/4/8/15 秒最多自动重试五次，收到有效业务事件重置失败次数。JSON/schema/id 校验错误停止；重复 seq 丢弃，缺口通过 REST 日志分页补齐后重开。end 缺失日志也先补齐，达到 lastSeq 才 ended；终态 status 不能提前关闭日志。

## 跨实例与资源限制

MySQL `build_log_chunks` 是权威；每次连接按最多 500 块分批读取，空闲约 500ms 轮询新增日志和状态。无需 Worker 发布消息；任何 API 副本都读到相同持久化序号。对比 pub/sub，这避免丢通知和回放/订阅竞态，代价是数据库查询负载与约半秒延迟。

Redis 使用与队列相同的 REDIS_URL，票据通过 GETDEL 跨副本单次消费，未配置或不可用时 OIDC 票据接口 503；local 读取不依赖 Redis。每进程最多 100 个流、每身份 4 个，local 共享 4 个。流最长 60 秒，最多 10000 个 log 帧；达到帧额度发 unavailable，客户端可从最后序号续读。write=false 时暂停生产并等待 drain，5 秒未恢复销毁慢连接，不保留无界队列。断连/停机清理当前连接的监听器、计时器和计数。跨副本总体限流需网关按身份/IP 配置。

部署须让代理透传流、禁缓冲和缓存，超时超过 60 秒，保留 Last-Event-ID。服务响应 `text/event-stream; charset=utf-8`、`Cache-Control: no-store`、`X-Accel-Buffering: no`、`X-Content-Type-Options: nosniff`。SSE 不压缩缓冲。访问日志、APM、错误上报不得记录查询串中的 ticket；应用在流控制器校验前遮蔽请求 URL，但代理发生在此前，必须单独配置访问日志仅记录路径。票据只保存在短时局部变量，禁止复制到路由、业务状态、localStorage/sessionStorage 或控制台输出。

B09 Docker 日志已有默认 1 MiB 总量、16 KiB 分块、64 KiB 未换行上限及脱敏；前端截断不是存储控制。当前日志随构建保留，无自动保留期任务；上线前应确定项目保留期/容量并监控数据库，不允许手动删除后复用 seq。后续清理必须有持久序号/封存机制。详见 B09 日志限制。

## 验证与回退

回归命令均通过新会话执行，防止 Runner 子进程测试发送 SIGTERM 影响调用者：

```bash
setsid -w corepack pnpm build
setsid -w corepack pnpm typecheck
setsid -w corepack pnpm test
# 专用回环 MySQL forgekit_test + Redis DB 15；启用前遵守集成安全门禁。
setsid -w corepack pnpm --filter @forgekit/api exec vitest run test/build-streams.integration.test.ts
```

共享 builds 队列的集成文件须串行执行（Vitest `--no-file-parallelism` 或分别执行），防止测试 Worker 消费其他用例的 job。

HTTP/组件测试覆盖鉴权、续传、终态、背压、权限和清理；集成用例验证真实数据库和 Redis、两个 API 实例和受控 Runner 日志。Docker 不可用的环境不能据此宣称真实 Docker 执行已验证。真实浏览器仍需验收 owner/viewer、网络断开、取消、会话到期、终态刷新、移动断点和键盘操作；jsdom 无真实布局。回退 API/console 即可，无数据库迁移，未消费票据 60 秒失效，已有构建/日志不受影响。
