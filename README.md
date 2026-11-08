# Distributed Database

三人课程项目，依次实现 Raft KV、单节点 MVCC/WAL、外部一致性验证。见[开发计划](docs/PLAN.md)、[系统设计](docs/system-design.md)、[AI 使用记录](AI_USAGE.md)、[任务记录](docs/current-task/)和[实验清单](docs/experiments.md)。

## 单节点事务服务

```sh
docker compose -f compose.transaction.yaml up -d --build transaction
docker compose -f compose.transaction.yaml port transaction 8080
```

使用返回的本地端口调用 `GET /health`、`GET /txn/status`。`POST /txn/begin` 接收 `{"isolation":"SI"}` 或 RC，可选 `lock`。随后在 `POST /txn/<id>/read|put|delete|commit|abort` 操作，读写请求使用 `key`，PUT 另传 `value`。`GET /txn/as-of?key=x&lsn=N` 按 WAL LSN 读取已提交历史。实验观测入口为 `GET /internal/txn/wal`、`GET /internal/txn/recovery` 与 `POST /internal/txn/checkpoint`。默认启动关闭故障注入。

```sh
pnpm txn:experiment T01
pnpm txn:experiment T02
pnpm txn:experiment T03
docker compose -f compose.transaction.yaml stop transaction
```

每条实验命令独立启动专用容器和卷，证据写入 `evidence/<ID>/<Run ID>/`。详情见[方向三实验](docs/experiments.md#方向三--mvccwal)。

## 启动

使用 Node.js 24.21.0、pnpm 11.25.0 和运行中的 Docker Desktop 或 Docker Engine（含 Compose 插件）。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm demo
```

`pnpm demo` 准备五个独立数据卷，以同一镜像重建 Compose 容器，检查宿主机的 18081–18085 端口，选出 Leader 后执行 put/get/delete，并记录 `evidence/SMOKE/<runId>/`。

集群启动后，可顺序执行 `pnpm experiment R01`、`pnpm experiment R02` 和 `pnpm experiment R03`。R03 负责采集历史，`pnpm verify V01 <R03-run-id>` 生成独立验证结果。实验会杀死并重启项目容器或临时阻断节点间 HTTP RPC。

`pnpm verify` 离线回放已记录的 R03 和 T02，生成 V01–V03 的新 Evidence，覆盖线性化、事务依赖环和值班不变量。见 [回放报告](docs/current-task/2026-11-07-s4-verification.md)和[架构选型](docs/comparison.md)。

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
pnpm experiment E3B
docker compose down
```

E1 记录批次和 Leader 崩溃前后的写结果，E2 对比分区中的三种读，E3B 在隔离卷上实际压缩日志、让落后节点安装快照，并杀死和重启持有快照的 Leader。结果与恢复步骤见[实验清单](docs/experiments.md)。

快照由实验环境的 `POST /internal/raft/snapshot` 显式触发。状态接口保留 `logLength` 表示末尾绝对索引，新增 `snapshotIndex`、`snapshotTerm` 和 `retainedEntries`。压缩后 `committedDigest` 覆盖保留的已提交后缀，不同快照边界的节点用 `appliedDigest` 对比已应用 KV。已压缩的卷应使用支持快照的版本打开，回退 E3A 时使用压缩前的卷。

### E4 成员变更

在 PowerShell 选择专用实验项目。预配置的 `raft-6` 起初只追赶日志，五个原节点仍是初始投票成员。

```powershell
$env:RAFT_LAB_NAME = 'minidb-members'
$env:RAFT_PORT_PREFIX = '1838'
$env:RAFT_MEMBERSHIP = '1'
pnpm demo
pnpm membership status
pnpm experiment E4B
docker compose --profile membership down
```

可用 `pnpm membership set raft-1 raft-2 raft-3 raft-4 raft-5 raft-6` 提交一组目标投票成员。HTTP 202 表示联合条目已在 Leader 本地追加。用 `pnpm membership status` 查看 `membership` 与 `appliedMembership`，后者成为目标稳定配置时才算变更完成。一次只接受一个变更，加入者先追到提交边界，移除者保留容器和数据卷用于恢复或重新加入。

使用 `docker compose down` 停止集群。数据卷由实验脚本创建并由 Compose 以外部卷引用，可跨容器重建保留。`pnpm reset:destructive --confirm` 会移除本项目容器和数据卷，适用于明确要清空实验数据时。

`.scratch/` 用于临时数据和本地试验材料，正式实验输出统一放入 `evidence/`。

## Raft 观测控制台

安装依赖后运行 `pnpm console`，打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。端口可用 `CONSOLE_PORT` 指定。

启动器挂接当前 Compose 项目的现有容器。项目没有 Raft 容器时，按 Compose 配置准备外部卷、构建镜像并启动五节点。已有停止的成员保留原状态，退出控制台后集群继续运行。

页面每 3 秒向同源观测 API 请求节点状态。点击节点可查看任期、提交和应用索引、快照边界和投票配置。常规集群有五个成员，隔离成员实验用 `RAFT_MEMBERSHIP=1` 启用第六个节点。单独构建前端可运行 `pnpm build:web`，产物在 `dist/console/`。

侧栏按 Raft、事务、一致性验证和设置四组收束；Raft 内用「集群 / 实时事件 / 实验回放」三个页签切换。Raft 页的「实时事件」页签使用 SSE 读取容器日志，泳道按时序展示角色区间、按逻辑复制聚合的 RPC 节拍和故障窗口；选中一条 PUT 或 AppendEntries 可查看请求、复制、提交和应用的证据追踪，缺失证据显示未观测。下方表格保留逐条原始事件与筛选。页面可启动非破坏性演示负载，按 1/2/5 ops/s 对 `demo/` 前缀执行写读删；请求与响应进入实时事件，实验期间自动暂停。「实验回放」页签可执行 R01–R03，并按 Run 查看 R01–R04 的事件、断言与原始 Evidence。「设置」展示实际监听地址和 Compose 容器状态，支持重启单节点或 Observer，以及配置本地轮询、时间格式、实时日志显示上限和主题。

网页操作与 `pnpm experiment` 共用项目锁。R01、R02 会对控制台当前挂接的 Compose 项目执行故障实验。R04 作为历史探针回放。见[实时事件验收](docs/current-task/2026-11-06-raft-console-timeline.md)和[调度验收与恢复说明](docs/current-task/2026-11-06-raft-console-operations.md)。

「事务」页面提供只读 MVCC 历史查询、WAL 和恢复报告。运行 `docker compose -f compose.transaction.yaml up --build -d` 启动独立事务服务后，Observer 自动发现其本机端口。隔离实例可用 `CONSOLE_TXN_PROJECT` 指定 Compose 项目。事务服务停止时仍可回放 T01–T03。

Verification 从 V01–V03 Evidence 展示线性化顺序、反例、事务依赖和不变量结果，并链接原始操作历史。使用 `pnpm verify` 生成新的验证记录。R03 原采集的 `INCONCLUSIVE` 与 V01 的独立判定分别保留。
