# B11 实施与验证记录

B11 已在 `feat/b11-static-preview-links` 完成。未执行 git add、commit、checkout、rebase 或其他 git 写命令，未创建提交/合并。动机是为已有成功模板构建提供有期限、可撤销的静态预览，并在控制台完成创建与管理闭环。

实现包含 OIDC 项目权限、TTL 校验、共享限流、原子审计、独立 HTTP 进程、每链接 origin 隔离、受保护的制品读取、CSP 与日志脱敏。采用凭证子域名根路径，使现有 Vue/Nuxt 资源和路由无需改写；需要独立域、通配 DNS/TLS，以及 DNS/SNI/代理日志脱敏。选择理由、风险与回滚见 [ADR-0009](../adr/0009-build-and-preview-security-model.md) 和 [预览指南](./preview-links.md)。

## 外部草稿处理

先将给定 JSON 中的四份控制台草稿和中文文档写入仓库，再对照实际 contracts、API client、OIDC 认证和测试约定修正。下列百分比为相对原稿的近似行改动比例，不是测试覆盖率。

| 原稿/落地文件 | 分类 | 约改动 |
| --- | --- | --- |
| `apps/console/src/api/preview-links.ts` | 重写：使用 projectRequest 与严格共享契约 | 97% |
| `apps/console/src/components/builds/PreviewLinkPanel.vue` | 重写：真实权限、异步竞态、一次性 URL、错误处理和现有样式 Token | 90% |
| `apps/console/test/preview-links-api.test.ts` | 重写：真实参数/响应模型、泄漏拒绝与客户端约定 | 99% |
| `apps/console/test/preview-link-panel.test.ts` | 重写：组件交互、凭证生命周期、撤销界面行为与权限 | 99% |
| `docs/zh-CN/preview-links.md`（docs_zh） | 修改：修正 URL/进程/部署/安全模型和实际能力描述 | 约 70% |

保留原样：无。原稿中的全局令牌变量、独立 fetch 认证、虚构前缀/响应形状、硬编码测试凭证模型均未沿用。

## 最终验证

按要求配置 Corepack 缓存环境；下表不包含凭证或本地绝对路径。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm build` | 0 | 全仓编译通过 |
| `pnpm typecheck` | 0 | 严格类型检查通过 |
| `pnpm test` | 0 | 484 passed / 18 skipped；跳过项为需要显式外部环境的用例 |
| `pnpm db:migrations:check` | 0 | 新增迁移与快照一致 |
| `pnpm test:startup` | 0 | 干净源码启动检查 2 项通过 |
| `pnpm db:test:integration` | 0 | MySQL 迁移、基础仓库与 B07 仓库集成共 3 项通过 |
| `pnpm --filter @forgekit/api exec vitest run --no-file-parallelism test/preview-links.integration.test.ts test/build-queue.integration.test.ts test/build-streams.integration.test.ts test/mysql-project-flow.test.ts test/oidc-http.mysql.test.ts test/project-claim.mysql.test.ts` | 0 | API 集成 9 项通过，包含 B11 fixture 制品 HTTP E2E |
| `git diff --check` | 0 | 无 diff 空白错误 |

数据库验证仅使用新建的一次性 MySQL 8.0.45 与 Redis 实例，监听回环，固定 forgekit_test 库/账号及 Redis DB 15，沿用现有 opt-in 安全 gate。结束时只停止本次创建的子进程。

初轮检查发现并修复了服务端/组件类型错误、测试 mock 生命周期问题，以及 ArtifactStore 抽包后编译产物绕过 B09 文件系统 mock 的问题；既有测试没有降级或跳过。初始依赖安装因缓存只读/离线元数据缺失失败，改用临时可写缓存和存储后成功，锁文件仅增加新 workspace 包的关联。

未验证：当前环境无法访问 Docker socket，sudo 被环境禁止，未重新执行 B09 的真实 Docker Runner 用例；CI 原有 Docker Job 保留。未进行真实浏览器、生产 DNS/TLS 或生产反向代理联调。B11 E2E 使用真实制品存储与 HTTP fixture，不依赖 Docker。关键中文指南已更新，英文待翻译，对外发布前须补齐。

## 影响与回滚

新增 0010 审计表迁移和 creation response 的 url 字段；B07 链接持久化字段不变。ArtifactStore 因网关/Worker 的真实复用抽包，Worker 原导入保留兼容。CSP 只支持自身资源，外部 API/脚本等可能不可用；HTML 缓冲限制为 8 MiB。链接撤销仅影响后续请求，不能收回已下载内容。

回滚时停用创建入口与预览进程/路由，保留制品、链接和审计；通常无需删除新增审计表或回退 B07 数据。部署前按指南配置独立域、TLS、只读制品访问与最小权限数据库账号。

## 文件清单

共 49 个新增/修改文件（含本报告）：

- `.env.example`
- `.github/workflows/ci.yml`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/app.module.ts`
- `apps/api/src/invitation-rate-limiter.ts`
- `apps/console/src/views/BuildDetailPage.vue`
- `apps/console/test/build-pages.test.ts`
- `apps/worker/package.json`
- `apps/worker/src/artifact-store.ts`
- `docs/adr/0009-build-and-preview-security-model.md`
- `docs/zh-CN/architecture.md`
- `docs/zh-CN/build-console.md`
- `docs/zh-CN/build-data-model.md`
- `docs/zh-CN/docker-build-runner.md`
- `docs/zh-CN/mysql-integration-testing.md`
- `docs/zh-CN/plan/01-capability-map.md`
- `docs/zh-CN/plan/02-technical-architecture.md`
- `docs/zh-CN/plan/03-roadmap.md`
- `docs/zh-CN/worker-build-queue.md`
- `packages/contracts/src/builds.ts`
- `packages/contracts/test/builds.test.ts`
- `packages/db/drizzle/meta/_journal.json`
- `packages/db/src/build-repository.ts`
- `packages/db/src/schema.ts`
- `packages/identity-core/src/index.ts`
- `packages/identity-core/test/permissions.test.ts`
- `pnpm-lock.yaml`
- `apps/api/src/preview-artifacts.service.ts`
- `apps/api/src/preview-config.ts`
- `apps/api/src/preview-links.controller.ts`
- `apps/api/src/preview-links.service.ts`
- `apps/api/src/preview-main.ts`
- `apps/api/src/preview-server.ts`
- `apps/api/src/preview-tokens.ts`
- `apps/api/test/preview-links.integration.test.ts`
- `apps/api/test/preview-links.test.ts`
- `apps/api/test/preview-server.test.ts`
- `apps/console/src/api/preview-links.ts`
- `apps/console/src/components/builds/PreviewLinkPanel.vue`
- `apps/console/test/preview-link-panel.test.ts`
- `apps/console/test/preview-links-api.test.ts`
- `docs/zh-CN/b11-implementation-report.md`
- `docs/zh-CN/preview-links.md`
- `packages/artifact-store/package.json`
- `packages/artifact-store/src/index.ts`
- `packages/artifact-store/tsconfig.json`
- `packages/db/drizzle/0010_b11_preview_link_audit.sql`
- `packages/db/drizzle/meta/0010_snapshot.json`
