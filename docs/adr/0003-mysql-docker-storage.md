# ADR-0003: Docker MySQL 数据存储基础

- 状态：Accepted（数据库选择）；ORM 与初始 Schema 为可调整的第一阶段实现
- 日期：2026-11-15
- English title: Existing Docker MySQL as the primary relational database

## 背景

用户明确要求使用其现有 Docker 中的 MySQL。此前架构蓝图中的 PostgreSQL 是待决策建议，现被新要求替代。

## 决策

1. ForgeKit 使用用户现有 MySQL 服务，不创建新数据库容器。
2. 数据访问封装到独立的 @forgekit/db，业务模块避免依赖具体数据库驱动。
3. 第一阶段采用 mysql2 与 Drizzle ORM；Schema 和迁移版本化。
4. 连接凭证通过环境配置，API 存活与数据库就绪状态分离。
5. 迁移须经审查和授权后显式执行，应用启动不得自动修改表结构。

## 影响

可复用现有基础设施，降低早期运维成本；同时需要处理宿主机与 Docker 网络寻址、权限隔离及备份。

当前未提供连接参数，所以只完成代码和无数据库环境测试，不声明已连接用户实例。
