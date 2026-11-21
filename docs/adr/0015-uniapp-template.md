# ADR-0015：uni-app 跨端模板边界

- 状态：Accepted
- 日期：2026-11-22
- English title: uni-app cross-platform template boundaries

## 背景与决策

B16 落实 [ADR-0005](./0005-product-positioning-and-cross-platform-stack.md) 的 D-04 选型，在统一注册表增加 `uniapp` 模板，`kind` 为 miniapp，交付目标为 h5 / miniapp / mobile。使用官方 Vue 3 + TypeScript + Vite CLI 工程风格，不引入 uni-app x，也不改变控制台技术路线。

沿用 project-core 的纯字符串文件映射渲染器；DCloud 依赖仅写入生成项目，不进入控制面依赖。首页、列表、个人页为原生文字 tabBar，详情为堆栈页；文字 tabBar 无需二进制图标，不改变渲染与落盘接口。业务组件保留在模板内。

固定官方 vite-ts 预设使用的 DCloud 版本 `3.0.0-5030420261029002`，Vue / @vue/runtime-core `3.4.21` 与编译器一致、Vite 固定为 `5.4.21`，@dcloudio/types `3.4.31` 与 uni-app peer 一致；TypeScript `5.9.3`、vue-tsc `3.1.5` 提供严格类型检查。DCloud / TypeScript 为 Apache-2.0，Vue / Vite / vue-tsc 为 MIT。DCloud 持续维护，但其编译器对依赖版本有约束，不能用 latest 替代兼容性评估；升级须同步编译 / 运行包并重跑真实构建，首次安装后保留锁文件。插件仍精确声明 Vite `5.2.8` peer，但该版本受 [GHSA-vg6x-rcgg-rjx6 / CVE-2025-24010](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6) 影响；采用包含修复的最新 5.4.x（`5.4.21`），通过真实 H5 与 mp-weixin 构建验证兼容性，安装时可能提示 peer 不匹配。后续升级仍须评估 DCloud 兼容性，不直接切换 Vite 大版本。

生成的 `vite.config.ts` 显式设置 `server.host: 127.0.0.1`、`server.cors: false`、`server.fs.strict: true` 与 `server.fs.allow: ['.']`。当前插件会合并用户的 fs 配置，因此这些配置覆盖其 `strict: false` 默认值；allow 仅包含项目根目录（Vite 自身客户端目录由 Vite 自动加入），避免自动扩大到工作区。保留修复版 Vite 的默认 WebSocket token 校验，不启用跳过校验选项。

页面依赖共享类型与 API 入口，默认使用返回副本的内存 mock。真实服务通过适配器使用 uni.request，保持接口签名，负责超时、HTTP / 响应校验与错误映射；不把浏览器 API 或云平台知识写入页面。

## 后果与边界

- H5 与微信小程序由真实安装、严格类型检查与构建冒烟验收。CLI 默认输出 dist/build/<平台>，不采用 HBuilderX 工程的 unpackage/dist 布局。
- 注册表提供 `build` → `dist/build/h5` 静态计划，沿用隔离 Worker 的静态产物流程。小程序 / App 不由该流程发布。
- App（Android / iOS）与支付宝小程序具有 manifest 配置和编译脚本；不交付 App 真机打包、签名、证书、小程序上传、审核或发布，也不声称已完成真机运行验证。
- 平台 ID 留空，最小权限与请求域名校验保持开启；没有后端认证或持久化。资产样式没有适配多端，assetTarget 为 null。
- 迁移出 DCloud 需要替换页面组件、路由和请求适配器；共享 TypeScript 类型和业务协议可保留。各端运行时差异仍需平台开发者工具与真机验收。
- 回滚时移除 uniapp 注册项、ID 与渲染器及相应测试 / 文档即可；已生成工程独立维护，不涉及数据库结构变更。
