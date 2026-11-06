# 开发顺序

阶段记录按编号在本页追加。每阶段记录目标、验收命令、结果与证据路径。

| 阶段 | 工作与验收出口 |
| --- | --- |
| S0 | 公共契约、测试和类型检查、五节点 Compose 健康检查、SMOKE 证据 |
| S1 | 确定性 Raft 选举、复制、提交、读屏障和 Leader 更替测试 |
| S2 | HTTP RPC、持久化、R01/R02 实验和 R03 历史采集 |
| S3 | RC/SI、自写 WAL、AS OF、恢复与 T01/T02/T03 |
| S4 | 检查器、V01/V02/V03、R03 和 T02 历史回放 |
| S5 | 演示、选型对比、时序图和报告 |

组长负责 Raft 和合并，组员 A 负责单节点事务，组员 B 负责外部验证。实验运行器通过公开 API 或故障接口操作。Raft term 和 log index、事务 LSN、实验 operation ID 各自独立。选型对比、图和报告随对应阶段补齐。

## S0 · 脚手架

`pnpm test`、`pnpm typecheck`、`docker compose config --quiet` 和 `pnpm demo` 通过。五个 Raft 占位容器使用同一镜像和独立数据卷。标准入口的 [SMOKE 证据](../evidence/SMOKE/2026-11-06T10-43-09.162Z--1e992354/result.json) 共 15 项检查。先前镜像标签与运行容器不一致的失败也保留在同一实验目录。
