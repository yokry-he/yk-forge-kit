# B18 交付摘要

在 `feat/b18-android-packaging` 完成实现，未提交、未操作 main，未写入 .git。`/workspace/b18-drafts/` 初始为空，无待整合草稿。

采用 uni-app `build:app` → 官方 DCloud 离线 SDK 的可信 Gradle 壳 → 独立禁网签名容器，生成 APK/AAB，不调用云打包。与 B09 一致，从已登记模板和项目参数重建，不读取本地改动源码。DCloud SDK 许可、AppID/AppKey、证书绑定和私有工具镜像由部署者准备；当前未验证真实 SDK / Gradle / 真机链路。

主要变更：

- contracts、Drizzle schema / 迁移 0016 / journal / snapshot，以及 Android 配置、任务、日志和审计仓库。
- NestJS 配置 / 排队 / 取消 / 下载 API、独立 SSE 票据和回放；沿用 deploy:read/manage/run 与身份限流。
- Worker Android 消费者、恢复扫描、编译/原生/签名适配器及清理；签名使用 B14 AES-256-GCM 加密，通过 stdin 注入，仅在签名容器 tmpfs 内落盘。
- Element Plus 中文配置和签名上传表单、debug/release APK/AAB、详情日志、取消及 SHA-256 校验下载。
- infra/android 的固定版本工具镜像、可信 Gradle 壳和 Python 入口；CI 增加快速 Python mock 测试，不安装 Android SDK。
- ADR-0017、中文 Android 指南、模板/入门/能力说明和环境配置示例。

验证：全仓 `pnpm typecheck`、`pnpm test`（含 build）及 `pnpm db:migrations:check` 已通过。后续补充修改另跑受影响包的 Android 测试。新增 Python mock 测试通过（8 个用例）；新增 MySQL opt-in 用例已接入根 `db:test:integration`，默认跳过。无 Docker/JDK/私有 SDK/测试 MySQL/真机，未执行这些集成验收；Vite 现有依赖注释和 bundle 大小提示不影响构建。

复现：

```bash
pnpm typecheck
pnpm test
pnpm db:migrations:check
python3 -m unittest discover -s infra/android -p 'test_*.py'
# 使用专用测试库，显式开启 FORGEKIT_DB_INTEGRATION=1 后：
pnpm db:test:integration
```

本工作环境的 Corepack 默认缓存路径只读，运行 pnpm 时使用 `COREPACK_HOME=/tmp/forgekit-corepack`；此变量只影响本地工具缓存，不改变项目依赖。

B18 xhigh MUST-FIX 修复：Android Runner 复用 B09 的目录权限恢复与不跟随符号链接的清理函数，仅在确认容器删除后遍历工作目录；清理异常进入发布回滚路径，删除本次已发布制品后继续抛错。新增非 root 下 000/0555 非空目录、外部符号链接保持原样，以及发布后清理失败时回收制品的回归测试。AAB 移除固定 RSA 签名算法，由 jarsigner 按私钥选择兼容默认值（见 [JDK 17 文档](https://docs.oracle.com/en/java/javase/17/docs/specs/man/jarsigner.html#supported-algorithms)）；新增真实 keytool/jarsigner 测试，生成 RSA/EC × JKS/PKCS12 四种材料，调用实际签名入口并严格验签，无需 Android SDK。

本次验证：worker 全部测试 156 通过、4 个既有集成用例跳过；全仓 `pnpm typecheck` 通过；Python unittest 共 9 个用例，8 通过、1 个真实 JDK 用例因本机无 keytool/jarsigner 跳过。该用例在工具可用时自动执行，CI ubuntu-latest 可直接使用已有 JDK；本次未声称完成真实 JDK/SDK 验收。未提交，未操作 main。

后续验收：按 android-packaging.md 构建并扫描带匹配 SDK 的私有镜像（镜像构建含 APK/AAB 预热和离线检查）；登记调试/发布证书对应 AppKey；跑真实 debug/release 任务、签名及校验摘要、取消/超时清理、真机启动导航和目标商店 AAB 验证。不可将 mock 测试结果当作这些步骤已完成。源码快照、UTS/原生插件、自动保留期/孤儿回收、KMS/轮换、商店上传及公开前英文指南待后续；iOS 仅作为下一步，未实现。

回退：先关闭入口、取消/排空任务、停止 Android 消费者并核对容器；保留增量表、审计、制品及主密钥，回退应用并优先前向修复，不自动删表。
