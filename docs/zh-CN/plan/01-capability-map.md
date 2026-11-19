# YKForgeKit 能力地图

状态：草案（Proposed）  
日期：2026-11-19

> 本文档为规划，不代表功能已实现；现状以代码和各功能文档为准。文中“已实现”严格对应仓库当前代码与测试事实（规划基线记录为 115 个单元测试通过；CI 已配置 MySQL 8 集成测试，真实 Keycloak 端到端验证仍待完成）。规划项以阶段标注（MVP / V1 / V2+），阶段定义见 [03-roadmap.md](./03-roadmap.md)，产品定位见 [00-product-vision.md](./00-product-vision.md)，技术选型见 [02-technical-architecture.md](./02-technical-architecture.md)，待决事项见 [04-open-questions.md](./04-open-questions.md)。

## 阅读说明

- **阶段**：`MVP`（Web 类项目闭环）、`V1`（全栈/多端/运维/协作增强）、`V2+`（移动打包、桌面、计费、私有化等）。
- **现状**：`已实现` / `部分` / `未开始`。`部分` 指底层协议或数据结构存在但面向用户的能力未打通。
- 产品名称统一为 YKForgeKit。现有技术标识符沿用 `@forgekit/*`、`FORGEKIT_*`。
- 已实现能力的细节可参考：成员与邀请 [../project-members.md](../project-members.md)、身份与授权 [../../adr/0004-identity-authorization-foundation.md](../../adr/0004-identity-authorization-foundation.md)、架构蓝图 [../../architecture/blueprint.zh-CN.md](../../architecture/blueprint.zh-CN.md)、工程基础 [../../adr/0001-engineering-foundations.md](../../adr/0001-engineering-foundations.md)、Vue 优先 [../../adr/0002-vue-first-platform-architecture.md](../../adr/0002-vue-first-platform-architecture.md)、MySQL Docker [../../adr/0003-mysql-docker-storage.md](../../adr/0003-mysql-docker-storage.md)。

---

## 1. 项目模板与生成

生成的是标准工程，可脱离平台独立开发与部署（不锁定）。当前 [project-core](../../../packages/project-core) 仅提供 `vue-web`，模板注册表及其元数据仍待实现。

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 模板注册表与元数据 | 模板类型、目标端（web/h5/mobile/miniapp/desktop）、可选能力（features）、版本 | MVP | 部分（仅单模板 `vue-web`，无元数据抽象，需重构） |
| Vue 3 + Vite SPA 工具站 | 纯前端工具类站点，可静态托管 | MVP | 已实现（`vue-web` 基础模板，可选 theme/router/pinia） |
| Vue 后台管理模板 | 基于成熟 Vue 组件库（Element Plus 或 Naive UI，待定），含布局/权限/示例页 | MVP | 未开始 |
| Nuxt 内容站（博客/个人站/官网） | SSR/SSG，SEO 友好，适合博客、个人站、企业官网 | MVP | 未开始 |
| 企业官网模板 | 营销页、多区块、响应式，可基于 Nuxt 或 Vue SPA | MVP | 未开始 |
| 全栈 Node API 模板 | NestJS 后端工程，配合前端模板形成全栈项目 | V1 | 未开始 |
| uni-app 模板（小程序、H5 和移动 App） | Vue 3 + Vite。V1 交付微信、支付宝等小程序与 H5，V2+ 扩展 App 打包 | V1 | 未开始 |
| Tauri 2 桌面模板 | Vue 前端 + Rust 壳，Windows/macOS/Linux | V2+ | 未开始 |
| 模板能力组合（features） | theme/router/pinia 等可选能力按模板声明 | MVP | 部分（仅 `vue-web` 支持 theme/router/pinia） |
| 项目创建向导 | 在浏览器预览文件计划，通过 API 登记项目配置，并提供本地创建命令 | MVP | 已实现（`/projects/new`，仅 `vue-web`；工程文件由本地 `forgekit create` 生成） |
| 生成结果可脱离平台 | 输出标准工程，含 README 与本地运行说明 | MVP | 已实现（`vue-web` 生成标准工程） |
| 模板版本与升级提示 | 模板升级后对既有项目的迁移建议 | V1 | 未开始 |

> 说明：[packages/contracts](../../../packages/contracts) 中项目 `targets` 枚举已含 `web、h5、mobile、miniapp、desktop`，但仅为契约字段，对应构建能力均未实现。

