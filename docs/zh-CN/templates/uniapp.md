# uniapp：uni-app 跨端应用模板

状态：已实现（B16）。落实 [ADR-0005](../../adr/0005-product-positioning-and-cross-platform-stack.md) 的小程序 + 移动 App + H5 选型，具体模板边界见 [ADR-0015](../../adr/0015-uniapp-template.md)。采用官方 [vite-ts CLI 预设](https://github.com/dcloudio/uni-preset-vue/tree/vite-ts) 的工程布局。

```bash
node packages/cli/dist/index.js create my-cross-app --template uniapp
cd my-cross-app
corepack pnpm install
corepack pnpm dev:h5
```

需要 Node.js 22+ 与 pnpm 10.18.3。注册信息由 CLI、API 和控制台向导共用；`kind: miniapp`，`targets: [h5, miniapp, mobile]`，没有可选能力。

## 功能与文件

- Vue 3 + TypeScript strict + Vite + uni-app；`src/main.ts` 使用 createSSRApp。
- 中文首页、支持搜索的列表、详情、个人页；首页 / 列表 / 个人页组成原生文字 tabBar，详情通过 `uni.navigateTo` 入栈，`uni.navigateBack` 返回，直接访问详情无历史时转到列表。
- 手机 / 小程序窄屏单列，H5 宽屏双列与最大内容宽度；全局语义颜色、按钮和键盘焦点样式。
- 页面包含加载、错误提示与重试、空状态；失败记录页面上下文日志，并用 `uni.showToast` 提示。
- `src/api/types.ts` 为共享类型，`index.ts` 为页面 API 入口，`mock.ts` 为延迟 300ms 的内存数据。返回副本，不持久化；资料仅为演示，没有认证语义。
- 导航集中在 `src/navigation.ts`；页面不使用 window、document、localStorage 或浏览器 fetch。
- `src/pages.json` 配置共用页面与文字 tabBar，不引用图标，避免字符串渲染器引入二进制资源；`src/manifest.json` 配置 H5、mp-weixin、mp-alipay 与 app-plus 的 Android / iOS 部分。

## 构建命令

```bash
corepack pnpm typecheck
corepack pnpm dev                 # 等同 dev:h5
corepack pnpm build               # 等同 build:h5
corepack pnpm dev:mp-weixin
corepack pnpm build:mp-weixin
corepack pnpm dev:mp-alipay
corepack pnpm build:mp-alipay
corepack pnpm dev:app
corepack pnpm build:app
```

所有 build 命令均先执行 vue-tsc 严格类型检查。CLI 默认产物目录：

| 目标 | 开发目录 | 生产目录 |
| --- | --- | --- |
| H5 | `dist/dev/h5` | `dist/build/h5`（含 index.html） |
| 微信小程序 | `dist/dev/mp-weixin` | `dist/build/mp-weixin`（含 app.json / app.js 和页面文件） |
| 支付宝小程序 | `dist/dev/mp-alipay` | `dist/build/mp-alipay` |
| App | `dist/dev/app` | `dist/build/app`（资源，不是 APK / IPA） |

这是 CLI 工程的 dist 布局，不使用 HBuilderX 工程常见的 `unpackage/dist`。微信开发者工具导入微信产物目录并设置自己的 AppID。注册表的静态构建计划使用 `build` 与 `dist/build/h5`，平台静态预览 / 部署仅处理 H5。B17 增加单独的 mp-weixin 构建目标及[微信上传与预览](../weapp-upload.md)；B18 增加独立的 [Android 打包](../android-packaging.md) 流程，需准备离线工具镜像与 AppKey。

DCloud 编译 / 运行包固定为 `3.0.0-5030420261029002`；Vue 与 @vue/runtime-core `3.4.21` 匹配编译器；Vite `5.4.21` 包含开发服务器安全修复，虽与插件精确声明的 `5.2.8` peer 不同，已通过 H5 / mp-weixin 构建验证（安装时可能提示 peer 不匹配）；@dcloudio/types `3.4.31` 匹配 uni-app peer，TypeScript `5.9.3`、vue-tsc `3.1.5`。首次安装后应保留锁文件，升级时同步 DCloud 包版本并复跑双端构建。

H5 开发服务器显式监听 `127.0.0.1`，关闭跨域访问（`server.cors: false`），设置 `server.fs.strict: true` 与 `server.fs.allow: ['.']`，将文件访问限制在项目根目录及 Vite 自身客户端目录，覆盖插件的宽松默认值。保留 Vite 默认 WebSocket token 校验。

## 接入真实 API

替换 `src/api/mock.ts` 为 `uni.request` 实现，或将 `src/api/index.ts` 的导出切到真实适配器，保持下面的签名与类型不变：

```ts
fetchEntries(): Promise<Entry[]>
fetchEntryById(id: string): Promise<Entry | null>
fetchUserProfile(): Promise<UserProfile>
```

在适配器中校验 HTTP 状态、响应数据与业务错误，设置超时，失败时 reject；详情缺失返回 null。页面已有加载、失败反馈与重试。小程序需在平台后台配置合法请求域名；模板保持域名校验开启。不在客户端保存服务端密钥。

## 限制与下一步

- H5、mp-weixin 与 mp-alipay 是自动构建验收目标；App 已配置编译脚本与 manifest，各端仍需开发者工具与真机验收。
- **模板本身不包含真实 App 打包、签名、证书、小程序上传、审核或发布。** 平台 B17 的微信上传与预览需另行配置项目密钥，不随模板生成。 App 编译只生成资源；B18 平台流程在此之后执行原生打包与签名，具体限制见下文。iOS 仍需单独的 Apple 开发者账号、证书及 macOS 构建方案，未实现。
- 微信 / 支付宝 AppID 留空，后续由使用者填写，并配置合法域名、上传与审核；不内置任何凭证。
- 暂不支持资产安装（`assetTarget: null`）；没有登录后端、持久化或推送服务。组件留在模板内，不提前抽取公共 UI。
- 自动构建通过不代表各端运行时、设备安全区、平台权限或真机体验完成验收。
- 当前简体中文为权威文档；英文对应指南尚未翻译，对外发布前须补齐并检查同步状态。

## 质量验证

- `corepack pnpm --filter @forgekit/project-core test`：检查名称替换、文件与路由完整性、注册信息、路径安全、确定性、版本与脚本、开发服务器文件范围 / CORS / 监听地址、无浏览器专用 API / 密钥；直接转译运行生成的 mock 与导航模块，验证延迟、查找、无效 ID、数据副本、参数编码与回退行为。
- `corepack pnpm --filter @forgekit/cli test`：逐模板创建，核对落盘文件与纯渲染器结果一致。
- `FORGEKIT_TEMPLATE_SMOKE=1 corepack pnpm --filter @forgekit/cli exec vitest run test/templates.test.ts`：真实生成、安装、严格类型检查、构建 H5、mp-weixin 和 mp-alipay，检查 H5 index.html、小程序 app.json / app.js、四个页面与三项 tabBar；沿用已有模板冒烟行为。

## B18 Android APK / AAB

模板的 `build:app` 仍只生成 App 资源。平台新增独立 Android 任务，在隔离容器编译资源，再使用匹配的官方离线 SDK / Gradle 壳生成 APK / AAB，独立签名后保存带 SHA-256 的私有制品。控制台支持公开配置、只写签名替换、debug/release、实时日志、取消与下载。需要部署者预先构建许可合规的工具镜像并登记 DCloud AppKey / 证书指纹；不调用 DCloud 云打包。

目前从登记模板和项目参数重建，不读取本地修改工程；真实 SDK / 真机验收尚待完成。iOS 未实现，作为下一步。详见 [Android 打包指南](../android-packaging.md) 与 [ADR-0017](../../adr/0017-android-offline-packaging.md)。

## B20 支付宝上传与预览

平台可从成功的 mp-alipay 制品上传开发版本、按权限设置体验版并生成私有预览二维码。需独立配置 AppID、toolId 和只写工具私钥；模板中不放凭证。操作与部署要求见 [支付宝上传指南](../alipay-upload.md) 和 [ADR-0019](../../adr/0019-alipay-upload-preview.md)。
