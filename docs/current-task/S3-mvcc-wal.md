# S3 · 单节点事务与恢复

状态为待开工，主责为组员 A。事务引擎独立持有事务、版本、LSN 和 WAL。

1. 实现 RC、SI、墓碑与同键写冲突，复现并修复值班约束写偏差。
2. 接入自写 WAL、检查点和 AS OF LSN。数据落盘前先刷对应 WAL，AS OF 只读指定 LSN 时已提交的版本。
3. 实现 Analysis、Redo 和带 CLR 的 Undo，验证恢复中再次崩溃可继续。

验收见[实验清单](../experiments.md)中方向三的 T01、T02、T03。
