# YKForgeKit 待决策事项、风险与假设

状态：草案（Proposed）  
日期：2026-11-19

> 本文档为规划，不代表功能已实现；现状以代码和各功能文档为准。已实现能力可参考 [成员与邀请](../project-members.md)、[身份与授权 ADR](../../adr/0004-identity-authorization-foundation.md)、[架构蓝图](../../architecture/blueprint.zh-CN.md)；能力全景见 [01-capability-map.md](./01-capability-map.md)，技术方案见 [02-technical-architecture.md](./02-technical-architecture.md)，排期见 [03-roadmap.md](./03-roadmap.md)。

## 0. 阅读说明

- 本文记录待项目所有者确认的决策、主要风险、当前假设及决策流程。
- 编号规则：决策项 `D-xx`，风险项 `R-xx`，假设项 `A-xx`，便于在 ADR、Issue、PR 中互相引用。
- “需要在何时之前决定”以 [03-roadmap.md](./03-roadmap.md) 的阶段为锚点：Phase 0（巩固，约 2–3 周）、MVP（约 8–10 周）、V1（约 3–4 个月）、V2+（估算 4–6 个月以上，待定）。时间为单人 + AI 协作的粗估，非承诺。
- 项目所有者未另行决定时，按推荐方案推进，并在对应 ADR 中记录采纳依据。

---

## 1. 需要用户决策的问题

> **2026-11-19 更新：** 项目所有者已确认采纳下表全部“推荐默认”，决策记录见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md)。表格保留选项与影响分析，便于日后回溯。

