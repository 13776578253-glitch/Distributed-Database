# Distributed Database

三人课程项目，依次实现 Raft KV、单节点 MVCC/WAL、外部一致性验证。开发顺序见 [PLAN](docs/PLAN.md)，分方向实验见 [实验清单](docs/experiments.md)。

## 启动

使用 Node.js 24.21.0、pnpm 11.25.0 和运行中的 Docker Desktop 或 Docker Engine（含 Compose 插件）。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm demo
```

`pnpm demo` 准备五个独立数据卷，构建并启动 Compose 服务，检查宿主机的 18081–18085 端口，并记录 `evidence/SMOKE/<runId>/`。当前检查级别为 `scaffold-smoke`。

使用 `docker compose down` 停止集群。数据卷由实验脚本创建并由 Compose 以外部卷引用，可跨容器重建保留。`pnpm reset:destructive --confirm` 会移除本项目容器和数据卷，适用于明确要清空实验数据时。

`.scratch/` 用于临时数据和本地试验材料，正式实验输出统一放入 `evidence/`。
