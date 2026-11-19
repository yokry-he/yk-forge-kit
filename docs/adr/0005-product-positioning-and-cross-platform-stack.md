# ADR-0005: 产品定位、跨端技术栈与首批产品决策

- 状态：Accepted
- 日期：2026-11-19
- English title: Product positioning, cross-platform stack, and initial product decisions

## 背景

项目所有者已于 2026-11-19 确认采纳 [04-open-questions.md](../zh-CN/plan/04-open-questions.md) 中全部“推荐默认”。本 ADR 记录已采纳的决策，作为后续规划、架构与实现的基线，并将 ADR-0002 由 Proposed 转为 Accepted。

## 决策

### 1. 产品定位

一句话定位：**面向国内开发环境、从想法到上线的一体化平台**。

- 目标用户：开发者、项目经理、非技术用户。
- 核心承诺：生成可脱离平台独立维护的标准工程，并支持部署到用户自有云资源。

### 2. 跨端技术栈

| 端 | 技术选型 | 说明 |
|---|---|---|
| Web（控制台/后台） | Vue 3 + Vite + TypeScript + Pinia | 控制台采用 SPA。Nuxt 仅用于未来确有 SSR 或 SEO 需求的官网或文档站 |
| 小程序 + 移动 App + H5 | uni-app（Vue 3 + Vite） | 以同一套代码覆盖多端，App 端的 uni-app x 留待后续评估 |
| 桌面（Win/macOS/Linux） | Tauri 2 + Vue | 复用 Vue Web 或 H5 的构建产物，需深度集成 Node.js 时以 Electron 为备选 |
| 共享层 | TypeScript 业务逻辑与协议包 + 设计 Token | 跨端共享纯逻辑、协议和设计 Token |

业务 UI 由对应应用按目标端适配，通用组件由独立的 `yk-forge-ui` 仓库管理。MVP 聚焦 Web 项目创建、资产集成、构建与部署闭环，多端能力分阶段交付。

### 3. 首批产品决策（D-01 至 D-16）

| 编号 | 决策 | 采纳内容 | 决策与执行时点 |
|---|---|---|---|
| D-01 | 产品形态 | C. 先自用/私有化单租户，架构预留多租户，后续再开 SaaS | Phase 0 结束前（db 迁移预留 tenant_id） |
| D-02 | 控制面部署 | A. 用户自有阿里云/腾讯云主机 + 现有 MySQL | MVP 启动前 |
| D-03 | 云厂商支持 | C. SSH 部署同时支持阿里云和腾讯云，云 API 优先适配阿里云 | MVP 启动前（SSH）；V1 启动前（API 顺序） |
| D-04 | 跨端主力方案 | A. 采用 uni-app 作为小程序、移动 App 和 H5 的主力方案 | 技术选型已确认，V1 开始交付小程序和 H5 |
| D-05 | 后台管理模板组件库 | A. Element Plus | B05 开始前 |
| D-06 | Git 托管集成 | C. 集成 GitHub 和 Gitee，MVP 范围限于生成项目的推送或下载 | MVP 源码交付功能开发前确认是否提供推送，V1 启动前确认深度集成顺序 |
| D-07 | AI 模型与费用 | B. 用户自备 API 密钥（BYOK），默认 DeepSeek | V1 启动前 |
| D-08 | 非技术用户模式 | B. V1 提供非技术用户模式 | V1 规划前 |
| D-09 | 商业化/计费 | A. 暂不商业化，仅预留数据模型 | V2+ 规划前（MVP 仅预留字段） |
| D-10 | 开源许可证 | B. Apache-2.0 | 已执行：仓库根目录新增 `LICENSE`，各 package.json 声明 `"license": "Apache-2.0"` |
| D-11 | 33 个旧 PR 处理 | A. 将 `grok-dev` 合入 `main` 后关闭旧 PR | **已决策，暂缓执行。待 `grok-dev` 稳定后再合入 `main` 并关闭旧 PR。** |
| D-12 | 域名与 ICP 备案 | A. 用户使用自有域名并自行办理 ICP 备案，平台提供备案提醒且不代持域名 | MVP 部署功能开发前 |
| D-13 | iOS 账号与 Mac 构建机 | A. 用户自备 Apple 开发者账号 + 自建 Mac mini | V2+ 规划前（iOS 打包在 V2+ 交付） |
| D-14 | 预览环境形态 | A. MVP 仅静态产物预览（使用 `*.preview` 子域和带有效期的访问令牌） | MVP 构建/预览开发前 |
| D-15 | Artifact Store | A. MVP 本地磁盘/MinIO，V1 接 OSS/COS/S3（抽象存储接口） | B09 开始前 |
| D-16 | 轻量部署 Agent | A. V1 引入单二进制部署 Agent，通过 WebSocket 或 HTTPS 主动建立出站连接，采用 mTLS 和一次性注册令牌 | V1 启动前 |

### 4. ADR-0002 状态变更

ADR-0002（Vue 优先的第一版平台架构）由 Proposed 转为 **Accepted**。

## 替代方案

- **Taro**：小程序覆盖面较广，但生态偏向 React，与本项目的 Vue 优先路线契合度较低。
- **Flutter**：难以直接复用现有 Vue 界面，与团队技术栈和平台定位的契合度较低。
- **React Native**：React Native 的 UI 技术栈与 Vue 不同，难以直接复用现有 Vue Web 或 H5 界面。
- **Capacitor**：适合 Web 优先轻应用，作为可选目标而非主力；不覆盖小程序。
- **Electron 作为桌面主力**：体积大、内存占用高；仅在需要 Node 深度集成时作为 Tauri 备选。
- **各端分别选型**：会增加独立工程的维护成本，减少跨端代码复用。

## 后果

**正面**

- 技术栈统一在 Vue 生态，复用团队经验与资产。
- 覆盖国内主流小程序与移动端，契合目标用户。
- 生成标准工程、部署到用户自有云，降低锁定风险。
- 决策表明确执行时点，减少后续反复。

**代价**

- 依赖 DCloud 生态（uni-app），存在生态锁定与版本演进风险。
- iOS 打包需用户自备 Apple 账号与 Mac 构建机，交付门槛较高。
- 不同端的渲染和交互差异会增加 UI 适配与验证成本。
- 多租户、计费、Agent 等预留设计增加初期模型复杂度。

**风险**

- DCloud 生态变动可能影响小程序/App 交付节奏。
- Tauri 2 移动端生态较新，桌面为主、移动端不作为主力。
- D-11 暂缓执行期间旧 PR 可能干扰 CI，需在 `grok-dev` 稳定并合入 `main` 后尽快关闭。

## 后续

需要新增的 ADR：

- Runner 沙箱与隔离方案（对应 B09）。
- 部署 Agent 协议与安全模型（对应 D-16）。
- 密钥管理与信封加密（对应 D-07、D-16）。
- 多租户与授权模型（对应 D-01）。
- 预览环境与子域/证书方案（对应 D-12、D-14）。

相关文档：

- [开放问题与决策](../zh-CN/plan/04-open-questions.md)
- [路线图](../zh-CN/plan/03-roadmap.md)
- [架构蓝图](../architecture/blueprint.zh-CN.md)
- [ADR-0002: Vue 优先的第一版平台架构](./0002-vue-first-platform-architecture.md)
