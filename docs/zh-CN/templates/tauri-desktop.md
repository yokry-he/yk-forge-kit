# Tauri Desktop 模板

B19 落实 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) 的桌面技术选型。该模板用于创建基于 Tauri 2 的 Windows / macOS / Linux 桌面应用，前端为 Vue 3 + TypeScript + Vite。模板内置最小应用壳、安全默认配置和一个 Rust 命令调用示例，生成工程可脱离 YKForgeKit 独立维护。

## 适用场景

- 需要分发 Windows `.msi` / NSIS `.exe` 或 macOS `.dmg` / `.app` 安装包。
- 希望使用 Web 技术构建界面，同时通过 Rust 实现需要原生能力或性能敏感的后端命令。
- 需要从开发、构建到签名发布有明确起点的桌面工程；Linux 可在安装系统依赖后本机打包。

## 技术栈

模板固定 Vue `3.5.46`、Vite `8.3.8`、`@vitejs/plugin-vue` `6.0.11`、TypeScript `6.0.3`、vue-tsc `3.3.14`、Tauri JS API `2.12.5` / CLI `2.12.6`、Rust tauri `2.12.7` / tauri-build `2.7.6`。仅将这些依赖写入生成工程，不加入控制面运行依赖。

Vite 采用当前维护的 8.3 系列补丁，避开已公开的开发服务器和文件访问漏洞，含 [2026-11-10 公告](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7) 所列受影响版本。TypeScript 选用 Vue 类型工具兼容的最新 6.x 补丁，当前工具的传递 peer 尚不支持 TypeScript 7；升级时须重新核对 peer、官方安全公告及生成项目的依赖审计，不承诺未来持续无漏洞。

Vue / Vite / Vue 类型工具为 MIT，TypeScript 为 Apache-2.0，Tauri 为 MIT / Apache-2.0 双许可；模板自身采用 Apache-2.0。原生能力集中在 Rust 和 `useGreet` 适配器，替换 IPC 不需要修改页面布局。

## 从 YKForgeKit 创建项目

控制台选择 `tauri-desktop`，或在本仓库构建 CLI 后执行：

```bash
node packages/cli/dist/index.js templates
node packages/cli/dist/index.js create my-desktop --template tauri-desktop
cd my-desktop
corepack pnpm install
```

生成器仅接收项目名及通用的 features 参数，该模板无可选 features。项目名写入 package.json、Cargo.toml、窗口标题及默认标识符 `com.example.my-desktop`。没有独立的包标识符输入；正式发布前自行修改 `src-tauri/tauri.conf.json` 中的 identifier，使用自有反向域名。版本取自 package.json，同步维护 Cargo.toml 版本。

首次安装和原生构建后提交 `pnpm-lock.yaml`、`src-tauri/Cargo.lock`，后续 CI 使用冻结锁文件。仓库内的 `release-desktop.yml` 只是生成项目的构建起点，不会在 YKForgeKit 中作为安装包发布任务运行。

## 本地开发

前置要求：

- Node.js 22.12+、Corepack / pnpm 10。
- Rust stable，至少 1.90；旧工具链须先升级。
- Windows：MSVC Build Tools 与 WebView2；macOS：Xcode Command Line Tools。
- Linux：WebKitGTK、GTK 等开发包。Ubuntu 22.04+ 示例：

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev
```

依赖随发行版而异，以 [Tauri 官方前置要求](https://v2.tauri.app/start/prerequisites/) 为准。默认未启用托盘，不需要为托盘安装 appindicator 库。

启动桌面开发：

```bash
pnpm tauri dev
```

该命令先用 Tauri CLI 从 `src-tauri/app-icon.svg` 生成本地图标，再启动 Vite 和 Rust 主窗口。只预览前端页面使用 `pnpm dev`，服务仅监听 `http://127.0.0.1:1420`。浏览器预览时 `greet` 返回明确的本地提示，不调用原生命令，也不伪装成真实 Rust 返回值。

## 页面与命令

`AppShell.vue` 提供主窗口侧边栏和窄窗口折叠菜单，首页调用 `useGreet.ts`，设置页提供本地显示名称和环境信息。保留简单的视图切换，不引入路由、状态库或系统信息插件。

前端通过 `invoke<string>('greet', { name })` 调用注册的 Rust 命令。姓名在两端修剪空白并限制为 1–80 字符；Rust 返回成功字符串或可处理的错误。页面有输入、加载、结果和错误反馈。设置保存于项目独立键名的 localStorage；读写失败时显示提示，不静默吞掉异常。版本来自 package.json，平台由浏览器报告，仅用于展示。

## 安全默认

