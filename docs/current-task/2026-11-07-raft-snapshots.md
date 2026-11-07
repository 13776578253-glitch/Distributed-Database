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
