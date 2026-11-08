# 实验审计索引

从下表选择与报告内容对应的实验和 Run。表中的链接固定到一次运行，重复运行按各自的条件和结果引用。[实验清单](../docs/experiments.md)说明操作与判定口径，[开发计划](../docs/PLAN.md)记录课程报告的交付位置。

## 如何查原始证据

目录为 `evidence/<实验编号>/<UTC 时间戳--随机后缀>/`。每次运行单独归档，按 Run ID 可比较先后。Run 内按下列顺序阅读。

| 文件 | 审计用途 |
| --- | --- |
| `result.json` | 查看总体判定和 `assertionResults`。按断言名称找到数值、状态或反例 |
| `metadata.json` | 核对起止时间、基线 Git SHA、工作树状态、参数和运行环境。遇到 `gitDirty=true` 时，结合阶段记录核对被测版本 |
| `command.txt` | 查看入口命令。旧记录中的环境占位符结合元数据、原始日志与阶段记录解析 |
| `events.jsonl` | 按行核对 UTC 时间、请求、返回、状态和断言。验证 Run 的 `source` 事件列出来源 Run 与文件摘要 |
| `raw.log` | 核对原始命令输出、容器日志和失败原因。事务实验的原始 WAL 内容也可在 `events.jsonl` 的 `crashed-wal` 事件中查看 |

## 方向一 · Raft 与扩展