模板遵循 [Tauri capabilities](https://v2.tauri.app/security/capabilities/) 的最小权限原则：

- `build.rs` 用 `AppManifest::commands(&["greet"])` 将应用命令纳入 ACL，而非仅注册 invoke handler 后默认授权所有窗口。
- `tauri.conf.json` 仅启用 `main` capability；文件限定本地 `main` 窗口，权限列表只有自动生成的 `allow-greet`。不授予 `core:default`、文件、Shell、HTTP、opener 或 updater 权限。
- 没有 capability 的 `remote.urls`，没有远程窗口 URL、CDN、字体或业务网络请求。配置 `$schema` 仅用于编辑器校验，不是运行时加载地址。
- 生产 [CSP](https://v2.tauri.app/security/csp/) 从 `default-src 'none'` 开始，只允许自身脚本、样式、图片、字体与 Tauri IPC；禁止内联脚本、eval、frame、object、base 和表单提交。`ipc:` / `http://ipc.localhost` 是内部 IPC 传输，并非远程更新服务。
- `devCsp` 仅额外允许固定本机 HTTP / WebSocket HMR 和开发样式注入；Vite 绑定 127.0.0.1、严格端口、禁用 CORS、启用 fs.strict 并将文件范围限定到项目。

新增命令时须同步更新 AppManifest、权限清单和主窗口 capability，并在 Rust 侧校验输入；不要为了接入插件直接增加通配权限或关闭 CSP。

## 自动更新

自动更新默认关闭。没有 updater 依赖、Rust 插件注册、更新 IPC 或后台检查；设置页明确显示“未启用”，不提供无效的启用开关。`bundle.createUpdaterArtifacts` 为 `false`。

生成项目的 `docs/updater.md` 提供后续启用步骤；`src-tauri/updater.example.json` 是不会自动加载的配置草稿，`endpoints` 为空数组，`pubkey` 为空字符串，不含真实服务或密钥，不能原样用于更新。

确需启用时：评估并固定官方 updater 插件版本、添加 JS / Rust 依赖、注册插件、仅授权必要命令、在仓库外生成真实签名密钥、填写自有 HTTPS 服务与公钥、配置 CI 签名和更新清单，然后才加载示例配置并实现用户授权、进度、失败恢复和重启交互。更新签名与操作系统代码签名是独立流程。参考 [Tauri 官方更新指南](https://v2.tauri.app/plugin/updater/)。

## 构建安装包

```bash
pnpm build           # 严格 Vue / TS 类型检查 + 前端生产构建，输出 dist/
pnpm icons           # 直接运行 Cargo 前先生成图标
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm tauri build     # 当前主机原生安装包；自动生成图标并构建前端
```

原生依赖由 Cargo 自动拉取，安装包通常位于 `src-tauri/target/release/bundle/`；图标和构建目录已忽略。图标采用可编辑 SVG，原生 PNG / ICO / ICNS 由 CLI 生成，保持 project-core 的纯文本文件映射契约。

生成工程自带 `.github/workflows/release-desktop.yml`：手动触发或推送 `v*` 标签后，以 Windows x64、macOS ARM64 和 x64 矩阵构建，上传 `.msi`、NSIS `.exe`、`.dmg` 及 `.app` 的 tar.gz 归档（保留可执行位和符号链接）。只需仓库读取权限，不创建 GitHub Release、不发布更新、不自动加载签名 secrets。Linux 安装包在本机生成，矩阵未覆盖 Linux 安装包。

## 代码签名与公证

代码签名和 Apple 公证是发布前的后续步骤，模板没有完成这些工作：

- Windows：使用 Authenticode 证书签名 `.exe` / `.msi`，配置时间戳服务和 CI secrets，参考 [Windows 签名](https://v2.tauri.app/distribute/sign/windows/)。
- macOS：使用 Developer ID 证书签名 `.app` / `.dmg`，配置 Apple 公证凭据并验证 stapling，参考 [macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)。
- 不将证书、密码、API Key、私钥或伪造的私钥占位文件写入源码；未签名产物可能被系统拦截，不能视为已可正式分发。

发布前须在对应系统实际验证安装、启动、IPC、设置保存、升级和卸载。

## 系统托盘

托盘是可选能力，模板默认不创建托盘、不启用 `tray-icon` feature，也没有关闭窗口后隐藏常驻的逻辑。需要时按 [官方托盘指南](https://v2.tauri.app/learn/system-tray/) 显式启用 Rust feature、创建图标和菜单，提供退出入口并说明常驻行为；Linux 需增加相应 appindicator 开发依赖。

## 验证与已知边界

- YKForgeKit 单元测试检查生成、命名、注册信息、权限/CSP、默认关闭更新与托盘、工作流边界和 IPC 适配器的预览/错误分支。CLI 测试将完整文件映射落盘并比对。
- YKForgeKit `template-smoke` 实际生成项目、安装依赖并执行前端生产构建；随后安装 Linux WebKitGTK / GTK 开发依赖，用 stable Rust 执行生成项目的 `cargo check`，缓存 Cargo 下载与构建目录。Cargo 检查有 20 分钟上限，总任务 45 分钟；没有跳过 Rust 检查。
- `cargo check` 不等于桌面 GUI E2E 或安装包验收。模板内 Windows / macOS 工作流须在生成工程仓库执行，代码签名、公证及目标系统实际安装验证仍是使用者后续工作。
- 平台 Worker 的注册表 build 计划只构建前端 `dist`，不承诺云端桌面原生打包，也不把 B18 Android 打包能力扩大到桌面。
- 当前中文为权威文档，英文对应版尚未完成，正式对外发布前须补齐翻译。
