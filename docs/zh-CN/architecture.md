# 架构方向与待决策事项

## 已确认

- YKForgeKit 是独立的新项目，SiteForge 仅作为视觉与交互参考。
- 产品入口规划为 Web 控制台、CLI、桌面客户端，分阶段交付。
- Web 前端以 Vue 3 + TypeScript 生态为优先路线。
- 支持 Web/H5、移动 App、小程序、桌面端项目与多云部署，但不承诺单一 UI 代码完美兼容所有端。
- 采用混合资产体系：基础组件/SDK 可发布为依赖包，业务能力以可修改源码集成。
- 公共 UI 组件独立于 YKForgeKit 业务项目，拟使用 `yk-forge-ui` 仓库。
- 以成熟稳定、低耦合、适度抽象、可测试及可替换为基础约束。

## 2026-11-19 已定案（见 ADR-0005）

- Web 控制台采用 Vue 3 + Vite（ADR-0002 已 Accepted）；Nuxt 仅用于需要 SEO 的官网/内容站。
- API 采用 NestJS 模块化单体，持久化为 MySQL 8 + Drizzle（ADR-0003），队列规划为 Redis + BullMQ。
- 跨端：小程序 + 移动 App + H5 采用 uni-app（Vue 3），桌面采用 Tauri 2 + Vue。
- 先私有化单租户、架构预留多租户；后台管理模板采用 Element Plus；许可证 Apache-2.0。

详见 [ADR-0005](../adr/0005-product-positioning-and-cross-platform-stack.md)。

## 仍待定案

- UI 组件库（`yk-forge-ui`）的包布局、发布渠道及多端范围。
- CLI/核心 SDK/Runner 的内部边界与 Runner 沙箱方案。
- 生产 OIDC 提供方、多租户隔离模型细节、云部署适配层及成本模型。

以上事项应通过需求约束、验证原型及 ADR 决定，避免把初步讨论当成实现承诺。

## B07 数据基础

迁移 0008 已新增构建、日志分块、预览链接及最小部署关联表，见 [构建数据模型](./build-data-model.md) 与 [ADR-0007](../adr/0007-build-data-foundation.md)。目前只交付 contracts/db 及仓库测试；Worker、Runner、SSE、预览和部署服务按 B08–B15 后续实现。