---

## 2. 资产中心

资产协议（Registry / Resolver / Installer Planner）独立于 Vue、NestJS 和文件系统。它为安装、升级和卸载生成计划，通过 `.forgekit/assets.lock.json` 保存文件指纹，并在检测到用户修改时拒绝覆盖。详见[资产协议](../assets.md)和[资产中心](../asset-center.md)。

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 资产协议（Registry/Resolver/Planner） | 计划式安装，纯函数，可测试 | MVP | 已实现（[packages/asset-core](../../../packages/asset-core)） |
| 内置主题资产 | `official.theme` 1.0.0→1.1.0 可升级 | MVP | 已实现 |
| 锁文件与漂移检测 | `.forgekit/assets.lock.json` 指纹；用户改动拒绝覆盖 | MVP | 已实现 |
| CLI 资产管理 | `asset list/plan/add/upgrade/remove/verify`，支持 `--dry-run`/`--yes` | MVP | 已实现（[packages/cli](../../../packages/cli)） |
| 控制台资产中心 | 浏览/查看资产与计划 | MVP | 部分（`/assets` 页面存在，能力受限于内置资产） |
| 多目标资产（web/h5/miniapp/desktop） | 资产按 target 声明适用端 | V1 | 未开始 |
| 资产校验报告回传 | CLI `verify` 输出机器可读报告（`forgekit.asset-verification`）供回传 | V1 | 部分（报告契约与 CLI 输出已实现，回传链路未打通） |
| 第三方/社区资产与插件市场 | 外部资产发布、审核、分发 | V2+ | 未开始 |

---

## 3. 实时预览

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 静态产物预览 | 构建产物上传预览存储，按项目+构建号经 `*.preview` 子域访问，带访问令牌/过期 | MVP | 未开始 |
| 预览链接在控制台展示 | 项目/构建详情展示可分享预览链接 | MVP | 未开始 |
| 带后端的容器预览环境 | PR/分支预览，闲置自动回收 | V1 | 未开始 |
| 小程序体验版二维码 | 微信 CI 预览生成体验版二维码 | V1 | 未开始 |
| 移动端 H5 预览 | uni-app H5 产物预览 | V1 | 未开始 |

> 现状澄清：创建向导展示的是文件计划。可访问的静态产物预览仍待实现。

---

## 4. 构建流水线

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 构建任务队列 | BullMQ + Redis，任务状态机（排队/运行/成功/失败/取消） | MVP | 未开始（Phase 0 先搭建任务队列与状态机） |
| 隔离 Runner | Docker 容器，非 root、资源限制、只读基础镜像、无控制面 DB 访问、出网白名单 | MVP | 未开始 |
| Web 构建执行 | `pnpm install` + `build`，产物收集 | MVP | 未开始 |
| 构建日志实时流 | SSE/WebSocket 实时回传构建日志 | MVP | 未开始 |
| Artifact Store | 阿里云 OSS / 腾讯云 COS / S3 兼容；MVP 可先本地磁盘或 MinIO | MVP | 未开始 |
| 构建缓存 | 依赖与构建缓存加速 | V1 | 未开始 |
| 多目标构建 | V1 构建 H5 和小程序，V2+ 评估 Android 和 Windows 构建 | V1 | 未开始 |
| macOS Runner | iOS/macOS 构建（自建 Mac mini 或云 Mac） | V2+ | 未开始 |
| 更强隔离 | gVisor/Kata/firecracker 评估 | V2+ | 未开始 |

> 蓝图原则：云端执行用户代码与控制面强隔离，Runner 不能访问控制面数据库（见 [../../architecture/blueprint.zh-CN.md](../../architecture/blueprint.zh-CN.md)）。

---

## 5. 多端目标