| 编号 | 问题 | 选项 | 推荐默认 | 影响 | 需要在何时之前决定 | 决策状态 |
|---|---|---|---|---|---|---|
| D-01 | 产品形态：SaaS 公有云 / 私有化部署 / 两者兼顾 | A. 纯 SaaS；B. 纯私有化单租户；C. 先自用/私有化单租户，架构预留多租户，后续再开 SaaS | C | 决定 db 是否引入 tenant 维度、identity-core 授权模型是否加组织层、控制面部署方式；影响 MVP 全部数据模型 | Phase 0 结束前（决定 db 迁移是否预留 tenant_id） | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-02 | 控制面部署在哪 | A. 用户自己的一台阿里云/腾讯云主机 + 现有 MySQL；B. 托管云服务；C. 本地开发机先行 | A | 决定 CI/CD、备份、监控、域名/HTTPS 方案；影响运维成本与合规 | MVP 启动前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-03 | MVP 先支持阿里云还是腾讯云 | A. 仅阿里云；B. 仅腾讯云；C. SSH 方式两家同时支持，云 API 适配先阿里云 | C | SSH 部署本身平台无关，可同时覆盖 ECS/CVM/轻量；云 API 适配（V1）先做一家降低工作量 | MVP 启动前（SSH 部分）；V1 启动前（API 适配顺序） | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-04 | 跨端技术栈是否接受 uni-app 作为小程序 + 移动 + H5 主力方案 | A. 接受 uni-app；B. 改用 Taro；C. 各端分别选型 | A | 决定 project-core 模板注册表、asset-core target 扩展、V1 排期；Taro 与 Vue 路线契合度较低 | B02「ADR-0005 产品定位与跨端技术栈」完成前；V1 开始交付小程序和 H5 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-05 | 后台管理模板组件库 | A. Element Plus；B. Naive UI；C. 两者都出模板 | A（生态更大、文档与社区更成熟） | 决定 vue-admin 模板实现与资产设计；影响后续资产市场 | B05「新增 vue-admin 后台管理模板」开始前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-06 | Git 托管首选集成 | A. GitHub；B. Gitee；C. 两者都做，MVP 仅“推送/下载” | C（MVP 先支持把生成项目推送到 GitHub/Gitee 或仅下载） | 决定 OAuth App 申请、Webhook 设计、PM 视图关联提交的数据来源 | MVP 源码交付功能开发前确认是否提供推送；V1 启动前确认深度集成顺序 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-07 | AI 模型提供商与费用承担 | A. 平台统一采购；B. 用户自带 Key（BYOK），默认 DeepSeek；C. 混合 | B | 决定 AI 模块的密钥管理（复用信封加密）、计费模型、合规（数据出境） | V1 启动前（AI 提案属 V1） | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-08 | 非技术用户模式（向导 + AI 对话 + 可视化配置）优先级 | A. MVP 就做；B. V1 做；C. V2+ 做 | B | 影响 console 交互设计与 AI 模块排期；MVP 聚焦开发者 Web 闭环 | V1 规划前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-09 | 是否商业化 / 是否设计计费 | A. 暂不商业化，仅预留数据模型；B. V2+ 正式计费；C. 不做 | A（V2+ 先设计数据模型：免费额度、按构建分钟/存储/AI token 计量） | 决定是否引入计量表、配额校验中间件；影响 db 与 api 设计 | V2+ 规划前（MVP 仅需预留字段） | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-10 | 开源许可证 | A. MIT；B. Apache-2.0；C. AGPL-3.0；D. 核心开源 + 企业版 | B（Apache-2.0，含专利授权，利于商业友好） | 决定仓库 LICENSE、第三方依赖合规审查、私有化交付条款 | 首次公开发布前（不阻塞开发） | ✅ 已决策（2026-11-19）：Apache-2.0，已添加 [LICENSE](../../../LICENSE) |
| D-11 | 33 个旧 PR 的处理 | A. grok-dev 合并 main 后关闭旧 PR；B. 逐个 review 挑选；C. 全部关闭重开 | A | 影响仓库历史整洁度与协作效率；避免长期悬挂 PR 干扰 CI | Phase 0 内（尽快） | ✅ 已决策（2026-11-19）：采纳 A，**暂缓执行**——待 grok-dev 稳定后再合入 main 并关闭旧 PR |
| D-12 | 域名与 ICP 备案主体 | A. 用户自有域名并自行备案；B. 平台代持域名；C. 仅 IP + 自签证书（不推荐） | A（平台提醒中国大陆主机绑定域名需 ICP 备案，不代持） | 决定 HTTPS 方案（Caddy 自动证书/acme.sh）、预览子域（*.preview）规划、合规责任划分 | MVP 部署功能开发前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-13 | iOS 开发者账号与 Mac 构建机 | A. 用户自备 Apple 开发者账号 + 自建 Mac mini；B. 云 Mac 服务；C. 暂不支持 iOS 打包 | A（V2+ 交付，MVP/V1 不做） | 决定 V2+ 移动 App 打包签名方案与成本；影响路线图 V2+ 范围 | V2+ 规划前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-14 | 预览环境形态 | A. MVP 仅静态产物预览（*.preview 子域 + 令牌/过期）；B. 直接上容器预览 | A（V1 再上带后端的容器预览、PR/分支预览、闲置回收） | 决定预览存储、子域与证书、访问控制设计 | MVP 构建/预览开发前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-15 | Artifact Store 选型 | A. MVP 本地磁盘/MinIO，V1 接 OSS/COS/S3；B. MVP 直接上 OSS/COS | A（抽象存储接口，便于切换） | 决定 worker 产物上传实现与成本；影响预览服务读取路径 | B09「Docker 隔离 Runner（Web 构建）」开始前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |
| D-16 | 是否引入轻量部署 Agent（V1） | A. 引入（单二进制、主动出站 WebSocket/HTTPS、mTLS + 一次性注册令牌）；B. 仅 SSH，不引入部署 Agent | A（V1，用于部署、日志采集、指标，免开放入站端口） | 决定 V1 日志检索/告警与监控实现路径；增加一个交付物 apps/agent | V1 启动前 | ✅ 已决策（2026-11-19）：采纳推荐默认，见 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) |

> 说明：D-01、D-02、D-03、D-12 相互关联，建议合并为一次“部署与形态”决策会，产出 ADR。D-04 在 B02 中确认，D-05 在模板开发前确认。D-06 和 D-07 按表中时点确认，并记录到对应 ADR。

---

## 2. 风险登记

