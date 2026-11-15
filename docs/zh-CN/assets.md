# ForgeKit 公共资产协议（第一阶段）

状态：实验性 MVP，未形成稳定的外部插件 API。

## 模型

一个资产包含：`id`、`version`、`name`、`description`、`target`、`dependencies` 和 `provides`。当前 Registry 仅内置 `official.theme@1.0.0`，支持 `vue-web`。

职责分离：

- **Registry**：返回资产清单及版本信息，不直接操作项目文件。
- **Resolver**：解析依赖、去重、目标兼容性和循环依赖。
- **Installer Planner**：根据项目文件快照生成变更计划，拒绝碰撞及不安全的重复安装。
- **CLI Adapter**：读取本地文件、展示计划、应用变更并写入锁文件。

`packages/asset-core` 保持不依赖 Vue、NestJS 或 Node 文件系统，便于独立测试。CLI 对文件系统和路径进行额外校验。

## 锁文件

`.forgekit/assets.lock.json` 记录 Schema 版本、资产版本和受管理文件的指纹。重复安装时会验证文件是否漂移，避免覆盖用户修改。当前指纹只适用于本地变更检测，不提供安全签名或第三方来源认证。

## 安装行为

安装前先进行完整计划和冲突检查。当前示范主题资产新增 `src/forgekit/theme.css`，修改 `src/style.css` 的 CSS 导入，并创建锁文件。

初次创建 Vue 项目时选择主题，与后续执行 `asset add official.theme` 使用同一份定义及计划逻辑；由此减少公共资产实现重复和版本偏差。

## 当前边界和后续工作

- 本阶段不运行任意资产安装脚本，也不下载第三方代码。
- 当前安装器仅支持内置主题资产；依赖解析接口为后续其他资产预留。
- 当前文件写入有失败补偿，但并非跨文件系统的严格事务。生产级实现需要更完备的冲突检测、日志和恢复策略。
- 下一阶段再考虑正式 Manifest Schema、SHA-256/签名、可复现安装、代码合并、数据库迁移、升级与卸载。
- 独立公共 UI 仓库 `yk-forge-ui` 尚未创建；本资产是验证能力模型的源码型示例，不代表正式 UI 库布局已确定。
