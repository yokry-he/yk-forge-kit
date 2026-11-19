# ADR-0006：Nuxt 内容站模板边界

- 状态：Accepted
- 日期：2026-11-19
- English title: Nuxt content-site template boundaries

## 背景与决策

B06 明确要求交付 Nuxt 4 企业官网 / 博客模板，落实 ADR-0005 对具有 SEO / SSR 需求内容站的选型。新增 `nuxt-site`，类型为 `content-site`，仅交付 Web；保持控制台的 Vue + Vite 路线。

沿用 project-core 的纯渲染器和统一注册表，文件以字符串嵌入，不把 Nuxt 或 marked 引入控制面运行时依赖。模板的组件留在模板内，不抽取到通用 UI 仓库。

生成项目使用 Nuxt ^4.1、Vue ^3.5、marked ^16、TypeScript ^5.9 与 vue-tsc ^3，Node.js 范围与本次实际安装的 Nuxt 4.6.4 对齐（`^22.22.3 || ^24.15.0 || >=26.0.0`）。Nuxt 和 Vue 维护 SSR、路由与类型集成；marked 仅负责 Markdown 转 HTML，均为 MIT 许可的成熟项目；TypeScript 为 Apache-2.0。Vue Router 的版本由 Nuxt 管理，避免重复声明较旧主版本导致类型插件不兼容。通过真实安装、严格类型检查和构建 / 生成冒烟验证版本兼容性。生成项目应保留首次安装的锁文件，依赖升级须复跑验证。

内容来自本地可信 Markdown；轻量 frontmatter 仅支持文档列出的单行字段与标签，不增加完整 YAML / CMS 依赖。marked 不清洗 HTML，外部投稿需要另加清洗边界。替换 Markdown 解析器局限于 `useBlog.ts`；引入 CMS 则需重新评估内容加载和 SSR / SSG 策略。

## 后果与权衡

- 标准 Nuxt 工程可脱离平台独立维护，支持 Node SSR 与静态托管。
- 文件名在构建配置中扫描，同时供预渲染与服务端 sitemap 使用；服务端无需读取部署目录中的 Markdown。
- 内容随构建打包，更新内容或预渲染页面的站点配置需要重新构建；静态部署不包含运行时服务端能力。
- Nuxt 构建成本较 Vite SPA 高，CI 对此模板运行 build 和 generate，扩大冒烟超时。
- 模板不提供 CMS、消息后端或通用资产兼容性，避免扩大 B06 范围。
