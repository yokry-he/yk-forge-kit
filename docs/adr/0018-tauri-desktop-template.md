# ADR-0018：Tauri 桌面模板边界与安全默认

- 状态：Accepted
- 日期：2026-11-22
- English title: Tauri desktop template boundaries and secure defaults

## 背景与决策

B19 落实 [ADR-0005](./0005-product-positioning-and-cross-platform-stack.md) 的桌面选型。统一模板注册表增加 `tauri-desktop`，kind / targets 为 desktop；采用 Tauri 2 + Vue 3 + TypeScript + Vite，支持 Windows / macOS / Linux。本变更不实现 YKForgeKit 桌面客户端或平台原生构建服务。

沿用 project-core 的纯字符串文件映射渲染器及项目名称占位替换。Vue 页面、CSS 和中文指南以 DeepSeek 草稿为起点；保留侧边栏、首页及设置结构，修正权限、存储错误反馈与更新状态。原生图标从随工程提供的 SVG 在本地生成，不扩展生成器的二进制文件契约。视图切换保持简单，不增加路由、状态库和独立公共 UI 模块。

Rust 仅注册 greet 命令，并通过 `AppManifest::commands` 纳入 ACL，仅本地主窗口获得 allow-greet。不授予 core:default 或系统插件能力。生产 CSP 仅允许本地静态资源和 IPC，开发 CSP 限定本机 HMR；Vite 仅监听回环地址。自动更新和托盘默认关闭：不安装插件、不后台检查，不提供误导性的本地更新开关；独立示例配置不自动加载，无端点及公钥。

依赖固定为 Vue 3.5.46、Vite 8.3.8、plugin-vue 6.0.11、TypeScript 6.0.3、vue-tsc 3.3.14、Tauri API 2.12.5 / CLI 2.12.6、tauri 2.12.7 / tauri-build 2.7.6。Vite 使用维护分支当前补丁以避开公开的开发服务漏洞；TypeScript 6.x 满足 Vue 类型工具的传递 peer `<7`。Rust 至少 1.90。Vue/Vite/Vue 类型工具为 MIT，TypeScript 为 Apache-2.0，Tauri 为 MIT / Apache-2.0；上游活跃维护，仍需持续审计并更新。Tauri API 被封装在 useGreet 适配器中，便于测试或替换。升级成本包括 Vue 类型工具兼容性、Rust MSRV、系统 WebKitGTK 和三平台打包验证。

生成工程的工作流负责 Windows 与 macOS 双架构安装包构建及 artifact 上传，默认无 Release 发布和签名配置。YKForgeKit 自身 CI 仅前端构建及 Linux cargo check，安装稳定发行版 WebKitGTK 开发依赖并缓存 Cargo。平台 build 元数据依旧输出前端 dist，保持与原生安装包交付边界清晰。

## 后果与回滚

生成工程可独立维护，安全默认不授予当前页面不需要的原生能力。增加原生命令、插件、托盘、更新服务和发布签名时需要显式配置并重新验证，首次原生构建也需要下载系统/Rust 依赖。Windows/macOS 安装包、签名及 GUI 运行应在目标系统实际验收，不能从 Linux cargo check 推导为已完成。

回滚只需撤销模板注册、渲染器、测试和相关 CI / 文档；无数据库迁移，不影响既有模板或已经生成的独立工程。中文指南为权威版本，正式对外发布前补齐英文。

使用、安全配置、版本依据及验证边界见 [模板指南](../zh-CN/templates/tauri-desktop.md)。
