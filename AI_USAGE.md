# AI 使用记录

| 阶段 | AI 参与内容 | 复核入口 |
| --- | --- | --- |
| S0 | 整理项目目录、公共类型、Compose 脚手架和冒烟脚本 | [五节点 Compose 任务记录](docs/current-task/2026-11-06-raft-compose.md) |
| S1 | 实现纯 Raft 状态机和确定性故障测试 | tests/raft/core.test.ts |
| S2 | 实现 HTTP RPC、SQLite 适配器与容器实验 | docs/experiments.md 与 evidence/R01–R03/ |
| E0–E1 | 核对 Raft 基线、修复 HTTP 异常、实现批量提交和容器故障实验 | [扩展任务记录](docs/current-task/2026-11-07-raft-extensions-e0-e2.md) |
| E2 | 实现显式 Follower 读模式、共享多数派读屏障和分区读对照实验 | [扩展任务记录](docs/current-task/2026-11-07-raft-extensions-e0-e2.md) |
| E3A–E3B | 迁移绝对日志索引，实现快照落盘、安装与重启恢复，复跑隔离容器实验 | [快照任务记录](docs/current-task/2026-11-07-raft-snapshots.md) |
| E4A–E4B | 实现联合配置、双多数判定、Compose 成员实验与命令行控制台 | [成员变更任务记录](docs/current-task/2026-11-07-raft-membership.md) |
| Raft 冻结 | 补齐跨配置选举、快照截断恢复和延迟读确认的确定性回归，运行全量测试和类型检查 | [协议边界回归](docs/current-task/2026-11-07-raft-protocol-freeze.md) |
| S3A | 设计事务历史契约，实现内存 MVCC 与具名事务锁，编写确定性隔离测试 | [MVCC 任务记录](docs/current-task/2026-11-07-s3a-mvcc.md) |
| S3B–S3D | 实现事务 WAL、SQLite 版本物化、检查点与可重入恢复，运行独立事务服务与真实故障实验 | [事务持久化与故障实验记录](docs/current-task/2026-11-07-s3b-s3d-wal-recovery.md) |
| S4A–S4D | 实现寄存器线性化检查、事务依赖图和值班不变量，回放 R03/T02 并核对两篇系统论文的量化指标 | [一致性验证与冻结记录](docs/current-task/2026-11-07-s4-verification.md) |
| Raft 观测控制台第一批 | 实现 Compose 挂接与初始化、只读 HTTP 聚合和 React 拓扑，补充 Observer 测试，使用隔离 Compose 项目和真实 Edge 完成功能验收 | [首批任务记录](docs/current-task/2026-11-06-raft-console.md) |
| Raft 控制台视觉微调 | 根据用户批注调整侧栏与响应式布局，使用现有容器日志投影近期 RPC，补充顶位分配测试与隔离换届验证 | [第二轮布局与通信观测](docs/current-task/2026-11-06-raft-console.md#第二轮布局与通信观测) |
| Raft 控制台第二批 | 实现共享日志采集、SSE 游标与 Evidence 回放，运行隔离容器和 HTTP 验收 | [第二批验收记录](docs/current-task/2026-11-06-raft-console-timeline.md) |
| Raft 控制台第三批 | 实现项目操作锁、任务进程与设置页，运行隔离的 R01/R02、互斥和重启验收 | [第三批验收记录](docs/current-task/2026-11-06-raft-console-operations.md) |
| 冻结后端与控制台联调 | 合并冻结版，接入事务服务、验证 Evidence 和 Raft 扩展状态，执行隔离容器与 Edge 功能验收 | [联调记录](docs/current-task/2026-11-07-console-frozen-backend.md) |