| 编号 | 风险 | 可能性 | 影响 | 缓解措施 |
|---|---|---|---|---|
| R-01 | **范围过大**（Web + 小程序 + 移动 + 桌面 + 全栈 + AI + 计费 + 多租户同时推进） | 高 | 高 | 严格执行 MVP 边界（仅 Web 类项目闭环）；小程序/移动/桌面/AI/计费不进 MVP；每阶段结束复盘再扩范围；backlog 每项一个 PR 控制粒度 |
| R-02 | 单人开发带宽不足，进度延期 | 高 | 高 | 路线图标注为估算；优先做“可演示的最小闭环”；复用已实现模块（contracts/project-core/asset-core/identity-core/db/cli）；AI 辅助编码但人工把关 |
| R-03 | 构建沙箱安全（Runner 执行用户代码逃逸、挖矿、横向移动） | 中 | 高 | Docker 容器非 root、资源限制、只读基础镜像、无控制面数据库访问、出网白名单；后续评估 gVisor/Kata/firecracker；控制面与 Runner 强隔离（蓝图原则） |
| R-04 | 云凭证 / SSH 私钥泄露 | 中 | 高 | 信封加密（主密钥来自 KMS 或部署环境）、只写不读、最小权限、短期凭证优先；SSH 由平台生成密钥对、用户只加公钥；所有部署/回滚/密钥读写审计 |
| R-05 | 小程序/App 平台政策与审核不确定性（微信/支付宝/抖音等规则变化、提审被拒） | 中 | 中 | 上传用官方 CI 工具（miniprogram-ci、minidev），提审需用户自己的平台账号与密钥；诚实告知审核由平台决定；不承诺“一份 UI 代码无条件完美兼容所有平台” |
| R-06 | uni-app 生态锁定（DCloud）与长期可维护性 | 中 | 中 | 生成的是标准工程可脱离平台；共享 TS 业务逻辑包 + 设计 Token 降低耦合；App 端 uni-app x 仅评估不承诺；保留 Capacitor 作为 Web 优先轻应用备选 |
| R-07 | 国内合规（ICP 备案、数据安全、个人信息保护、数据出境） | 中 | 高 | 平台不代持域名、提醒备案；AI 按 D-07 采用 BYOK，并按模型提供商和部署区域核查数据处理与跨境要求；密钥与日志加密存储；私有化部署选项满足数据本地化 |
| R-08 | 真实环境端到端未验证（MySQL/Keycloak 集成测试需 Docker，尚无真实环境验证） | 高 | 中 | Phase 0 首要任务：真实 MySQL 8 + Keycloak 集成测试跑通并修复问题；在现有 MySQL 集成测试基础上增加 Keycloak 端到端覆盖 |
| R-09 | 生产安全基线待完善（网关限流待实现，生产 OIDC 部署待验证） | 中 | 高 | 公网开放前完成网关限流（见[身份与授权 ADR](../../adr/0004-identity-authorization-foundation.md)和[项目邀请](../project-invitations.md)）；验证生产 OIDC 配置并完善旧项目认领与迁移流程（B03「旧项目认领与迁移及生产 OIDC 验证」） |
| R-10 | 部署到用户主机的兼容性与回滚可靠性（不同发行版、Nginx/Caddy 差异、权限） | 中 | 中 | 原子切换 current 软链接、健康检查失败自动回滚、保留最近 N 个版本；连通性检查 + 主机指纹固定；文档化前置条件（systemd/Docker Compose） |
| R-11 | 成本失控（构建分钟、存储、AI token、云资源） | 中 | 中 | 计量数据模型先行；免费额度与配额，云资源由用户通过自有云账号付费；构建任务超时与并发限制 |
| R-12 | 旧 PR 与分支混乱导致 CI/合并冲突 | 中 | 低 | D-11 决策：grok-dev 合并 main 后关闭旧 PR；统一分支策略与 PR 模板 |
| R-13 | 关键依赖升级破坏（NestJS、Vue、Drizzle、jose、BullMQ 等） | 低 | 中 | 锁定版本、CI 跑单测（现有 115 个）+ 集成测试；小步升级；ADR 记录重大升级 |
| R-14 | 预览子域与证书管理复杂（*.preview 通配证书、过期令牌） | 低 | 中 | MVP 用带令牌/过期时间的静态预览；证书用 Caddy 自动签发或 acme.sh；子域规划写入技术架构文档 |

---

## 3. 当前假设清单

