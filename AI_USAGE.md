# AI 使用记录

| 阶段 | AI 参与内容 | 复核入口 |
| --- | --- | --- |
| S0 | 整理项目目录、公共类型、Compose 脚手架和冒烟脚本 | [五节点 Compose 任务记录](docs/current-task/2026-11-06-raft-compose.md) |
| S1 | 实现纯 Raft 状态机和确定性故障测试 | tests/raft/core.test.ts |
| S2 | 实现 HTTP RPC、SQLite 适配器与容器实验 | docs/experiments.md 与 evidence/R01–R03/ |
| E0–E1 | 核对 Raft 基线、修复 HTTP 异常、实现批量提交和容器故障实验 | [扩展任务记录](docs/current-task/2026-11-07-raft-extensions-e0-e2.md) |
