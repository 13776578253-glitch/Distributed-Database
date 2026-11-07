# Distributed Database

三人课程项目，依次实现 Raft KV、单节点 MVCC/WAL、外部一致性验证。见[开发计划](docs/PLAN.md)、[任务记录](docs/current-task/)和[实验清单](docs/experiments.md)。

## 启动

使用 Node.js 24.21.0、pnpm 11.25.0 和运行中的 Docker Desktop 或 Docker Engine（含 Compose 插件）。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm demo
```

`pnpm demo` 准备五个独立数据卷，以同一镜像重建 Compose 容器，检查宿主机的 18081–18085 端口，选出 Leader 后执行 put/get/delete，并记录 `evidence/SMOKE/<runId>/`。

集群启动后，可顺序执行 `pnpm experiment R01`、`pnpm experiment R02` 和 `pnpm experiment R03`。R03 负责采集历史，验证结论在 S4 生成。实验会杀死并重启项目容器或临时阻断节点间 HTTP RPC。

节点的角色、任期和提交进度通过 `GET /internal/raft/status` 查看。向 Leader 发 `POST /kv/put`（`{ "key": "x", "value": 1 }`）、`GET /kv?key=x` 和 `POST /kv/delete`（`{ "key": "x" }`）。GET 返回 `found`，可区分键缺失和已保存的 JSON null。收到 `UNKNOWN_OUTCOME` 时，应保留该操作的历史供验证器处理。

Follower 上可显式调用 `GET /kv?key=x&consistency=stale` 或 `GET /kv?key=x&consistency=safe-follower`。前者返回本地已应用值和 `appliedIndex`，分区时可能返回旧值。后者取得 Leader 的新鲜读屏障后在本地读，返回 `readIndex`、`appliedIndex` 与屏障任期，无法完成则返回 `NO_QUORUM`。普通 GET 继续由 Leader 服务。

## 扩展验收

在 PowerShell 使用独立 Compose 项目和端口运行扩展实验。

```powershell
$env:RAFT_LAB_NAME = 'minidb-ext'
$env:RAFT_PORT_PREFIX = '1818'
pnpm demo
pnpm experiment E1
pnpm experiment E2
docker compose down
```

E1 记录批次和 Leader 崩溃前后的写结果，E2 对比分区中的三种读。结果与恢复步骤见[实验清单](docs/experiments.md)。

使用 `docker compose down` 停止集群。数据卷由实验脚本创建并由 Compose 以外部卷引用，可跨容器重建保留。`pnpm reset:destructive --confirm` 会移除本项目容器和数据卷，适用于明确要清空实验数据时。

`.scratch/` 用于临时数据和本地试验材料，正式实验输出统一放入 `evidence/`。