| 实验 / 报告位置 | 对应的运行 | 数字或核对点 |
| --- | --- | --- |
| R01 · Leader 故障切换 | [基线结果](R01/2026-11-06T10-57-02.353Z--76c65d01/result.json) · [计时事件](R01/2026-11-06T10-57-02.353Z--76c65d01/events.jsonl#L11) | `new leader elected` 的 `elapsedMs=844.327`，从发出故障命令到发现新 Leader。任期从 8 到 9 |
| R01 · 控制台联调复跑 | [收敛采样](R01/2026-11-08T13-50-51.369Z--eb744db2/events.jsonl#L16) · [结果](R01/2026-11-08T13-50-51.369Z--eb744db2/result.json) | 收敛时 `raft-1` 为 Leader，任期 182，5 个节点返回状态 |
| R02 · 分区和恢复 | [基线结果](R02/2026-11-06T10-57-06.906Z--77080c4c/result.json) | `majority confirms a write`、`minority cannot confirm the proposed write` 和 `all five committed prefixes match` 对应分区两侧和恢复后的证据 |
| R03 · 并发历史 | [V01 使用的历史](R03/2026-11-07T12-03-08.334Z--8c1d3503/events.jsonl) · [采集判定](R03/2026-11-07T12-03-08.334Z--8c1d3503/result.json) · [另一次采集](R03/2026-11-08T10-56-09.625Z--8e5f35d6/result.json) | 采集了 6 次调用及返回，原始判定为 `INCONCLUSIVE`。线性化结论见 V01，来源固定到表中第一个 Run |
| R04 · 跨任期提交与持久化 | [探针结果](R04/2026-11-06T11-15-26.546Z--b81c0076/result.json) · [原始探针](R04/2026-11-06T11-15-26.546Z--b81c0076/probe.mjs) | 依次核对旧任期多数派复制、当前任期 no-op 推进提交，以及 SIGKILL 后的持久状态 |
| E0 · 扩展基线 | [结果](E0/2026-11-07T09-59-55.591Z--9ed8ab8e/result.json) · [原始输出](E0/2026-11-07T09-59-55.591Z--9ed8ab8e/raw.log) | 基线测试、类型检查和 Compose 配置的断言与输出 |
| E1 · 批量写吞吐和延迟 | [干净提交复跑](E1/2026-11-07T10-17-40.126Z--a1068c91/result.json#L80) · [首轮](E1/2026-11-07T10-07-32.331Z--e0847ed4/result.json#L80) | 同一断言的 `operationsPerSecond`、`p50Ms`、`p95Ms`。复跑约 506 写/秒、25.5 ms、34.2 ms。首轮约 416 写/秒、24.8 ms、45.2 ms。两轮均为 16 并发、128 次写 |
| E1 · 批量写故障 | [干净提交复跑](E1/2026-11-07T10-17-40.126Z--a1068c91/result.json) | `all unconfirmed writes report unknown outcome` 对应 12 条未知结果，`all confirmed batch entries survive` 对应 128 条确认写 |
| E2 · Follower 读 | [干净提交复跑](E2/2026-11-07T10-17-47.341Z--6409a5ac/result.json) · [首轮](E2/2026-11-07T10-14-48.997Z--b759cafe/result.json) | 复跑中少数派 stale 在应用索引 289 读到旧值，safe 返回 HTTP 503。恢复后 safe 在读索引 291 返回新值。首轮的 stale 索引为 142 |
| E3B · 快照压缩与安装 | [干净提交复跑](E3B/2026-11-07T10-50-57.016Z--9be3bb1d/result.json) · [SQLite 行数](E3B/2026-11-07T10-50-57.016Z--9be3bb1d/result.json#L175) | 28 项断言。SQLite 日志行从 153 到 0，落后节点从 603 安装 606 的快照后应用到 608，故障重启后应用至 610 |
| E4B · 联合配置与移除 | [干净提交复跑](E4B/2026-11-07T12-01-22.592Z--17b84b20/result.json) · [锁冲突失败](E4B/2026-11-07T15-10-59.541Z--77d98c85/result.json) · [修复后复跑](E4B/2026-11-07T15-12-22.393Z--07670022/result.json) | 干净提交复跑共 19 项断言。联合条目索引 18 尚未提交，新增成员后的最终配置在 20，移除后的最终配置在 24 |
| SMOKE · 集群冒烟 | [五节点](SMOKE/2026-11-07T12-02-33.941Z--13aad51c/result.json) · [六节点](SMOKE/2026-11-07T12-01-03.942Z--6b7f112f/result.json) | 分别 18、21 项断言，涵盖健康、镜像、独立卷和 PUT/GET/DELETE |

## 方向三 · MVCC、WAL 与恢复

| 实验 / 报告位置 | 对应的运行 | 数字或核对点 |
| --- | --- | --- |
| T01 · 故障点枚举与 AS OF | [编码修复后复跑](T01/2026-11-08T14-15-50.333Z--f198395b/result.json) · [原始查询](T01/2026-11-08T14-15-50.333Z--f198395b/events.jsonl#L101) · [冻结验收](T01/2026-11-07T13-40-24.781Z--ec341268/result.json) | 两轮分别通过 29 项断言。复跑中的 [COMMIT 与 AS OF 边界](T01/2026-11-08T14-15-50.333Z--f198395b/result.json#L360) 显示 LSN 25 读到旧值，LSN 26 同时出现新值和墓碑。[检查点断言](T01/2026-11-08T14-15-50.333Z--f198395b/result.json#L445) 记录恢复采用完整检查点 31 |
| T02 · 写偏差与显式加锁 | [结果](T02/2026-11-07T13-41-40.891Z--561ddfc6/result.json) · [HTTP 与版本历史](T02/2026-11-07T13-41-40.891Z--561ddfc6/events.jsonl) | 4 项断言。无锁组最终 0 人值班，具名锁组最终 1 人。V02、V03 均使用这次运行的历史 |
| T03 · Undo 中断与 CLR | [编码修复后复跑](T03/2026-11-08T14-17-06.819Z--58518223/result.json#L125) · [原始事件](T03/2026-11-08T14-17-06.819Z--58518223/events.jsonl) · [冻结验收](T03/2026-11-07T13-41-46.480Z--f54ca554/result.json) | 两轮分别通过 13 项断言。复跑重放 CLR 12，继续撤销 UPDATE 9 和 6，UPDATE 10 的 CLR 只生成一次 |
| T03 · 环境故障记录 | [首次复跑失败](T03/2026-11-08T14-16-14.217Z--27c941a6/result.json) · [Docker 错误](T03/2026-11-08T14-16-14.217Z--27c941a6/raw.log#L125) | 创建对照网络时 Docker 默认地址池用尽，终态对照见上行的后续 Run |

## 方向四 · 一致性验证与选型

| 实验 / 报告位置 | 对应的运行 | 数字或核对点 |
| --- | --- | --- |
| V01 · 线性化正例、反例和真实历史 | [结果](V01/2026-11-07T14-45-07.744Z--aa3b0215/result.json) · [R03 来源与 SHA-256](V01/2026-11-07T14-45-07.744Z--aa3b0215/events.jsonl#L1) | 3 项断言。正例有合法顺序，反例第二次读取期望 `a` 而实际为 `b`。指定 R03 的合法顺序为 `2 → 1 → 3 → 4 → 5 → 6` |
| V02 · 依赖图 | [结果](V02/2026-11-07T14-45-07.833Z--4a533f0f/result.json) · [T02 来源与 SHA-256](V02/2026-11-07T14-45-07.833Z--4a533f0f/events.jsonl#L1) | 3 项断言。合成环有 WR、WW、RW 三种边，真实 T02 的无锁组由两条 RW 边构成环，加锁子图无环 |
| V03 · 值班不变量 | [结果](V03/2026-11-07T14-45-07.911Z--30b03c6e/result.json) · [违规事件](V03/2026-11-07T14-45-07.911Z--30b03c6e/events.jsonl#L2) | 2 项断言。无锁组在 `commitSeq=3` 首次违规，实际 0 人、要求至少 1 人。加锁阶段 3 个受检提交通过 |

V01–V03 的 Run 判定 `PASS` 表示检查器得出预期结果。正例、负例和真实历史各自的判定记录在对应断言的 `details.status`。

下表为[六维选型对比](../docs/comparison.md)所引的外部数字。数值和出处集中登记在这里，实验条件以对应论文为准。

| 选型位置 | 原值和实验条件 | 论文定位 |
| --- | --- | --- |
| Spanner · 时间 | 单副本微基准的操作大小为 4 KB，提交等待约 5 ms | [Corbett 等，OSDI 2012，§5.1，表 3 与正文](https://www.cs.utexas.edu/~witchel/380L/papers/corbett12osdi-spanner.pdf#page=9) |
| Spanner · 分片与故障 | 1,250 个 Paxos 组，50,000 次读/秒。强制关闭 Leader 所在区后约 10 秒恢复 | [Corbett 等，OSDI 2012，§5.2，图 5](https://www.cs.utexas.edu/~witchel/380L/papers/corbett12osdi-spanner.pdf#page=10) |
| Spanner · 复制 | F1 在美国不同地理位置部署 5 个副本 | [Corbett 等，OSDI 2012，§1，第 1 页](https://www.cs.utexas.edu/~witchel/380L/papers/corbett12osdi-spanner.pdf#page=1) |
| Dynamo · 分片与复制 | 负载均衡实验使用 30 个节点，副本数 `N=3` | [DeCandia 等，SOSP 2007，§6.2，图 8](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf#page=13) |
| Dynamo · 版本分叉 | 购物车采样 24 小时，99.94% 的请求恰好看到一个版本 | [DeCandia 等，SOSP 2007，§6.3](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf#page=13) |
| Dynamo · 延迟 | 服务器协调配置的 P99.9，读 68.9 ms、写 68.5 ms | [DeCandia 等，SOSP 2007，§6.4，表 2](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf#page=14) |

## 控制台验收与截图

| 实验 | 对应的运行 | 核对点 |
| --- | --- | --- |
| CONSOLE · 浏览器与挂接 | [通过](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/result.json) · [首次失败](CONSOLE/2026-11-06T13-50-40.606Z--161acd35/result.json) | 同源请求、节点详情、隔离集群故障与恢复 |
| CONSOLE-CLI · 命令行与空项目 | [CLI](CONSOLE-CLI/2026-11-06T15-14-04.368Z--5705c5ca/result.json) · [空项目重启](CONSOLE-CLI/2026-11-06T15-17-00.620Z--82a02ffb/result.json) | 冒烟、显式重置与 Observer 重启 |
| CONSOLE-JOB-PHASE · 操作阶段 | [结果](CONSOLE-JOB-PHASE/2026-11-06T15-18-40.289Z--c2081031/result.json) | 重启经过恢复阶段，R03 保留原采集判定 |
| CONSOLE-OPERATIONS · 调度 | [结果](CONSOLE-OPERATIONS/2026-11-06T15-10-19.090Z--b06e3522/result.json) | 实验执行、互斥和恢复 |
| CONSOLE-SSE · 事件流 | [结果](CONSOLE-SSE/2026-11-06T14-55-30.860Z--2d186362/result.json) | 断线补发、容器变化缺口、原始文件访问 |
| CONSOLE-TOPOLOGY · 拓扑 | [结果](CONSOLE-TOPOLOGY/2026-11-06T14-30-30.387Z--b0184220/result.json) | 换届、实际 RPC、节点重新可达 |
| SERVICE · 服务操作 | [节点与 Observer 操作](SERVICE/2026-11-06T15-10-40.396Z--709016de/result.json) · [阶段复核](SERVICE/2026-11-06T15-18-52.326Z--bcefc4a0/result.json) | 服务重启过程、操作结果与恢复状态 |

四张截图均属于 CONSOLE 的 `2026-11-06T13-51-30.946Z--7f1b1871`。该 Run 的 [UTC 时间窗口](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/metadata.json#L2) 为 2026-11-06 13:51:30.946 至 13:51:49.147。逐图采集时间未登记，可从原始命令核对截图对应的场景。

| 截图 | 场景 | 原始命令 |
| --- | --- | --- |
| [desktop.png](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/desktop.png) | 桌面拓扑和节点详情 | [raw.log 第 164 行](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/raw.log#L164) |
| [leader-failure.png](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/leader-failure.png) | 原 Leader 停止后 | [raw.log 第 401 行](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/raw.log#L401) |
| [recovered.png](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/recovered.png) | 原节点恢复后 | [raw.log 第 444 行](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/raw.log#L444) |
| [narrow.png](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/narrow.png) | 窄屏节点列表和详情 | [raw.log 第 485 行](CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/raw.log#L485) |

## 待补证与报告引用

| 已有记录 | 纳入报告前需要补齐的证据 |
| --- | --- |
| [收束记录](../docs/current-task/2026-11-08-closing-review-fixes.md#控制台数据链路)的 118 项测试、1,200 字符键、检查点 7 与 WAL 9 → 12 | 测试的终端原始输出。浏览器联调的独立 Run，包含查询及恢复前后的响应、时间戳和页面截图 |
| [最终审计](../docs/current-task/2026-11-08-console-final-audit.md)中的 1 个演示负载 `UNKNOWN_OUTCOME` | 同时间窗口的演示负载事件或计数采样。该文引用的 R01 Run 可核对集群收敛 |

报告定稿时，每个实测数字旁写明单位和条件，链接到对应文件，并标出事件行号或 JSON 字段。涉及舍入或汇总时保留原值及计算口径。新增复跑分配新的 Run ID，在此更新引用入口。
