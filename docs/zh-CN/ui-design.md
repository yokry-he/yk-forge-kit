# ForgeKit UI / UX 设计规范（初版）

设计参考：[SiteForge](https://github.com/yokry-he/yk-site-generator)。ForgeKit 为独立产品，仅继承视觉语言与有价值的交互模式。

## 已核实的 SiteForge 基础

SiteForge Web 使用 Vue 3、TypeScript、Vite、Vue Router、Tailwind CSS，采用语义化 CSS 变量与六套主题。默认深色背景约 `#09090b`，品牌色为紫色 `#8b5cf6` 与青色 `#22d3ee`。主题包括深色、明亮、纸质、薄荷、天空和樱花。

## ForgeKit 设计原则

- 使用语义化 Design Tokens，不在业务组件中大面积硬编码品牌色。
- 优先清晰的信息层级、操作反馈、响应式布局、键盘导航和可访问性。
- 保留 SiteForge 的科技感与轻量体验，但针对开发工作台重构导航和信息架构。
- 组件状态至少覆盖默认、悬停、焦点、禁用、加载、错误和空状态。
- 复杂功能（资产选择、构建流水线、部署配置）优先渐进披露，不以巨型弹窗承载所有流程。
- 深色及浅色主题都必须验证文本、图标和交互状态的对比度。
- 公共 UI 组件归 `yk-forge-ui`；业务组件留在当前业务模块。
- 不强制完全复制 SiteForge 的实现或组件代码；视觉一致性不等于技术耦合。

## 后续任务

在产品页面设计前，形成正式 Token 清单、组件 API、交互规范与关键页面原型；对 SiteForge 设计进行截图对照审查。此文档不表示这些组件或页面已经实现。
