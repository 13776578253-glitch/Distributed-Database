# 开发顺序

最近的开发任务是[启动五节点 Compose 并验收 Raft KV](current-task/2026-11-06-raft-compose.md)。后续任务按实际需求在 `current-task/` 记录。

| 阶段 | 状态 | 范围 |
| --- | --- | --- |
| S0 · 脚手架 | 已验收 | 公共契约、工具链、Compose 冒烟 |
| S1 · Raft 纯核心 | 已验收 | 选举、复制、提交与读屏障 |
| S2 · 容器 Raft | 已验收 | R01/R02 和 R03 历史采集，R03 判定在 S4 |
| S3 · MVCC/WAL | 待开始 | RC/SI、墓碑和写冲突、自写 WAL、检查点、AS OF、Analysis/Redo/Undo 与 CLR，验收 T01/T02/T03 |
| S4 · 一致性验证 | 待开始 | V01/V02/V03、R03 和 T02 历史回放 |
| S5 · 课程交付 | 待开始 | 演示、选型对比、时序图和报告 |

组长负责 Raft 和合并，组员 A 负责单节点事务，组员 B 负责外部验证。实验运行器通过公开 API 或故障接口操作。Raft term 和 log index、事务 LSN、实验 operation ID 各自独立。

三个方向的复现入口见[实验清单](experiments.md)。选型对比、时序图和报告分别放在 `docs/comparison.md`、`docs/diagrams/` 和 `docs/report.pdf`，成稿后逐项查看。