跨端推荐（Vue 优先）：Web 使用 Vue 3 + Vite 或 Nuxt，小程序、移动 App 和 H5 使用 uni-app，桌面使用 Tauri 2。跨端共享业务逻辑和设计 Token，UI 按端适配。

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| Web（SPA/后台管理） | Vue 3 + Vite | MVP | 部分（仅 `vue-web` 生成，无构建/预览/部署） |
| Web（SSR/SSG 内容站） | Nuxt，SEO 友好 | MVP | 未开始 |
| H5 | uni-app H5 产物 | V1 | 未开始 |
| 小程序（微信/支付宝等） | uni-app，官方 CI 上传（miniprogram-ci / minidev），提审需用户平台账号与密钥 | V1 | 未开始 |
| 移动 App（iOS/Android） | uni-app 打包；uni-app x 以后再评估 | V2+ | 未开始 |
| 桌面（Windows/macOS/Linux） | Tauri 2 + Vue；Electron 作备选 | V2+ | 未开始 |
| 共享 TS 业务逻辑包 + 设计 Token | 跨端复用 | V1 | 未开始 |
| 契约层 targets 字段 | `web、h5、mobile、miniapp、desktop` | — | 部分（仅契约字段，无对应构建） |

> 技术对比结论见 [02-technical-architecture.md](./02-technical-architecture.md)：Taro（React 优先，与 Vue 路线不完全契合）、Flutter（Dart，不能复用 Vue 资产，小程序不支持）、Capacitor（Web 包壳，可选目标）、Electron（成熟但体积大）、React Native（非 Vue）。

---

## 6. 部署

MVP 走 SSH 部署到用户自己的云主机（平台无关，阿里云 ECS、腾讯云 CVM、轻量应用服务器均适用）；V1 增加云厂商 API 适配与轻量部署 Agent。

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| SSH 部署目标管理 | 添加主机、平台生成密钥对、连通性检查、主机指纹固定 | MVP | 未开始 |
| SSH 发布器 | 上传产物到 `releases/<id>`，原子切换 `current` 软链接 | MVP | 未开始 |
| Web 服务器托管 | Nginx/Caddy 托管静态站 | MVP | 未开始 |
| 进程管理 | systemd 或 Docker Compose 管理 Node 服务 | V1 | 未开始 |
| 健康检查与自动回滚 | 失败自动回滚，保留最近 N 个版本可一键回滚 | MVP | 未开始 |
| 域名与 HTTPS | Caddy 自动证书或 acme.sh（Let's Encrypt）；DNS 需用户解析指向主机 | MVP | 未开始 |
| ICP 备案提醒 | 中国大陆主机绑定域名需备案，界面提示 | MVP | 未开始 |
| 环境变量与密钥 | 信封加密（主密钥来自 KMS 或部署环境），只写不读，按 dev/staging/prod 区分，部署注入，审计 | MVP | 未开始 |
| 云 API 适配（阿里云） | `@alicloud/*` OpenAPI：列实例、云助手、安全组、DNS、证书 | V1 | 未开始 |
| 云 API 适配（腾讯云） | `tencentcloud-sdk-nodejs`：列实例、TAT、安全组、DNSPod、证书 | V1 | 未开始 |
| 最小权限凭证 | RAM/CAM 子账号 AccessKey 或 STS 临时凭证 | V1 | 未开始 |
| 轻量部署 Agent | 单二进制，主动出站 WebSocket/HTTPS，无需入站端口；mTLS + 一次性注册令牌 | V1 | 未开始 |
| 全栈 Node 服务部署 | 反向代理 + 进程管理 + 环境变量注入 | V1 | 未开始 |

> 现状澄清：部署、域名、HTTPS 和部署环境变量均待实现。部署 Adapter 使用短期最小权限凭证为蓝图原则（[../../architecture/blueprint.zh-CN.md](../../architecture/blueprint.zh-CN.md)）。

---

## 7. 运行时运维

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 构建日志在线查看 | 实时流（SSE/WebSocket） | MVP | 未开始 |
| 部署日志在线查看 | 实时流 | MVP | 未开始 |
| 应用日志拉取 | 通过 SSH 拉取 journald/docker logs/文件 tail，只读、限速、短期保留 | MVP | 未开始 |
| 日志检索 | 部署 Agent 采集 → 平台存储（MySQL 分区表或 Loki；推荐 Loki 或阿里云 SLS/腾讯云 CLS 适配），按时间/关键词搜索 | V1 | 未开始 |
| 基础监控 | CPU/内存/磁盘/HTTP 探活 | V1 | 未开始 |
| 告警 | 邮件/企业微信/钉钉/飞书 webhook | V1 | 未开始 |
| APM / 错误追踪 | Sentry 兼容 | V2+ | 未开始 |

---

## 8. 协作

