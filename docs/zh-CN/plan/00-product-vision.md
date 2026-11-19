# YKForgeKit 产品愿景

状态：草案（Proposed）  
日期：2026-11-19

> 本文档为规划，不代表功能已实现；现状以代码和各功能文档为准。已实现能力的细节请参考 [../project-members.md](../project-members.md)、[../../adr/0004-identity-authorization-foundation.md](../../adr/0004-identity-authorization-foundation.md)、[../../architecture/blueprint.zh-CN.md](../../architecture/blueprint.zh-CN.md) 等文档。

## 1. 一句话定位

**YKForgeKit 是面向中国开发环境、从想法到上线的一体化平台：用模板与资产生成标准工程，云端构建、静态预览、一键发布到用户自己的阿里云/腾讯云主机，并在平台上完成日志与运维。**

平台计划将项目生成、构建、预览、发布、运维和协作纳入同一工作流。

- **生成**：从模板与资产（主题、路由、状态管理等）生成一个**标准、可脱离平台**的工程，而不是把用户锁进某个平台私有格式。
- **构建**：在云端隔离 Runner 中执行 `pnpm install` / `build`，产出可部署产物，构建日志实时可见。
- **预览**：每次构建产出带令牌、带过期时间的预览链接，先看效果再决定发布。
- **发布**：通过 SSH（MVP）或云厂商 API（V1）把产物发布到**用户自己的云主机**，原子切换、健康检查、失败回滚。
- **运维**：构建日志、部署日志、应用日志在线查看；V1 起提供采集、检索、监控与告警。
- **协作**：复用已实现的成员/角色/邀请体系（见 [../project-members.md](../project-members.md)），让项目经理看得见进度、预览链接与发布记录。

用户通过自己的云账号支付资源费用。平台负责跟踪工作流状态并记录审计事件。

## 2. 现状与愿景的边界

**已实现（代码存在，规划基线记录为 115 个单元测试通过；CI 已配置 MySQL 8 集成测试，真实 Keycloak 端到端验证仍待完成）**

- [apps/console](../../../apps/console)：Vue 3 + Vite + Pinia + Vue Router 控制台，含项目列表、创建向导（`/projects/new`，在浏览器预览文件计划，并通过 API 在 MySQL 登记项目配置。本地文件由 `forgekit create` 生成）、项目详情、资产中心（`/assets`）、OIDC 登录/回调、个人资料。
- [apps/api](../../../apps/api)：NestJS 模块化单体，含 health/ready、auth（whoami、account）、projects（列表/详情/创建）、project assets（含乐观并发 `expectedVersion`，冲突 409）、members、invitations（含撤销、审计、MySQL 限流）。
- [packages/contracts](../../../packages/contracts)：共享 DTO/契约，含 `forgekit.asset-verification` 报告与项目 `targets` 枚举（`web`、`h5`、`mobile`、`miniapp`、`desktop`，仅为契约字段）。
- [packages/project-core](../../../packages/project-core)：纯函数项目生成，当前仅 `vue-web` 模板（Vue 3 + Vite），可选 theme/router/pinia。
- [packages/asset-core](../../../packages/asset-core)：资产协议（Registry/Resolver/Installer Planner），内置 `official.theme`（1.0.0→1.1.0 可升级），支持安装/升级/卸载计划、`.forgekit/assets.lock.json` 指纹锁、漂移检测拒绝覆盖用户修改。
- [packages/cli](../../../packages/cli)：`forgekit` 本地 CLI，含 `create`、`asset list/plan/add/upgrade/remove/verify`，`verify` 输出机器可读校验报告。
- [packages/identity-core](../../../packages/identity-core)：OIDC 令牌验证（jose，固定 issuer/audience/HTTPS JWKS/算法白名单）+ 纯授权策略（owner/editor/viewer，默认拒绝）。
- [packages/db](../../../packages/db)：mysql2 + Drizzle，MySQL 8，迁移 0000–0007，不在启动时自动迁移。
- 本地开发 Keycloak（[compose.oidc.dev.yml](../../../compose.oidc.dev.yml)）、[compose.test.yml](../../../compose.test.yml) 临时 MySQL、GitHub Actions CI。
- 文档：`docs/zh-CN/*`、[ADR-0001](../../adr/0001-engineering-foundations.md)、[ADR-0002（草案）](../../adr/0002-vue-first-platform-architecture.md)、[ADR-0003](../../adr/0003-mysql-docker-storage.md)、[ADR-0004](../../adr/0004-identity-authorization-foundation.md)、[docs/architecture/blueprint.zh-CN.md](../../architecture/blueprint.zh-CN.md)(Proposed)。

