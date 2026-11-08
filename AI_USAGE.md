# AI 使用记录

本文件记录本仓库中 AI 工具的实际参与方式、采纳范围和人工复核入口。AI 输出不直接作为正确性结论：代码以测试、类型检查、真实 Compose 实验和 Evidence 复核，界面以真实浏览器检查复核。正式实验记录仍以 `evidence/` 为准，开发过程记录见 `docs/current-task/`。

## 使用工具

| 工具 | 用途 | 复核方式 |
| --- | --- | --- |
| PowerShell 7、Node.js 24.21.0、pnpm 11 | 运行命令、脚本、测试和构建 | 命令输出与退出码；失败记录保留在 Evidence 或任务记录 |
| Vitest、TypeScript `tsc`、Vite | 回归测试、类型检查、前端构建 | `pnpm test`、`pnpm typecheck`、`pnpm build:web` |
| Docker Engine、Docker Compose | 五节点 Raft、独立事务服务、故障和恢复实验 | `docker compose config`；真实容器、卷和 SIGKILL/分区实验；Evidence |
| Playwright CLI + Microsoft Edge | 真实浏览器联调、响应式和交互检查 | 页面操作、截图、控制台错误和 API 响应 |
| Git | 分阶段提交、差异审查和回退边界 | 提交前检查 diff、测试结果和工作区状态 |

## 逐项记录

| 阶段 | 使用工具 | AI 给出的内容与用途 | 是否采纳 | 人工验证 |
| --- | --- | --- | --- | --- |
| S0 脚手架 |  Compose | 目录、公共契约、Compose 骨架和冒烟脚本草案 | 采纳 | `pnpm test`、`pnpm typecheck`、`docker compose config`、SMOKE Evidence |
| S1 Raft Core |  Vitest | 选举、日志复制、提交、读屏障和确定性测试 | 采纳 | 可控消息调度测试；全量回归；[协议边界记录](docs/current-task/2026-11-07-raft-protocol-freeze.md) |
| S2 Raft 容器 |  Compose | HTTP RPC、SQLite 适配器、五节点 Compose 和故障实验 | 采纳，修正了 HTTP 响应与网络错误边界 | SMOKE、R01、R02、R04 Evidence；真实容器日志 |
| E0–E2 |  Vitest、Compose | 批量提交、Follower Read、隔离实验参数和断言 | 采纳 | 纯 Core 回归、E1/E2 Evidence、R01/R02 回归；[扩展记录](docs/current-task/2026-11-07-raft-extensions-e0-e2.md) |
| E3A–E3B |  Compose | 绝对日志索引、快照保存/安装/压缩、SIGKILL 恢复 | 采纳，按快照边界修正保留后缀逻辑 | 快照测试、E3B Evidence、旧卷重开和隔离容器复跑；[快照记录](docs/current-task/2026-11-07-raft-snapshots.md) |
| E4A–E4B |  Compose | 联合配置、双多数判定、成员变更命令行和 Compose profile | 采纳 | 确定性协议测试、E4B Evidence、成员状态与恢复核对；[成员记录](docs/current-task/2026-11-07-raft-membership.md) |
| Raft 冻结 |  Vitest | 跨配置选举、快照截断恢复、延迟读确认的回归测试 | 采纳 | 确定性场景和全量测试；[冻结记录](docs/current-task/2026-11-07-raft-protocol-freeze.md) |
| S3A MVCC |  Vitest | 事务状态机、版本链、SI/RC 读视图、具名锁和契约测试 | 采纳 | 确定性隔离与写偏斜测试；[MVCC 记录](docs/current-task/2026-11-07-s3a-mvcc.md) |
| S3B–S3D WAL/恢复 |  Vitest、Compose | WAL 记录、LSN 链、SQLite 物化、Checkpoint、Analysis/Redo/Undo、CLR 和故障注入 | 部分采纳，修正了旧版 TEXT 键合并问题 | 118 项全量测试；T01/T03 真实 SIGKILL 与同卷恢复；[事务持久化记录](docs/current-task/2026-11-07-s3b-s3d-wal-recovery.md)、[审计收束](docs/current-task/2026-11-08-closing-review-fixes.md) |
| S4 线性化与验证 |  Vitest | 寄存器搜索、事务依赖图、业务不变量和 Evidence 回放 | 采纳 | V01/V02/V03 Evidence；负例和 INCONCLUSIVE 检查；[S4 记录](docs/current-task/2026-11-07-s4-verification.md) |
| Observer 与 Raft 控制台 |  Edge | Node 观测 API、日志 SSE、拓扑、泳道、调度和设置页 | 采纳，按真实数据修正聚合与未知态 | Vitest、HTTP 验收、Edge 实机、R01/R02 回放；[首批](docs/current-task/2026-11-06-raft-console.md)、[第二批](docs/current-task/2026-11-06-raft-console-timeline.md)、[第三批](docs/current-task/2026-11-06-raft-console-operations.md) |
| 控制台视觉重设计 |  Edge | Warm Soft / Rosé Pine 风格、字体、间距、控件和主题建议 | 部分采纳：整体设计采纳 | Edge 截图、响应式检查、键盘导航和主题切换；[视觉记录](docs/current-task/2026-11-08-console-visual-redesign.md) |
| 控制台最终审计 |  Edge、Compose | 修复 `ClientReply.result` 解析、Leader 选择、复制组边界、写追踪水位和离线数据保留 | 采纳 | 118 项测试、typecheck、build；真实 R01 PASS、事务停服/恢复、写追踪、T03、V02/V03；[最终审计](docs/current-task/2026-11-08-console-final-audit.md) |
| 注释整理 |  Vitest、tsc | 补充模块职责、声明契约、持久化顺序和未知态说明 | 部分采纳：删除了跨层对照和过度解释的注释 | 只改注释；`git diff` 检查无逻辑行；全量测试与 typecheck |

## 复核边界

- AI 生成的 Evidence 读取、聚合和 UI 代码不修改正式 Evidence，也不把推测写成已观测事实。
- 对 `UNKNOWN_OUTCOME`、缺失 RPC/索引、采样水位、SSE 缺口和事务离线等情况，保留 unknown/INCONCLUSIVE，不补造结果。
- 每次提交前运行 `pnpm test`、`pnpm typecheck`；前端改动同时运行 `pnpm build:web`。涉及 Compose、持久化或故障动作时按 `docs/experiments.md` 在隔离环境复跑并保留新 Evidence。
