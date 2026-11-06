# 启动五节点 Compose 并验收 Raft KV

2026-11-06。根据当轮要求、本地提交和原始证据补录。

## 任务与起点

用户要求先把 `.scratch/` 加到忽略规则，再从方向一开始实现并启动 Compose 容器。开工时本地 `main` 和 `origin` 已配置，仓库尚无提交。Node.js 24.21.0 和 Docker Engine 可用，本机已有对应的 Node 镜像。

## 实施与验收口径

- 在 [Compose](../../compose.yaml) 中用同一个镜像启动五个 Raft 节点，每个节点挂自己的卷并发布单独的健康端口。用 [启动脚本](../../scripts/demo.ts) 核对容器、镜像和卷。
- 先在 [Raft 核心](../../src/raft/core/node.ts) 用可控时钟、内存存储和消息队列验证选举、复制与提交，再接 HTTP RPC 和 SQLite。核心拥有任期、投票、日志、提交进度和 KV。任期、投票与日志先持久化再应答，写入提交并应用后才确认。
- 读路径等当前任期 no-op 提交，再通过带本次读标识的 RPC 获得多数派确认，从已应用状态取值。失去多数派时，已提议的写返回 `UNKNOWN_OUTCOME`，读返回 `NO_QUORUM`。
- 用 `pnpm test`、`pnpm typecheck`、`docker compose config --quiet` 和 `pnpm demo` 验证基本路径。真实容器上杀 Leader、模拟双向 3–2 RPC 分区并核对恢复。并发历史单独采集，交给验证器回放。

## 启动与实现记录

1. 创建 `.scratch/` 并加入 Git 和 Docker 忽略规则。五节点占位容器通过 15 项健康、镜像和挂载检查。重复运行一度因旧容器仍引用上一版镜像失败，随后让脚本重建项目容器并核对当前镜像。外部卷继续挂载。[通过记录](../../evidence/SMOKE/2026-11-06T10-43-09.162Z--1e992354/result.json) · [失败记录](../../evidence/SMOKE/2026-11-06T10-42-13.385Z--19304613/result.json)。本地提交 `cc4a4e2`。
2. 纯核心通过 7 项确定性测试，覆盖投票持久化、日志新旧比较、按序应用、旧任期条目不能仅靠多数副本提交、读屏障、分区恢复及全节点重启。加上 2 项契约测试共 9 项，类型检查通过。[核心测试](../../tests/raft/core.test.ts)。本地提交 `f49fe53`。
3. 接入 HTTP 与节点卷上的 SQLite。节点重启后重放已提交日志恢复 KV。GET 使用 `/kv?key=...`，可传递含点号或斜杠的键。故障接口只更改 HTTP 传输层的对端阻断表。五个容器通过验收后均为 `healthy`，宿主机端口为 18081–18085。本地实现提交 `90d642a`，复跑证据提交 `694f694`。

## 容器复跑结果

`pnpm test` 9 项通过，`pnpm typecheck` 和 `docker compose config --quiet` 通过。下表使用提交 `90d642a` 复跑，四次运行的镜像一致。

| 验收 | 结果 |
| --- | --- |
| [SMOKE](../../evidence/SMOKE/2026-11-06T10-56-45.707Z--a7f97de8/result.json) | 18 项通过，覆盖五节点健康、独立卷及 put/get/delete |
| [R01](../../evidence/R01/2026-11-06T10-57-02.353Z--76c65d01/result.json) | 从发出 SIGKILL 命令到发现新 Leader 约 844 ms。新 Leader 读到最后一次确认的写入，旧节点重启后收敛 |
| [R02](../../evidence/R02/2026-11-06T10-57-06.906Z--77080c4c/result.json) | 多数派确认写入，少数派写返回 `UNKNOWN_OUTCOME`、读返回 `NO_QUORUM`。恢复后五节点提交前缀一致 |
| [R03](../../evidence/R03/2026-11-06T10-57-09.811Z--f77dfa23/result.json) | 已采集 6 条包含重叠调用的操作，线性一致性判定待 S4 |

启动与 R01/R02 已验收。复现命令见[实验清单](../experiments.md)。