复用已实现的成员/角色/邀请；V1 增加组织/团队与 PM 视图。

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 角色模型 | owner/editor/viewer，默认拒绝 | MVP | 已实现（[packages/identity-core](../../../packages/identity-core)） |
| 成员管理 | 列表、Owner 调整 editor/viewer | MVP | 已实现（[apps/api](../../../apps/api) members 模块） |
| 一次性邀请码 | 32 字节随机、7 天、只存 SHA-256、撤销、审计、MySQL 限流（创建 10/小时，兑换 30/15 分钟） | MVP | 已实现（未实现邮件发送） |
| 权限定期复核 | 项目详情页定期复核权限 | MVP | 已实现（控制台） |
| 组织/团队/多租户 | 组织层成员与权限 | V1 | 未开始 |
| 更细权限 | 如 `deploy:prod` 需审批 | V1 | 未开始 |
| PM 视图 | 需求清单、任务看板关联 Git 提交/PR、里程碑进度、预览链接汇总、发布记录、发布审批 | V1 | 未开始 |

> 细节见 [../project-members.md](../project-members.md) 与 [../../adr/0004-identity-authorization-foundation.md](../../adr/0004-identity-authorization-foundation.md)。

---

## 9. AI 辅助创建（面向普通用户）

AI 只产出“变更提案”（diff 可审查后应用），不直接改主分支；复用资产 Installer Planner 的计划/确认模式。非技术用户模式（向导 + AI 对话 + 可视化配置）推荐 V1，MVP 不做。

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 自然语言 → 变更提案 | 描述需求 → 选模板+资产+生成页面/配置，diff 审查后应用 | V1 | 未开始 |
| 模型提供商适配 | DeepSeek、通义千问、OpenAI 兼容接口，用户可自带 Key | V1 | 未开始 |
| 非技术用户模式 | 向导 + AI 对话 + 可视化配置，不暴露命令行 | V1 | 未开始 |
| AI 文案/区块生成 | 帮写文案、生成页面区块 | V1 | 未开始 |
| 报错日志解释 | AI 解释构建/运行日志 | V1 | 未开始 |

---

## 10. Git 与代码托管集成

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 生成项目下载 | 下载生成的标准工程 | MVP | 部分（本地 CLI 可生成工程，控制台尚未提供下载） |
| 推送到 GitHub/Gitee（待决） | MVP 候选项，将生成项目推送到用户仓库 | MVP | 未开始 |
| Git 托管集成 | GitHub/Gitee/GitLab/Codeup/CODING 等，关联提交/PR | V1 | 未开始 |
| 分支/PR 预览联动 | 与容器预览环境联动 | V1 | 未开始 |

