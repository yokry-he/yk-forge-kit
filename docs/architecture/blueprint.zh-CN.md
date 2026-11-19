# YKForgeKit 第一版技术架构蓝图

> 状态：Proposed（提案，待确认后转为 Accepted）  
> 日期：2026-11-15  
> 本文件描述规划，不代表代码已实现。

## 1. 架构目标

1. 以成熟稳定方案优先，减少不必要的工具和部署复杂度。
2. 采用低耦合、高内聚、适度抽象与清晰的依赖方向。
3. Web 控制台、CLI、未来桌面端共享领域协议和无 UI 核心逻辑，不强制共用全部界面。
4. 业务资产以运行时包 + 可修改源码的混合方式安装。
5. 云端执行用户代码与平台控制面强隔离。
6. 逐步实现多端、多云能力，不承诺“一份 UI 代码无条件完美兼容所有平台”。
7. UI 设计语言参考 SiteForge，公共、业务无关组件拟在独立 `yk-forge-ui` 仓库开发和发布。

## 2. 技术路线（第一阶段）

| 层 | 推荐技术 | 说明 |
| --- | --- | --- |
| Web 控制台 | Vue 3 + Vite + TypeScript | 管理工作台以登录后交互为主，首期不需要 SSR |
| Vue 状态管理 | Pinia | 仅管理客户端共享状态；服务端数据与缓存策略另议 |
| 官网/文档站 | Nuxt（后续） | SEO/SSR 需求出现时独立建设，不提前引入第二个前端应用 |
| API | NestJS + TypeScript | 优先模块化单体；业务模块明确 API 契约 |
| 数据 | 现有 Docker MySQL | 业务主数据库；初期采用 mysql2 + Drizzle ORM，迁移需显式审查与执行 |
| 队列 | Redis + BullMQ（有异步任务时） | 构建、部署、重试等耗时任务 |
| 工作区 | pnpm Workspace | 先利用原生工作区；任务规模需要时再引入 Turborepo |
| CLI | Node.js + TypeScript | 复用共享协议、资产解析与项目本地操作 |
| 构建 | 隔离 Runner | 与 API/数据库权限隔离，Linux 优先，后续补 macOS/Windows |
| 桌面 | Tauri 2 + Vue（后续） | 不纳入第一期交付 |
| 云部署 | Provider Adapter | 首期阿里云/标准服务器的有限目标，后续扩展 |
| 公共 UI | 独立 yk-forge-ui | 组件库的包边界、发布渠道另立 ADR |

**不立即引入：** 微服务、Kubernetes、服务网格、复杂事件总线、完整多云 IaC 编排。只有明确需求及可测量收益时才引入。

## 3. 模块边界

控制面中的 NestJS 模块：

- Identity：用户、组织、会话、权限。
- Projects：项目元数据、Git 仓库关联、环境。
- Assets：资产清单、版本、兼容性与依赖。
- Integration：安装计划、变更清单、升级和回滚记录。
- Builds：任务定义、调度、状态与产物元数据。
- Deployments：发布目标、凭证引用、版本、回滚状态。
- AI：模型提供商适配、任务会话、代码变更提案。

第一期优先实现 Projects、Assets、Integration 的最小闭环，以及 Web 项目构建与部署。模块之间只能通过公开接口协作，禁止跨模块直接读取内部数据访问层。

## 4. 运行时边界

- Web Console 与 CLI 通过版本化 API 与控制面通信。
- CLI 本地可执行项目初始化与资产安装的纯本地流程；云构建等功能才依赖在线 API。
- 控制面负责认证、项目元数据、资产目录、任务编排及审计。
- Worker 消费队列、调度 Runner；Runner 执行不可信项目构建，不能访问控制面数据库。
- Artifact Store 保存构建产物；数据库只存元数据与引用。
- 部署 Adapter 使用短期、最小权限凭证，执行前检查授权。

## 5. Monorepo 目录草案

```text
yk-forge-kit/
  apps/
    console/              # Vue + Vite
    api/                  # NestJS
    worker/               # 异步任务执行/Runner 调度
    docs-site/            # 可选；后续 Nuxt
  packages/
    contracts/            # API DTO、Manifest Schema、事件契约
    project-core/         # 框架无关的项目操作
    asset-core/           # 资产解析、兼容性、安装计划
    cli/                  # CLI
    config/               # ESLint/TSConfig 等工程配置
  adapters/
    deploy-aliyun/        # 后续
    deploy-ssh/           # 后续
    build-web/            # 后续
  docs/
    zh-CN/
    en/
    adr/
```

**目录不是强制预创建清单。** 仅在对应功能开始实现时建立目录。通用 UI 组件不放在本仓库的 `packages/ui`，而由独立的 `yk-forge-ui` 提供。

## 6. 依赖方向

`apps/*` 可以依赖 `packages/contracts`、`project-core`、`asset-core` 等公共包；核心包不得反向依赖应用。Adapter 实现由上层注入的接口，不将云厂商 SDK 传播到领域逻辑。

## 7. 资产安装闭环（目标）

1. 用户选择项目类型、目标端和能力。
2. Resolver 检查框架兼容、依赖版本、冲突与权限。
3. Integrator 生成可审查的文件/依赖/迁移变更计划。
4. 在隔离工作区执行更改，并验证类型、测试与构建。
5. 产出可追溯 Git Diff 和资产锁定记录，由用户确认提交。
6. 升级时三方比较；禁止覆盖用户修改或静默删除数据库数据。

## 8. 构建及发布边界

构建成功、产物签名、上传、平台审核、正式发布是不同状态。移动端及桌面端需要按目标系统配置构建/签名环境，小程序需要各自平台凭证及提审流程。第一期仅建立 Web 产物与单云部署的可验证闭环。

## 9. 验收准则（架构阶段）

- 能通过设计审查解释每个模块的所有权、输入、输出和依赖。
- 核心资产解析逻辑不依赖 Vue、NestJS 或云 SDK。
- 本地 CLI 关键操作不需要运行 Web 控制台。
- 非可信构建执行与控制面存在明确隔离方案。
- 关键架构选择可追溯到 ADR，并列出不选其他方案的理由。

## 10. 待决策清单

- 认证与多租户策略、API 契约格式；MySQL 与初期 Drizzle 实现已确定。
- 资产 Manifest Schema、锁文件及源代码合并策略。
- Runner 运行模式、缓存、产物存储与计费边界。
- UI 库的 Vue 组件与跨端 Token 包边界。
- 初版阿里云部署目标和运维职责。
- CI 的实际工具和必需检查名称。
