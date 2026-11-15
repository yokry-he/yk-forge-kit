# ADR-0002: Vue 优先的第一版平台架构

- 状态：Proposed
- 日期：2026-11-15
- English title: Vue-first platform architecture

## 背景

用户明确偏好 Vue 技术栈，要求成熟稳定、低耦合、适度抽象，Web/CLI/桌面多入口协同，并以 SiteForge 的 UI/UX 为视觉参考。

## 决策提案

1. 第一阶段 Web 控制台采用 Vue 3 + Vite + TypeScript + Pinia。
2. Nuxt 仅用于未来确有 SSR/SEO 需求的官网/文档站，不让管理控制台为不需要的 SSR 承担复杂度。
3. API 优先采用 NestJS 模块化单体；长时任务由独立 Worker 与隔离 Runner 处理。
4. pnpm Workspace 是初始工作区；当多包任务图与缓存收益得到验证后再增加 Turborepo。
5. 共享的纯逻辑与协议使用 TypeScript 包，业务 UI 留在对应应用；通用组件使用独立 `yk-forge-ui` 仓库。
6. 第一阶段聚焦 Web 项目创建、资产集成、构建与阿里云/自有服务器部署；多端逐步扩展。

## 替代方案

- 控制台全面采用 Nuxt：SSR/SEO 能力较强，但登录后工作台首期用不到主要优势。
- 开始即微服务：可独立伸缩，但增加分布式一致性、可观测性和本地调试成本。
- 全部组件放进 ForgeKit Monorepo：研发便利，但与已确认的独立组件库治理目标不符。
- 所有跨端统一 UI 实现：不同渲染模型限制较多，易牺牲原生体验和可维护性。

## 后果

优点是可继承 Vue 经验、缩小首期复杂度、保留扩展能力。代价是未来增加 Nuxt 或不同跨端 UI 框架时需维护适配层。

本 ADR 仍为提案；在用户确认具体架构和验证关键风险后再改为 Accepted。
