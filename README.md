# YKForgeKit

[简体中文](#简体中文) | [English](#english)

## 简体中文

YKForgeKit 是面向开发者的一体化项目创建、资产组合、跨端构建与发布平台。

> 项目处于架构设计阶段，尚未提供可运行的正式平台。

- 产品入口：Web 控制台、本地 CLI、桌面客户端（分阶段实施）
- 前端方向：Vue 3 + TypeScript
- 资产模式：共享运行时包 + 可定制业务源码
- 设计参考：[SiteForge](https://github.com/yokry-he/yk-site-generator)，但独立开发与演进

### 产品规划（草案）

- [产品愿景](docs/zh-CN/plan/00-product-vision.md)
- [能力地图（MVP / V1 / V2+）](docs/zh-CN/plan/01-capability-map.md)
- [技术架构规划](docs/zh-CN/plan/02-technical-architecture.md)
- [路线图与近期待办](docs/zh-CN/plan/03-roadmap.md)
- [待决策事项、风险与假设](docs/zh-CN/plan/04-open-questions.md)

### 项目文档

- [工程规则（AI/贡献者）](AGENTS.md)
- [架构方向与待决策事项](docs/zh-CN/architecture.md)
- [工程规范](docs/zh-CN/engineering.md)
- [测试与质量门禁](docs/zh-CN/testing.md)
- [UI / UX 规范](docs/zh-CN/ui-design.md)
- [项目模板注册表](docs/zh-CN/project-templates.md)
- [构建队列与 Worker（B08 空构建）](docs/zh-CN/worker-build-queue.md)
- [Docker 构建 Runner 与本地制品（B09）](docs/zh-CN/docker-build-runner.md)
- [静态预览与链接管理（B11）](docs/zh-CN/preview-links.md)
- [文档与翻译策略](docs/zh-CN/documentation.md)
- [架构决策记录](docs/adr/0001-engineering-foundations.md)（产品定位与跨端技术栈见 [ADR-0005](docs/adr/0005-product-positioning-and-cross-platform-stack.md)）
- [仓库保护配置建议](docs/zh-CN/repository-governance.md)

许可证：[Apache-2.0](LICENSE)。

目前以中文文档为权威版本，待关键方案稳定后逐步补齐英文，正式对外发布前确保核心用户文档双语可用。

## English

YKForgeKit is a planned developer platform for project creation, composable assets, cross-platform builds, and deployment.

> The project is in the architecture-design phase; there is no production-ready application yet.

- Planned interfaces: Web console, local CLI, and desktop client (delivered in phases)
- Frontend direction: Vue 3 + TypeScript
- Asset strategy: shared runtime packages plus editable business-feature source code
- Visual and interaction reference: [SiteForge](https://github.com/yokry-he/yk-site-generator), developed independently

**Product plan (draft, Chinese):** see [docs/zh-CN/plan/](docs/zh-CN/plan/00-product-vision.md) for vision, capability map, technical architecture, roadmap, and open questions.

**License:** [Apache-2.0](LICENSE).

**Documentation status:** Simplified Chinese is currently the source of truth. English documentation will be added as the architecture stabilizes; core user-facing guides will be bilingual before public release. See the Chinese [documentation policy](docs/zh-CN/documentation.md).

B12 自有 Linux 主机静态 SSH 发布、主机公钥固定、密钥加密、部署日志和手动回滚见 [中文指南](./docs/zh-CN/ssh-deploy.md)；Docker sshd 集成使用独立 CI，无云凭据。
