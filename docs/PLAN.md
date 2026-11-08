# 开发顺序

Raft 扩展 E0–E4 已完成，补齐[协议边界回归](current-task/2026-11-07-raft-protocol-freeze.md)后冻结。验收记录见 [E0–E2](current-task/2026-11-07-raft-extensions-e0-e2.md)、[E3](current-task/2026-11-07-raft-snapshots.md)和 [E4 联合配置](current-task/2026-11-07-raft-membership.md)。

Raft、MVCC/WAL 和一致性验证的后端核心已验收并冻结。后续范围为注释、文档、可视化探针和前端所需数据结构。

| 阶段 | 状态 | 范围 |
| --- | --- | --- |
| S0 · 脚手架 | 已验收 | 公共契约、工具链、Compose 冒烟 |
| S1 · Raft 纯核心 | 已验收 | 选举、复制、提交与读屏障 |
| S2 · 容器 Raft | 已验收 | R01/R02 和 R03 历史采集，R03 判定在 S4 |
| S3A · MVCC | 已实现 | [内存事务、版本链与历史契约](current-task/2026-11-07-s3a-mvcc.md)，确定性隔离与写偏差通过 |
| S3B · WAL | 已验证 | 独立 WAL、SQLite 版本落盘与提交边界 |
| S3C · Recovery | 已验证 | Checkpoint、Analysis/Redo/Undo、CLR 与恢复中断 |
| S3D · 系统实验 | 已验证 | [独立事务服务及 T01/T02/T03 证据](current-task/2026-11-07-s3b-s3d-wal-recovery.md)，真实 SIGKILL 和原卷恢复 |
| S4A–S4D · 一致性验证 | 已验收 | [V01/V02/V03、R03 与 T02 回放](current-task/2026-11-07-s4-verification.md)，以及[六维选型对比](comparison.md) |
| S5 · 课程交付 | 进行中 | 注释已补；[系统设计](system-design.md)和 [AI 使用记录](../AI_USAGE.md)已整理；控制台小修记录已合并，报告待收束 |

实验运行器通过公开 API 或故障接口操作。Raft term 和 log index、事务 LSN、实验 operation ID 各自独立。

三个方向的复现入口见[实验清单](experiments.md)。系统设计、选型对比和报告分别放在[系统设计](system-design.md)、[选型对比](comparison.md)和 `docs/report.pdf`；时序图包含在系统设计中，成稿后逐项查看。

审计收束分两批。先修复事务键编码并验证旧库升级与崩溃恢复，再收束演示会话、写追踪、事务恢复采样和 AS OF 输入透传。结果见[审计收束记录](current-task/2026-11-08-closing-review-fixes.md)。

## 数据库观测控制台

第一批已交付一键启动、五节点状态聚合、拓扑和节点详情。见[首批任务记录](current-task/2026-11-06-raft-console.md)。第二批已接入[实时事件与实验回放](current-task/2026-11-06-raft-console-timeline.md)，第三批已接入[实验调度和服务管理](current-task/2026-11-06-raft-console-operations.md)。冻结版联调接入 Transaction、Verification 和 Raft 扩展状态。

### 进程和数据流

- `web/` 使用 React、TypeScript 和 Vite，拥有路由、筛选、选中项和本地显示偏好。开发时由 Vite 将 `/api` 转发给本机观测 API，演示时由观测服务同源提供构建产物与 API。浏览器只连接一个地址。
- `src/observer/` 是独立的宿主机 Node.js 进程。聚合现有五个节点的 HTTP 状态，监听本项目容器日志，只读访问 Evidence。允许有限的观测缓存，协议状态以节点响应为准。前端与观测服务通过 HTTP 和日志读取信息，SQLite 文件由 Raft 节点独占访问。
- 拟新增 `pnpm console`。先检查 Docker 和项目状态，已有项目集群直接挂接，全新环境复用卷创建和 Compose 启动逻辑。部分节点退出、集群正在实验或 Docker 暂不可用时，控制台展示现状及原因。退出控制台释放其 HTTP 和日志监听进程，集群生命周期独立。这里的进程接入指发现并监听本项目容器的状态和标准输出。
- `scripts/` 继续拥有实验动作、恢复步骤与 Evidence 写入。后续 CLI 与网页经同一个本机调度入口运行白名单任务。调度器独占集群变更操作，将任务状态关联到实际 `runId`。结果取自 Evidence，调度异常单独展示。节点重启也经过该入口，实验期间互斥。

### 首版读接口

| 接口（拟定） | 数据与行为 |
| --- | --- |
| `GET /api/cluster` | 并行读取各节点 `/internal/raft/status`，每节点独立超时并校验身份。默认五节点，成员实验配置六节点。同一采样合并在途请求，客户端默认 3 秒轮询。 |
| `GET /api/events/stream` | 第二批启用。共享 Docker 日志监听，以带时间戳的真实输出解析角色、投票、追加和阻断事件。SSE 提供心跳、事件 ID、有界补发和缺口提示。监听在容器更换后重新挂接，历史排序保留来源与各自时钟信息。 |
| `GET /api/runs`、`GET /api/runs/:experimentId/:runId` | 第二批启用。读取已记录的结果、元数据和 JSONL，按 Run ID 和文件白名单打开原始证据。按 `events.jsonl` 的时间戳回放，旧 `raw.log` 作为独立原文查看。 |
| `GET /api/services` | 返回实际监听地址、Observer PID、Compose 容器状态、日志采集状态和项目操作锁。节点 HTTP 探测仍由集群状态接口提供。 |
| `GET /api/operations`、`POST /api/operations` | 查询任务与项目锁，或提交 R01–R03、指定项目成员重启。 |
| `POST /api/services/restart-observer` | 获取项目锁后，由启动器重启 Observer。 |
| `GET /api/transaction/{status,wal,recovery,as-of}` | 发现独立事务 Compose 项目的本机端口，转发到冻结服务对应的四个只读 HTTP 接口。 |

