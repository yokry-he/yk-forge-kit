# GitHub 仓库治理与分支保护

状态：建议配置。GitHub 远程保护规则须由具有仓库管理权限的用户在 Settings 中启用，本文件本身不代表保护已经生效。

仓库：`yokry-he/yk-forge-kit`；默认分支：`main`。

## 当前阶段（尚无 CI 工作流）

在 GitHub → Settings → Branches → Add branch protection rule（或 Rules → Rulesets）针对 `main`：

1. **启用 Require a pull request before merging**。
2. **启用 Block force pushes / Do not allow force pushes**。
3. **启用 Block deletions / Do not allow deletions**。
4. **建议启用 Require conversation resolution before merging**。
5. **建议限制绕过规则的角色**，并在支持的情况下让管理员也遵守规则。
6. **暂不设置固定的 Required status check 名称**，因为 CI 尚未建立，设置不存在的检查会阻塞合并。
7. 若目前只有仓库所有者一名贡献者，**暂不要求至少一名批准审查**，因为作者不能批准自己的 PR，可能导致仓库无法正常迭代。加入第二位维护者后再设为至少 1 人批准。

## CI 建立后

建立实际可运行的工作流并确认检查名称后，再逐步启用：

- 格式 / Lint
- TypeScript 类型检查
- 单元与集成测试
- 构建验证
- 必要的安全与依赖检查

然后配置 **Require status checks to pass before merging**，仅选择已经稳定执行的真实检查；建议启用要求分支与基线保持更新的策略，并结合队列成本评估。

## PR 管理

- 功能分支命名如 `feat/...`、`fix/...`、`chore/...`、`docs/...`。
- PR 说明问题、方案、验证、风险和回滚。
- 不允许为绕过失败检查而无解释地关闭保护。
- 合并策略优先 Squash Merge，以减少主干噪音；保留完整 PR 上下文。
- 维护 `CODEOWNERS` 应以真实责任人存在为前提，禁止虚构审查人。

## 注意

GitHub 各账户计划、仓库可见性及权限可影响可用的保护选项。以设置页实际能力为准。必要时由维护者手动完成配置并核对“规则已生效”。
