# vue-admin：Vue 后台管理系统模板

状态：已实现（B05）。组件库按 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) 的 D-05 决策采用 Element Plus。

```bash
node packages/cli/dist/index.js create ops-console --template vue-admin
cd ops-console && pnpm install && pnpm dev
```

## 生成内容

| 模块 | 说明 |
| --- | --- |
| 技术栈 | Vue 3.5、TypeScript（strict）、Vite 7、Vue Router 4、Pinia 3、Element Plus 2（中文语言包）、@element-plus/icons-vue |
| 登录 | `/login` 页面带表单校验；模拟登录，任意非空用户名和密码都可登录，token 保存在 localStorage；全局路由守卫会把未登录用户跳转到登录页，并带上 `redirect` 参数 |
| 布局 | 侧边栏菜单（根据路由自动生成，可折叠）、面包屑、暗色模式切换、用户下拉（退出登录）；屏幕宽度小于 768px 时，侧边栏改为抽屉 |
| 页面 | 仪表盘（统计卡片 + 最近动态）、用户管理（搜索、分页、新增/编辑弹窗与表单校验、删除确认）、系统设置、404 |
| 数据 | `src/api/mock.ts` 提供带类型的模拟接口（含 300ms 延迟），新增、编辑、删除都会在内存中真实生效 |
| 构建 | `pnpm build` 会先执行 `vue-tsc --noEmit` 类型检查再打包；Element Plus 单独拆成一个便于长期缓存的 chunk |

## 接入真实后端

替换 `src/api/mock.ts` 中的函数实现，保持导出的类型和函数签名不变；再把 `src/stores/user.ts` 的 `login` 改为调用真实登录接口即可。生成的 README 中也有说明。

## 限制

- 登录只是前端模拟，**不提供任何安全保障**；接入真实后端前，不要用于生产环境。
- 暂不支持资产安装（`assetTarget: null`）：`official.theme` 资产的样式没有针对 Element Plus 设计。
- 尚未实现按钮级权限、多标签页、国际化切换；这些将以资产形式规划。

## 质量验证

- `packages/project-core` 单元测试：确认占位符已全部替换、依赖和路由守卫正确、必需页面齐全、不接受可选能力。
- `template-smoke` CI：对生成的项目执行真实的 `pnpm install` 和 `pnpm build`（含 vue-tsc 严格类型检查）。
- 开发时已用无头浏览器验证：登录跳转、仪表盘、用户管理，以及 390px 移动端布局均正常渲染，控制台没有运行时错误。