**蓝图中已规划但未实现**：`apps/worker`、Redis + BullMQ、隔离 Runner、Artifact Store、`adapters/deploy-aliyun|deploy-ssh|build-web`、Builds/Deployments/AI 模块、组织/多租户、Tauri 2 桌面客户端、Nuxt 官网/文档站、独立公共 UI 仓库 `yk-forge-ui`、CLI 设备授权。

**尚未实现的产品能力**：构建流水线、预览环境、部署、日志、监控、告警、域名/HTTPS、计费、AI 生成、PM 视图、移动/桌面/小程序模板、组织/团队。

## 3. 目标用户画像

### 3.1 开发者（个人开发者、小团队全栈工程师）

- **典型场景**：为客户开发官网和后台管理系统，或独立开发工具站、博客；希望快速起项目、少配环境、能改源码、能部署到自己的云主机。
- **JTBD**：
  - 当我开始一个新项目时，我想用成熟模板和常用资产快速搭建标准工程，这样我不用从零搭脚手架。
  - 当我要上线时，我想把产物一键发到我的阿里云/腾讯云主机并看到日志，这样我不用手动 SSH、传文件、配 Nginx。
  - 当出问题时，我想在线看构建/部署/应用日志并回滚，这样我不用登录服务器排查。
- **痛点**：脚手架五花八门、版本漂移；CI/CD 配置成本高；云主机部署步骤琐碎易错；日志分散；担心被平台锁定。
- **YKForgeKit 如何帮助**：`project-core` 生成标准工程（可脱离平台）；`asset-core` 用锁文件 + 漂移检测管理资产升级；云端隔离 Runner 构建；SSH 发布器做原子切换与回滚；在线日志。用户可将标准工程纳入自己的代码仓库并独立维护。

### 3.2 项目经理（PM / 技术负责人）

- **典型场景**：同时跟进多个客户项目，需要知道每个项目当前进度、最新预览链接、最近一次发布是什么、谁改了什么。
- **JTBD**：
  - 当我要向客户或管理者汇报时，我想拿到最新预览链接和发布记录，这样我无需向开发人员索取。
  - 当我要控制风险时，我想知道谁有发布权限、生产发布是否需要审批，这样我能控制生产发布风险。
- **痛点**：进度靠问、预览链接靠开发临时发、发布记录散落在聊天记录、权限不清。
- **YKForgeKit 如何帮助**：复用已实现的成员/角色/邀请（owner/editor/viewer，见 [../project-members.md](../project-members.md) 与 [../../adr/0004-identity-authorization-foundation.md](../../adr/0004-identity-authorization-foundation.md)）；V1 起提供 PM 视图（需求清单/任务看板、里程碑进度、预览链接汇总、发布记录、发布审批），并把 `deploy:prod` 做成需审批的细粒度权限。

### 3.3 非技术普通用户（建站类：博客/个人站/官网）

- **典型场景**：希望在无需使用命令行的情况下搭建店铺、工作室或个人站点，并保留源码与数据的控制权。
- **JTBD**：
  - 当我想建站时，我想通过向导 + AI 对话 + 可视化配置完成，这样我不用学代码。
  - 当我想改内容时，我想让 AI 帮我写文案、生成页面区块，这样我不用找人。
  - 当我想上线时，我想一键发布并拿到域名 + HTTPS，这样我不用懂服务器。
- **痛点**：低代码平台锁定、导出困难；建站 SaaS 月费高且数据不在自己手里；不懂备案/域名/HTTPS。
- **YKForgeKit 如何帮助**：向导式创建 + AI 提案（diff 可审查后应用，复用资产 Installer Planner 的计划/确认模式）；发布到**用户自己的云主机**（数据与站点归用户）；平台提示 ICP 备案、协助域名与 HTTPS。非技术用户模式**规划在 V1**，MVP 不做。

## 4. 价值主张