> MVP 是否提供推送以及 V1 集成顺序见 [D-06](./04-open-questions.md#1-需要用户决策的问题)。

---

## 11. 账号身份与安全审计

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| OIDC 登录 | `AUTH_MODE=oidc`（生产默认），固定 issuer/audience/HTTPS JWKS/算法白名单 | MVP | 已实现（[packages/identity-core](../../../packages/identity-core)，[apps/console](../../../apps/console) 登录/回调页） |
| 本地开发模式 | `AUTH_MODE=local` | MVP | 已实现 |
| 个人资料 | 展示名 | MVP | 已实现（`GET whoami`、`POST/PATCH account`） |
| 授权策略 | 默认拒绝，权限如 `member:read`、`asset:plan` | MVP | 已实现 |
| 审计 | 成员/邀请审计表 | MVP | 已实现（`project_member_audit`、`project_invitation_audit`） |
| 新增权限 | `build:run`、`deploy:*`、`secret:write`、`log:read` 等 | MVP/V1 | 未开始 |
| 生产强制 OIDC 检查 | 生产环境强制 OIDC | MVP | 部分（API 生产环境已拒绝 local 模式，完整部署验证仍待完成） |
| 网关限流 | 公网开放前完成网关限流 | MVP | 未开始（ADR-0004 已指出） |
| 云凭证加密存储 | 最小权限、短期凭证优先 | V1 | 未开始 |
| 部署/回滚/密钥读写审计 | 全量审计 | V1 | 未开始 |
| CLI 设备授权 | 本地 CLI 登录 | V1 | 未开始 |

> 现状澄清：CI 已配置 MySQL 8 集成测试，真实 Keycloak 端到端验证仍待完成；本地开发 Keycloak 见 [compose.oidc.dev.yml](../../../compose.oidc.dev.yml)（仅开发用）。

---

## 12. 计费与配额设想（V2+）

先设计数据模型，不承诺实现时间。

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| 免费额度 | 项目数、构建分钟、预览存储、日志保留天数 | V2+ | 未开始 |
| 计量 | 按构建分钟/存储/AI token | V2+ | 未开始 |
| 云资源费用边界 | 平台不托管用户云资源费用（用户自己的云账号付费） | V2+ | 未开始 |
| 私有化部署版本 | 支持私有化 | V2+ | 未开始 |

---

## 13. 入口

| 能力项 | 说明 | 阶段 | 现状 |
|---|---|---|---|
| Web 控制台 | Vue 3 + Vite + Pinia + Vue Router；项目列表/创建向导/详情/资产中心/OIDC 登录/个人资料 | MVP | 已实现（[apps/console](../../../apps/console)） |
| 本地 CLI | `forgekit create`、`asset list/plan/add/upgrade/remove/verify`（`--dry-run`/`--yes`） | MVP | 已实现（[packages/cli](../../../packages/cli)） |
| CLI 设备授权登录 | 本地 CLI 登录控制面 | V1 | 未开始 |
| 桌面客户端 | Tauri 2 | V2+ | 未开始 |
| 官网/文档站 | Nuxt | V2+ | 未开始 |
| 公共 UI 仓库 | `yk-forge-ui`（未创建） | V2+ | 未开始 |

---

## MVP 能力清单汇总

MVP 目标：静态 Web 项目闭环——模板生成 → 云端构建 → 静态预览 → SSH 部署到一台阿里云/腾讯云主机 → 域名+HTTPS → 环境变量 → 版本回滚 → 构建/部署/应用日志在线查看 → 成员角色复用。Phase 0 负责 MySQL 8 与 Keycloak 集成验证、模板注册表及构建任务骨架，作为 MVP 的前置工作。

**MVP 内（含已实现与待建）**

- 模板：`vue-web`（已实现）+ `vue-admin`、`nuxt` 内容站、企业官网（待建，共 3–4 个 Web 模板）；模板注册表重构（待建）。
- 资产中心：资产协议/锁文件/漂移检测/CLI 资产管理（已实现）；控制台资产中心（部分）。
- 构建：BullMQ+Redis 队列、Docker 隔离 Runner、Web 构建、构建日志实时流、Artifact Store（本地/MinIO 抽象）（待建）。
- 预览：静态产物预览链接（带令牌、过期）（待建）。
- 部署：SSH 目标管理（平台生成密钥对、连通性检查、指纹固定）、SSH 发布器（上传至 `releases/<id>`，原子切换 `current` 软链接）、Caddy 配置、健康检查与回滚、域名+HTTPS、ICP 备案提醒、环境变量/密钥（信封加密、只写不读、审计）（待建）。
- 运维：构建/部署日志实时流、应用日志 SSH tail（只读限速）、部署历史页面（待建）。
- 协作：角色/成员/邀请/审计/限流（已实现）；新增 `build:run`、`deploy:*`、`secret:write`、`log:read` 权限（待建）。
- 身份安全：OIDC/本地模式/授权策略/审计（已实现）；生产 OIDC 部署验证、网关限流（待完成）。
- 源码交付：本地 CLI 生成已实现，控制台下载待建，GitHub/Gitee 推送待 D-06 确认。
- 入口：Web 控制台（已实现，需扩展构建/预览/部署/日志页面）、CLI（已实现）。
- 数据模型：`environments`、`deploy_targets`、`builds`、`deployments`、`releases`、`secrets`、`log_streams` 表与迁移（待建）。
- 新增 `apps/worker`（待建）。

**MVP 外（明确不进 MVP）**

- 小程序/移动/桌面模板与构建（V1/V2+）。
- 云厂商 API 适配、轻量部署 Agent、日志检索与告警、PM 视图、AI 提案、Git 集成（V1）。
- 移动 App 打包签名、Tauri 桌面、iOS/macOS Runner、计费、私有化部署、插件市场、桌面客户端（V2+）。

> 时间估算（单人+AI 协作粗估，需标注为估算）：Phase 0 约 2–3 周，MVP 约 8–10 周，V1 约 3–4 个月，V2+ 估算 4–6 个月以上，详见 [03-roadmap.md](./03-roadmap.md)。最大风险为范围过大与单人开发带宽，见 [04-open-questions.md](./04-open-questions.md)。
