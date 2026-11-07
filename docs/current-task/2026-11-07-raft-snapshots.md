# Raft 绝对索引与快照

## E3A · 全局日志索引

从 E2 验收提交 `6fd8a5b` 起步。把日志数组偏移集中在 Core 的日志对象中，选举、复制、提交和应用只传绝对索引。当前节点仍使用 0/0 基址，SQLite 文件和 HTTP 接口沿用原形状。

先用非零基址的纯索引测试验证边界、分页和后缀替换，再用 E2 留下的隔离卷启动 E3A，复跑 SMOKE、R01–R04、E1、E2。

19 项测试、类型和 Compose 配置检查通过。使用 E2 隔离卷启动后，原 E2 已确认的值 `after` 经 Leader 一致性读返回。E3A 的 SQLite 适配器、持久化接口和节点 HTTP 接口无差异。

| 回归 | 证据 |
| --- | --- |
| SMOKE | [五节点与旧 API](../../evidence/SMOKE/2026-11-07T10-39-07.948Z--64fe5b78/result.json) |
| R01、R02、R04 | [杀 Leader](../../evidence/R01/2026-11-07T10-39-19.788Z--4dd15faf/result.json) · [分区恢复](../../evidence/R02/2026-11-07T10-39-24.419Z--428f0025/result.json) · [跨任期与持久化探针](../../evidence/R04/2026-11-07T10-39-39.204Z--53d0ad92/result.json) |
| R03 | [采集完成，待 S4 判定](../../evidence/R03/2026-11-07T10-39-27.367Z--8924b5fa/result.json) |
| E1、E2 | [批量写故障](../../evidence/E1/2026-11-07T10-39-28.616Z--94d503bd/result.json) · [Follower 读](../../evidence/E2/2026-11-07T10-39-36.008Z--768f0e74/result.json) |

## E3B · 快照与压缩

E3A 验收后接入已应用边界快照、原子落盘、恢复和 InstallSnapshot。用隔离容器验收日志行数、快照加日志后缀的 SIGKILL 恢复，以及落后 Follower 实际接收快照后继续追加。停点为 E3B。

快照保存已应用 KV 与 `lastIncludedIndex/Term`。SQLite 在同一事务写入快照和裁剪前缀。重启先恢复快照；保留后缀等 Leader 确认提交或新 Leader 提交当前任期条目后才应用。InstallSnapshot 使用单个 HTTP/JSON 请求，走原有链路故障与任期检查，成功应答在落盘之后。匹配边界时保留后缀，过期快照不倒退状态。 [Raft 论文 §7](https://raft.github.io/raft.pdf)

快照由实验端点显式触发。状态接口的 `logLength` 仍是末尾绝对索引，物理日志条数用 `retainedEntries`。不同快照边界以提交和应用索引、提交任期及已应用 KV 摘要对比。同边界额外对比保留日志摘要。

首轮隔离实验从 SQLite 实读到 Leader 的日志行数从 453 降至 0。落后 Follower 从索引 450 恢复后，通过 HTTP 安装索引 453 的快照并应用到 455。持有快照与后缀的 Leader 被 SIGKILL（退出码 137），重启仍从索引 454 开始保留后缀，快照值和后缀值可读，删除的键仍缺失。混合快照边界最终应用到同一索引和状态。 [E3B 首轮结果](../../evidence/E3B/2026-11-07T10-47-33.265Z--d794f364/result.json)

24 项测试、类型和 Compose 配置检查通过。在已压缩卷上继续回归 [R01](../../evidence/R01/2026-11-07T10-47-45.264Z--19c3ff60/result.json)、[R02](../../evidence/R02/2026-11-07T10-47-50.048Z--a1c742b8/result.json)、[E1](../../evidence/E1/2026-11-07T10-47-54.056Z--39229eb5/result.json) 和 [E2](../../evidence/E2/2026-11-07T10-47-59.720Z--d194d3e9/result.json)，均通过。[R03](../../evidence/R03/2026-11-07T10-47-52.999Z--03cde040/result.json) 采集完成，待 S4 判定。[R04](../../evidence/R04/2026-11-07T10-48-02.761Z--dd252a44/result.json) 在相同镜像的隔离卷中通过。

## 审查停点

E3A 本地提交 `3313e2f`。从干净的 E3B 提交 `d559106` 重建后，[五节点冒烟](../../evidence/SMOKE/2026-11-07T10-50-39.301Z--5d6a6e07/result.json)及 [E3B 复跑](../../evidence/E3B/2026-11-07T10-50-57.016Z--9be3bb1d/result.json)通过。复跑 28 项断言，SQLite 153 条保留日志裁至 0，落后节点从 603 安装 606 的快照后应用到 608。SIGKILL 后同一 Leader 卷恢复 606 快照和从 607 开始的日志，节点应用至 610。

隔离项目 `minidb-ext` 已停止，保留五个卷。默认五节点检查均为 healthy。停在 E3B 等待审查和 E4 授权。
