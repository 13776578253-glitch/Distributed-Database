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

使用 `docker compose down` 停止集群。数据卷由实验脚本创建并由 Compose 以外部卷引用，可跨容器重建保留。`pnpm reset:destructive --confirm` 会移除本项目容器和数据卷，适用于明确要清空实验数据时。

`.scratch/` 用于临时数据和本地试验材料，正式实验输出统一放入 `evidence/`。

## Raft 观测控制台

安装依赖后运行 `pnpm console`，打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。端口可用 `CONSOLE_PORT` 指定。

启动器挂接当前 Compose 项目的现有容器。项目没有 Raft 容器时，按 Compose 配置准备外部卷、构建镜像并启动五节点。已有停止的成员保留原状态，退出控制台后集群继续运行。

页面每 3 秒向同源观测 API 请求五个节点的状态。点击节点可查看任期、日志长度、提交和应用索引。单独构建前端可运行 `pnpm build:web`，产物在 `dist/console/`。见[首批验收记录](docs/current-task/2026-11-06-raft-console.md)。

侧栏的「实时事件」使用 SSE 读取容器日志。「实验回放」按 Run 读取 R01–R04 Evidence，支持逐步查看事件、断言与原始文件。见[第二批验收记录](docs/current-task/2026-11-06-raft-console-timeline.md)。
