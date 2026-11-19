# ADR-0004: 身份与项目权限基础

- 状态：Accepted（数据边界与权限策略）；运行时认证提供方待选择
- 日期：2026-11-16
- English title: Provider-neutral identity and project-scoped authorization

## 背景

YKForgeKit 将支持多用户、项目协作、CLI 执行器及云端发布。此前项目与资产 API 只供本机开发，尚无登录或项目归属控制。不能将当前无鉴权的接口误用为可公网部署的服务。

## 决策

1. 建立 `users`、`external_identities`、`project_memberships` 三类数据，不在业务数据库保存用户密码；身份以提供方的 `(issuer, subject)` 唯一标识，不以邮箱作为主键。
2. 项目角色为 `owner`、`editor`、`viewer`；权限按行为定义，采用默认拒绝与最小权限。策略代码独立于 Vue、NestJS 和数据库驱动。
3. 一个项目可有多个成员，同一用户对同一项目只能有一个角色。角色变更必须经过服务端鉴权及事务校验，最后一个 owner 不得被删除或降级。
4. 登录建议对接成熟 OIDC 提供方，后续确认部署形态与用户体验后再实现认证回调、会话和 CLI 设备授权。**本 ADR 不声称已经实现 OIDC 登录或 API 守卫**。
5. 旧项目尚未归属任何用户。未来启用鉴权前需要明确安全的迁移/认领流程；不能自动将所有旧项目授予首个登录者。
6. 当前 API 仅供本机实验使用。接入正式身份认证与项目范围授权之前，不允许扩大监听范围或发布公网。

## 本阶段交付范围

- `@forgekit/identity-core`：纯授权决策函数与测试。
- Drizzle MySQL 8.0 schema 和版本化 `0003` 迁移。
- 暂不新增用户登录入口，不修改现有项目写操作的运行时行为，不执行实际数据库迁移。

## 后续实现门槛

1. 确认 OIDC 提供方（自托管或托管）、会话形态和密钥轮换方案。
2. 服务端验证可信身份，并用数据库查询项目成员资格；每次项目读写与资产操作都在服务端做资源级授权，不能仅靠前端隐藏按钮。
3. 项目创建与 owner 成员写入同一数据库事务；成员管理必须保证至少一个 owner。
4. CLI 通过有生命周期、可撤销的独立授权流程获取能力，执行器权限不能等同管理员用户权限。
5. 进行越权、跨项目访问、会话失效、重复提交和迁移测试后，才允许部署到外网。

2026-11-16 补充：首个可复用 OIDC 访问令牌验证器采用 `jose`，固定 issuer、audience、HTTPS JWKS 与算法白名单。该模块只完成密码学和声明验证，不代表业务路由已启用鉴权。详见 `docs/zh-CN/oidc-verification.md`。

## 参考

- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [NestJS Authorization](https://docs.nestjs.com/security/authorization)
- [Drizzle MySQL Indexes & Constraints](https://orm.drizzle.team/docs/mysql/indexes-constraints)