首页分别展示 HTTP 可达数、节点自报 Leader 和 `ready`。节点详情展示当前投票配置，包括联合配置的两个成员组。实时协议多数派显示待观测。实验回放可显示 Evidence 中实际记录的分组和结果。采样出现多个自报 Leader 时保留各自节点与任期。

### 五个页面

| 页面 | 第一、二批展示 | 后续接入 |
| --- | --- | --- |
| Raft Cluster | 展示采样时效、可达数和 Leader。拓扑保留五个成员，由最高观测任期的唯一自报 Leader 占顶位，近期 RPC 应答来自容器日志。点击节点查看任期、日志进度和近期应答。窄屏将拓扑和详情纵向排列。 | 按条目查看节点副本、提交与应用状态。 |
| Raft Timeline | 实时和实验回放两种模式，按节点、任期、事件类别筛选，追加批次支持按索引范围匹配。选中一条后查看来源和原始 JSON。实时可暂停自动跟随。 | RPC 失败与复制聚合已接入；精确提交/应用时间仍为采样观测。 |
| Transaction | 展示活动事务、WAL 进度、按键筛选的版本写入、按 LSN 历史查询、Checkpoint 和 Analysis/Redo/Undo/CLR，并可回放 T01–T03。 | 事务写操作继续由实验入口管理。 |
| Verification | 从 V01–V03 显示线性化顺序、依赖边和不变量反例，链接实际来源 Run。R03 原采集保留 `INCONCLUSIVE`。 | 通过 `pnpm verify` 生成新记录。 |
| Settings | 服务监听和 Docker 状态只读。数据刷新、12/24 小时制及浅色/深色/跟随系统为本地偏好。日志策略先提供显示过滤、暂停跟随和有界缓存。 | 观测服务重启由启动器管理。项目节点重启走调度器，展示执行、恢复与失败状态。 |

侧栏按 Raft、事务、一致性验证和设置四组收束；Raft 内用集群、实时事件、实验回放三个页签切换，`#/timeline` 与 `#/runs` 路由保留用于深链。

实时事件页可启动非破坏性演示负载，按 1/2/5 ops/s 对 `demo/` 前缀执行写读删；请求、响应和 Raft 复制事件共用 SSE、泳道和原始 JSON，实验期间自动暂停。

Timeline 将同一任期、索引和条目载荷的 follower 应答聚合为复制组，默认只显示组刻度和当前焦点弧线；选中 PUT 或 AppendEntries 时关联请求、复制、提交和应用采样，缺失证据显示未观测。精确提交/应用时间仍是采样观测。

拓扑节点按成员固定槽位，Timeline 的 1 秒时钟只驱动泳道内部重绘；选中事件、表格列宽和追踪面板在数据增量更新时保持稳定，轮询失败保留最后成功快照。

视觉采用 Rosé Pine Dawn 暖象牙画布、奶油表面、24px 大圆角和低对比暖边框；标题与指标使用系统 Serif，正文、表格和控件使用 Sans，索引与 LSN 使用 Mono。主交互、聚焦和选中态使用蓝色（浅色 `#4a7fa3`/`#2f5c7a`，深色 `#8ab8d9`）；Iris 仅保留在页头品牌、顶部图标和主题预览等小面积点缀。警告为 Gold，危险为 Love；深色主题使用 Rosé Pine 深色底并单独校准。背景使用纯色暖象牙画布，去除蓝色光晕、波纹和等高线纹理；页面标题头使用纯色 banner、72px 高度和 1.25rem Serif 标题。触感来自柔和双层阴影和 inset 高光，不使用厚拟物。设置页提供浅色/深色/跟随系统三段式主题 pill。角色和故障状态同时使用文字与颜色，任期、索引和原始日志使用等宽数字，节点与详情支持键盘导航。刷新保持节点位置，连接状态变更提供可访问提示。

### 待讨论的 Raft 观测接口

1. 提供带节点身份和任期的只读 Leader 复制进度。进度只在该 Leader 任期内解释，`matchIndex` 表示 Leader 收到的匹配确认，`nextIndex` 表示下一次尝试发送的位置。
2. 增加按索引读取条目标识的只读接口。对照索引、条目任期与内容摘要，区分同索引不同条目、本地存在、已提交、已应用、缺失及未知；节点失联显示未知。
3. 在实际提交和应用边界记录推进区间及时间，采用节点内顺序。当前索引只能提供查询时的进度，应用时间来自实际事件。评估现有状态接口计算已提交前缀摘要的开销后，再决定高频轻量读接口的范围。

### 按批验收

1. **启动与 Cluster**。在已有集群上挂接，在空项目环境完成启动，Docker 不可用仍可打开控制台。现场对照五个状态接口。停一个节点时其余卡片正常更新，恢复后同一位置重新显示数据。网络请求走同源 API。
2. **Timeline 与 Evidence**。复用 R01、R02、R03、R04 既有 Run 验证读取，校验 R01 的杀 Leader、新任期、恢复与原始记录一一对应。断开 SSE、重启节点、重建容器后验证恢复、去重或缺口提示，历史浏览独立于实时轮询。
3. **调度与服务管理**。复用 R01/R02 脚本各生成一个新 Run，检查执行期间互斥、恢复步骤、原始证据和最终判定。R04 保持历史回放，待正式纳入运行器后再开放执行。

每批执行 `pnpm test`、`pnpm typecheck` 和前端构建。涉及 Compose、持久化和故障动作的批次使用隔离环境复现并保存新 Evidence。