| 编号 | 假设 | 若不成立的影响 | 验证方式 / 时点 |
|---|---|---|---|
| A-01 | 用户（项目所有者）具备一台阿里云 ECS / 腾讯云 CVM / 轻量应用服务器，可 SSH 登录并具备 sudo 或 Docker 权限 | SSH 部署闭环无法演示 | MVP 部署功能开发前确认一台测试主机 |
| A-02 | 用户拥有可自行解析的域名，并理解中国大陆主机绑定域名需 ICP 备案 | HTTPS/域名功能受限，只能用 IP | D-12 决策时确认 |
| A-03 | 目标用户以 Vue 技术栈为主，接受生成标准工程（可脱离平台） | 模板与资产方向需调整 | 产品定位文档与早期用户反馈 |
| A-04 | 控制面可运行 Node 22+ 与 MySQL 8，Redis 可用于 BullMQ（MVP 构建队列） | 需改用其他队列或单机方案 | 技术架构评审 |
| A-05 | MVP 阶段构建并发低（单用户/小团队），Linux Runner 足够 | 需提前引入多 Runner 调度与配额 | 路线图复盘 |
| A-06 | 小程序/App 提审由用户自己的平台账号完成，平台只负责构建与上传 | 需申请平台代提审资质，合规成本上升 | V1 小程序功能规划前 |
| A-07 | AI 采用 BYOK（用户自带 Key），默认 DeepSeek，平台不统一采购 | 计费与合规模型需重做 | D-07 决策 |
| A-08 | 现有已实现模块（contracts/project-core/asset-core/identity-core/db/cli/apps/api/apps/console）可平滑扩展，无需重写 | 工作量显著增加 | 在 B04「project-core 模板注册表重构」和 B07「contracts + db 数据模型与迁移」中验证 |
| A-09 | 单人 + AI 协作的开发节奏可持续，路线图时间为粗估 | 排期需整体顺延 | 每阶段结束复盘 |
| A-10 | 私有化单租户先行、架构预留多租户，不会在 MVP 引入组织/团队复杂度 | 若 D-01 选纯 SaaS，db 与授权模型需提前加 tenant | D-01 决策 |
| A-11 | 预览与部署的访问控制可复用 identity-core 默认拒绝策略，新增 build:run、deploy:*、secret:write、log:read 等权限即可 | 需重新设计授权模型 | 在 B07「contracts + db 数据模型与迁移」和 B12「部署目标管理（SSH 主机）」中验证 |
| A-12 | 开源许可证为 Apache-2.0（D-10 已于 2026-11-19 确认），第三方依赖合规可接受 | 需替换不兼容依赖或调整许可策略 | 首次公开发布前 |

---

## 4. 决策流程说明

1. **提出**：任何决策项（D-xx）由维护者或用户发起，在本文档登记，标注影响范围与截止时点。
2. **讨论**：在对应 Issue 或文档中收集选项、利弊、与蓝图原则的一致性（成熟稳定优先、模块化单体、控制面与 Runner 隔离、不锁定用户源码等）。
3. **决策**：用户拍板；若无异议则按“推荐默认”执行，并在 ADR 中记录“默认采纳及理由”。
4. **落档**：每个已决策项写入 [docs/adr/](../../adr) 下的 ADR（编号递增，现有 0001–0005），状态从 Proposed 转 Accepted；本文件对应行更新为“已决策 → ADR-xxxx”。
5. **回溯**：若后续事实变化导致决策失效，新开 ADR 标注“Supersedes ADR-xxxx”，不直接改写历史 ADR。
6. **同步**：决策结果同步到 [00-product-vision.md](./00-product-vision.md)、[01-capability-map.md](./01-capability-map.md)、[02-technical-architecture.md](./02-technical-architecture.md)、[03-roadmap.md](./03-roadmap.md) 及 backlog，确保文档一致。
7. **节奏**：按决策表所列时点确认，涉及多阶段的决策分别在对应功能开工前确认。逾期未决的按推荐默认推进，并在阶段复盘中复核。

> 关联文档：[00-product-vision.md](./00-product-vision.md)、[01-capability-map.md](./01-capability-map.md)、[02-technical-architecture.md](./02-technical-architecture.md)、[03-roadmap.md](./03-roadmap.md)、[架构蓝图](../../architecture/blueprint.zh-CN.md)、[ADR-0002](../../adr/0002-vue-first-platform-architecture.md)、[ADR-0003](../../adr/0003-mysql-docker-storage.md)、[ADR-0004](../../adr/0004-identity-authorization-foundation.md)。
