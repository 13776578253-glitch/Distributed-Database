# AI 使用记录

| 阶段 | AI 参与内容 | 复核入口 |
| --- | --- | --- |
| S0 | 整理项目目录、公共类型、Compose 脚手架和冒烟脚本 | [五节点 Compose 任务记录](docs/current-task/2026-11-06-raft-compose.md) |
| S1 | 实现纯 Raft 状态机和确定性故障测试 | tests/raft/core.test.ts |
| S2 | 实现 HTTP RPC、SQLite 适配器与容器实验 | docs/experiments.md 与 evidence/R01–R03/ |
| Raft 观测控制台第一批 | 实现 Compose 挂接与初始化、只读 HTTP 聚合和 React 拓扑，补充 Observer 测试，使用隔离 Compose 项目和真实 Edge 完成功能验收 | [首批任务记录](docs/current-task/2026-11-06-raft-console.md) |
| Raft 控制台视觉微调 | 根据用户批注调整侧栏与响应式布局，使用现有容器日志投影近期 RPC，补充顶位分配测试与隔离换届验证 | [第二轮布局与通信观测](docs/current-task/2026-11-06-raft-console.md#第二轮布局与通信观测) |
| Raft 控制台第二批 | 实现共享日志采集、SSE 游标与 Evidence 回放，运行隔离容器和 HTTP 验收 | [第二批验收记录](docs/current-task/2026-11-06-raft-console-timeline.md) |