1. **不锁定**：生成的是标准工程（Vue 3 + Vite / Nuxt / uni-app / Tauri 2 等），资产用 `.forgekit/assets.lock.json` 管理，可随时脱离平台自行维护。
2. **链路完整**：生成 → 构建 → 预览 → 发布 → 运维在同一平台闭环，减少工具切换与手工步骤。
3. **用户自有云资源**：发布到用户自己的阿里云/腾讯云主机，平台不托管云费用，数据与站点归用户。
4. **安全默认**：控制面与 Runner 强隔离、云凭证加密与最小权限、默认拒绝授权、全链路审计。
5. **诚实反馈**：构建成功、签名、上传、审核、发布是不同状态，平台如实呈现，不把「构建成功」说成「已上线」。
6. **Vue 优先、成熟稳定**：技术选型优先成熟稳定、低耦合，与 [../../architecture/blueprint.zh-CN.md](../../architecture/blueprint.zh-CN.md) 的「成熟稳定优先、模块化单体」原则一致。

## 5. 与现有工具类别的差异化

> 以下按**类别**描述，不针对具体产品做优劣评价。

| 类别 | 典型能力 | 与 YKForgeKit 的差异 |
| --- | --- | --- |
| 脚手架 / CLI 类 | 一条命令生成项目骨架 | YKForgeKit 也提供 CLI（[packages/cli](../../../packages/cli) 已实现 `create`/`asset`），但在此之上补齐云端构建、预览、发布、日志与协作；生成物同样是标准工程，CLI 可单独使用。 |
| 低代码 / 建站平台类 | 可视化搭建、托管运营、开箱即用 | YKForgeKit 不把用户锁进私有运行时；生成标准源码，发布到用户自己的云主机；非技术用户模式用向导 + AI 提案降低门槛，但底层仍是可导出的标准工程。 |
| 跨端框架类 | 一套代码多端（如 uni-app、Taro、Flutter 等） | YKForgeKit **不造新框架**，而是把成熟跨端方案（Vue 优先：uni-app 覆盖小程序+移动+H5，Tauri 2 覆盖桌面，Vue 3 + Vite / Nuxt 覆盖 Web）纳入模板与资产体系，并诚实说明「不承诺单一 UI 代码完美兼容所有端」（与蓝图一致）。 |
| 云厂商托管 / Serverless 平台类 | 托管运行、按量计费、绑定厂商 | YKForgeKit 发布到**用户自己的云主机**（阿里云 ECS / 腾讯云 CVM / 轻量应用服务器），平台无关；V1 再通过 Provider Adapter 调用云 API（云助手/TAT、安全组、DNS、证书），用最小权限凭证。 |
| 海外部署平台类（静态托管 / PaaS） | 推 Git 即部署、全球 CDN | YKForgeKit 面向中国开发环境，优先解决国内云主机部署、ICP 备案提示、面向国内开发者的 Git 托管集成（GitHub、Gitee 等）与国内模型提供商；部署目标是用户自有主机而非平台托管。 |
| 服务器面板类（如宝塔等） | 图形化管理服务器、装环境、建站 | YKForgeKit 是**从项目侧出发**的平台：管的是「项目 → 构建 → 发布 → 日志」，不替代服务器面板；SSH 发布器与面板可共存（面板管环境，YKForgeKit 管发布与回滚）。 |

## 6. 产品原则

1. **生成标准工程，不锁定**：模板产物是社区标准工程（Vue 3 + Vite / Nuxt / uni-app / Tauri 2 等），资产用锁文件管理，用户可随时脱离平台。
2. **预览先于操作**：任何发布前先有可访问的预览链接（MVP 为静态产物预览，带令牌与过期）；破坏性操作（升级资产、发布生产）先出计划（plan）再确认（apply），复用 `asset-core` 的 Installer Planner 模式。
3. **用户自有云资源**：发布到用户自己的阿里云/腾讯云主机，平台不托管云费用；云凭证加密存储、最小权限、短期凭证优先。
4. **安全默认**：控制面与 Runner 强隔离（Runner 不能访问控制面数据库）；默认拒绝授权（沿用 `identity-core`）；生产发布需 owner 或 deployer 权限；公网开放前完成网关限流。
5. **诚实状态反馈**：构建成功、签名、上传、审核、发布是不同状态；失败给可读原因；不把规划写成已实现。
6. **成熟稳定优先、低耦合**：不立即引入微服务/K8s/服务网格；模块化单体；新增能力以包/模块方式接入现有 `contracts`/`project-core`/`asset-core`/`identity-core`/`db`/`cli`/[apps/api](../../../apps/api)/[apps/console](../../../apps/console)。
7. **可审计**：部署、回滚、密钥读写、成员变更、邀请均留审计（已实现的成员/邀请审计见 [../project-members.md](../project-members.md)；后续扩展到部署与密钥）。
8. **Vue 优先、跨端诚实**：Web 用 Vue 3 + Vite（后台管理可基于成熟组件库，Element Plus 或 Naive UI 待定），SEO 站点用 Nuxt；小程序+移动+H5 用 uni-app；桌面用 Tauri 2；共享 TS 业务逻辑包 + 设计 Token；**不承诺**单一 UI 代码无条件完美兼容所有端。
9. **可演进**：MVP 按单租户自用部署设计，架构预留多租户、计费和私有化交付的扩展空间。
10. **AI 只出提案**：AI 产出变更提案（diff 可审查后应用），不直接改主分支；模型提供商可适配（DeepSeek、通义千问、OpenAI 兼容接口），用户可自带 Key。

