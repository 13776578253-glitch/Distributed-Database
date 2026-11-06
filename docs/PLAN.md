# 开发顺序

当前阶段是 **S3 · MVCC/WAL**，待开工。各阶段的目标、验收命令、结果和证据按编号留在 `current-task/`。

| 阶段 | 状态 | 任务记录 |
| --- | --- | --- |
| S0 · 脚手架 | 已验收 | [脚手架](current-task/S0-scaffold.md) |
| S1 · Raft 纯核心 | 已验收 | [Raft 纯核心](current-task/S1-raft-core.md) |
| S2 · 容器 Raft | 已验收 | [容器 Raft](current-task/S2-raft-compose.md)，R03 判定在 S4 |
| S3 · MVCC/WAL | 待开工 | [单节点事务与恢复](current-task/S3-mvcc-wal.md) |
| S4 · 一致性验证 | 待开始 | V01/V02/V03、R03 和 T02 历史回放 |
| S5 · 课程交付 | 待开始 | 演示、选型对比、时序图和报告 |

组长负责 Raft 和合并，组员 A 负责单节点事务，组员 B 负责外部验证。实验运行器通过公开 API 或故障接口操作。Raft term 和 log index、事务 LSN、实验 operation ID 各自独立。

三个方向的复现入口见[实验清单](experiments.md)。选型对比、时序图和报告分别放在 `docs/comparison.md`、`docs/diagrams/` 和 `docs/report.pdf`，成稿后逐项查看。
