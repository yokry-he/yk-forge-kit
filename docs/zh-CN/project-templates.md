# 项目模板注册表

状态：已实现（B04）。模板由 `packages/project-core` 的注册表统一管理，CLI、API 和控制台创建向导都从这里读取，不再各自写死 `vue-web`。

## 模型

每个模板都有一份可序列化的元数据（`ProjectTemplateMetadata`）和一个纯函数渲染器：

| 字段 | 说明 |
| --- | --- |
| `id` | 模板 ID，例如 `vue-web`，保存在项目记录的 `template` 字段中 |
| `name` / `description` | 展示名称和用途说明 |
| `kind` | 产品类型：`web-app`、`admin`、`content-site`、`full-stack`、`miniapp`、`mobile`、`desktop` |
| `targets` | 交付端：`web`、`h5`、`mobile`、`miniapp`、`desktop`（与 `@forgekit/contracts` 一致） |
| `stack` | 技术栈说明，例如 `Vue 3 · TypeScript · Vite` |
| `features` / `defaultFeatures` | 用户可勾选的能力及默认值；不同模板可以提供不同的能力 |
| `builtIn` | 模板固定包含的能力（不可取消），例如后台模板自带路由和状态管理 |
| `assetTarget` | 兼容的资产目标（当前为 `vue-web`），不支持资产时为 `null` |
| `commands` | 生成后在项目目录中执行的命令 |

公开 API：`listProjectTemplates()`、`getProjectTemplate(id)`、`isProjectTemplateId(value)`、`createProjectPlan(options)`、`renderProjectFiles(options)`。返回的元数据都是副本，调用方修改它不会影响注册表。

## 当前模板

| ID | 名称 | 类型 | 说明 |
| --- | --- | --- | --- |
| `vue-web` | Vue Web 应用 | web-app | Vue 3 + Vite 单页应用，可选 theme / router / pinia |
| `vue-admin` | Vue 后台管理系统 | admin | Vue 3 + Element Plus 后台，详见 [vue-admin 模板](./templates/vue-admin.md) |
| `nuxt-site` | Nuxt 企业官网 / 博客 | content-site | Nuxt 4 + Markdown，支持 SSR / SSG、SEO 与站点地图，详见 [nuxt-site 模板](./templates/nuxt-site.md) |
| `uniapp` | uni-app 跨端应用 | miniapp | Vue 3 + TypeScript + Vite，H5 / 小程序 / 移动端，详见 [uniapp 模板](./templates/uniapp.md) |

后续计划：V2 的 Tauri 2 模板。

## 使用

```bash
node packages/cli/dist/index.js templates                     # 查看全部模板
node packages/cli/dist/index.js create my-app --template vue-web --features theme,router
```

不传 `--features` 时使用模板默认能力；传 `none` 表示不启用任何可选能力。控制台的创建向导会列出全部模板，切换模板时能力会重置为该模板的默认值。

## 新增模板的步骤

1. 在 `packages/project-core/src/` 新建渲染器文件（纯函数，只返回 `路径 → 内容`，不访问文件系统）。
2. 在 `types.ts` 的 `ProjectTemplateId` 中加入 ID，在 `registry.ts` 中登记元数据。
3. 运行 `pnpm test`：注册表测试会检查每个模板的元数据完整性、默认能力合法性、渲染结果确定性和路径安全。
4. 运行构建冒烟测试（会从 npm 安装真实依赖）：`FORGEKIT_TEMPLATE_SMOKE=1 pnpm --filter @forgekit/cli exec vitest run test/templates.test.ts`。CI 的 `template-smoke` Job 会对每个 PR 执行这项测试。