## 7. 非目标（明确不做什么）

- **不做新跨端框架**：不自研渲染层/运行时，复用 uni-app、Tauri 2、Nuxt 等成熟方案。
- **不做平台托管运行时**：MVP/V1 不提供平台托管的 Serverless/容器运行时；发布目标是用户自有云主机。
- **不承诺「一份 UI 代码完美兼容所有端」**：与蓝图一致，跨端共享业务逻辑与设计 Token，UI 按端适配。
- **MVP 不做**：小程序/移动/桌面模板、AI 生成、计费、组织/多租户、PM 视图、Git 托管深度集成、iOS/macOS 构建、邮件发送（邀请目前无邮件，见 [../project-members.md](../project-members.md)）。
- **不做服务器面板替代品**：不替代宝塔类面板的环境管理职责；YKForgeKit 聚焦项目侧发布与运维。
- **不托管用户云资源费用**：平台不代付用户云主机/带宽/存储费用。
- **不做微服务/K8s/服务网格**（当前阶段）：遵循蓝图「模块化单体」原则。
- **不做「构建成功即上线」的误导性状态**：构建、签名、上传、审核、发布分状态呈现。

## 8. 成功指标

> 指标为规划目标，当前尚无对应功能，故无基线数据；Phase 0/MVP 落地后建立基线。

**MVP 阶段（静态 Web 项目闭环）**

MVP 复用成员与角色，验证从标准工程生成、云端构建和静态预览，到 SSH 部署至一台用户自有云主机的流程，并覆盖域名与 HTTPS、环境变量、回滚以及构建、部署和应用日志。Node 服务部署与容器预览安排在 V1。

- 从「创建项目」到「拿到可访问预览链接」的中位耗时 ≤ 10 分钟（含首次构建）。
- 从「点击发布」到「生产可访问」的中位耗时 ≤ 5 分钟（单台云主机、静态站）。
- 发布成功率 ≥ 95%（失败可自动回滚，回滚成功率 ≥ 99%）。
- 构建/部署/应用日志在线可查覆盖率 100%（MVP 范围内）。
- 真实 MySQL 8 + Keycloak 集成测试在 CI 中稳定通过（Phase 0 验收项）。

**V1 阶段**

- 支持模板 ≥ 6 个（Web 后台、内容站/博客、官网、SPA 工具站、uni-app 小程序+H5、Node 全栈）。
- 云 API 适配（先接入阿里云）覆盖：列实例、云助手下发、安全组检查、DNS、证书。
- 日志检索 P95 查询延迟 ≤ 3 秒（短期保留窗口内）。
- AI 提案采纳率（应用 diff 的比例）作为质量指标持续跟踪。
- PM 视图覆盖：预览链接汇总、发布记录、发布审批。

**长期（V2+）**

- 私有化部署版本可交付。
- 计费/配额数据模型落地（免费额度 + 按构建分钟/存储/AI token 计量）。
- 插件市场/第三方资产接入。

## 9. 与其他规划文档的关系

- 能力地图与模块划分见 [01-capability-map.md](./01-capability-map.md)。
- 技术架构与选型细节见 [02-technical-architecture.md](./02-technical-architecture.md)。
- 分阶段路线图与近期 backlog 见 [03-roadmap.md](./03-roadmap.md)。
- 待用户决策项与风险见 [04-open-questions.md](./04-open-questions.md)。
- 已实现能力的权威描述见 [../project-members.md](../project-members.md)、[../../adr/0004-identity-authorization-foundation.md](../../adr/0004-identity-authorization-foundation.md)、[../../architecture/blueprint.zh-CN.md](../../architecture/blueprint.zh-CN.md)。
