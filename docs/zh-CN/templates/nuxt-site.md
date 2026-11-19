# nuxt-site：企业官网 / 博客模板

状态：已实现（B06）。遵循 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) 的内容站定位，模板边界与依赖说明见 [ADR-0006](../../adr/0006-nuxt-site-template.md)。

```bash
node packages/cli/dist/index.js templates
node packages/cli/dist/index.js create company-site --template nuxt-site
cd company-site
corepack pnpm install
corepack pnpm dev
```

需要 Node.js 22.22.3+（22.x）或 24.15+（24.x）与 pnpm 10（其他 Node.js 版本见生成的 `package.json` 的 `engines`）。CLI、API 项目创建校验与控制台向导共用模板注册表；此模板没有可选能力，暂不支持资产安装。

## 功能与目录

- Nuxt 4 + Vue 3 + 严格 TypeScript，`app/` 源码目录；支持 SSR 和 SSG。
- 首页、关于、联系、博客列表、文章详情和错误页；响应式导航与网格布局，键盘焦点样式。
- 每页 SEO meta、Open Graph、canonical；文章输出 `BlogPosting` JSON-LD。
- `content/blog/*.md` 经 marked 渲染，按日期倒序排列，包含标签筛选、阅读时长和上一篇 / 下一篇。
- `/sitemap.xml` 同时包含固定页面和全部文章；构建时扫描文件名并明确登记预渲染路由，较旧文章也会生成。
- `public/robots.txt` 可供搜索引擎发现站点地图。

## 添加文章

在 `content/blog/` 新建 `my-first-post.md`，对应 `/blog/my-first-post`：

```markdown
---
title: 我的第一篇文章
description: 一句话摘要
date: 2026-11-19
tags: [团队, 随笔]
---

## 正文标题

支持 **Markdown**、列表、链接和代码块。
```

标签也可以写成缩进的多行列表：

```yaml
tags:
  - 团队
  - "随笔"
```

文件名只允许小写字母、数字及中划线。`title` 和有效的 `YYYY-MM-DD` 日期必填；`description`、`tags` 可省略。frontmatter 解析器只支持 `title`、`description`、`date` 单行字段，以及 `tags` 的逗号分隔列表或上述多行列表；支持字段和标签的成对引号，不支持完整 YAML、多行文本字段、嵌套结构或标签内逗号。格式错误会带文章名抛错并使构建失败；不支持的行还会标明行号，不会被静默忽略。

新增或删除文件后重启开发服务器；发布前重新构建，文章、站点地图和静态页面会一同更新。Markdown 仅用于仓库维护者提供的可信内容；marked 不清洗 HTML，接入外部投稿时须先增加清洗处理。

## 站点配置与 SEO

在 `nuxt.config.ts` 中修改 `runtimeConfig.public.siteName` 和 `siteUrl`，或在构建前设置：

```bash
export NUXT_PUBLIC_SITE_NAME='我的企业'
export NUXT_PUBLIC_SITE_URL='https://www.example.org'
```

同时更新 `public/robots.txt` 的 Sitemap 地址。SSG 的 HTML、JSON-LD 与 sitemap 固化于生成时；部署后修改环境变量不会更新静态文件。SSR 构建也会预渲染固定页面和文章，因此修改站点配置或内容后需要重新构建。标题模板使用运行配置中的站点名称。

## 构建与部署

SSR 构建包含严格类型检查：

```bash
corepack pnpm build
node .output/server/index.mjs
```

将整个 `.output/` 部署到支持 Node.js 的主机，使用进程管理器与反向代理提供服务；`pnpm preview` 可在本地预览构建结果。

静态生成：

```bash
corepack pnpm typecheck
corepack pnpm generate
```

将 `.output/public/` 中的内容部署到 Nginx 或静态托管服务；首页为 `index.html`，文章为 `blog/<slug>/index.html`，站点地图为 `sitemap.xml`。静态托管不提供 Nitro 服务端接口，新增服务端功能后应选择 SSR 或单独提供后端。

## 边界与验证

联系表单只校验输入并通过 mailto 打开邮件客户端，没有消息接收服务。公司、团队、统计数字和联系方式均为示例，上线前须替换。

单元测试覆盖注册信息、关键文件和名称替换；CLI 测试核对落盘内容。CI 的 `template-smoke` 会安装真实依赖、运行 `build`（含 Nuxt 类型检查）和 `generate`，检查首页、全部示例文章、新增文章的 Markdown / frontmatter / JSON-LD，以及 sitemap 产物。尚未进行浏览器交互及多断点人工验收。

本文为简体中文权威文档；英文版尚待补齐，对外发布前需完成对应翻译。
