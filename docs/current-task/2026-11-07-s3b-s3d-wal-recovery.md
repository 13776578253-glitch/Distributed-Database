# S3B–S3D · 事务持久化、恢复与系统实验

基线 `088d456`。单 Agent 依次完成 S3B、S3C、S3D，每批单独验收与记录，最后合成一个本地提交。实验只接触事务专用 Compose 项目与卷。

## S3B · 数据所有权与刷盘顺序

`TransactionEngine` 仍在一个同步调用内执行 SI 冲突校验与提交决策，`VersionStore` 只接收已提交版本。WAL 独占 LSN 和事务链尾。SQLite 保存待提交与已提交的版本行，版本身份取自 S3A，每次 UPDATE 在其唯一版本 ID 下新建行。物理撤销只删除这个 ID。SQLite 事务把版本修改与全局物化游标 `appliedLsn` 一起提交。

| 动作 | 顺序 |
| --- | --- |
| BEGIN | WAL 持久化事务 ID，再返回可用 ID |
| PUT / DELETE | UPDATE 刷盘，SQLite 落待提交行，再更新内核私有写 |
| COMMIT | 校验冲突，COMMIT 刷盘，SQLite 原子发布各键最后版本并丢弃同事务早期版本，END，再发布内存版本并确认 |
| ABORT | 刷盘 ABORT 与 END，删除待提交行，再清理事务和锁 |

WAL 保留历史。LSN 标识记录，版本 ID 标识版本，commitSeq 标识可见顺序（含只读提交），appliedLsn 标识 SQLite 物化进度。同步持久化失败后结束服务，由重启处理结果。每个数据目录由一个进程独占。S3B 验证记录链接、物理顺序、整笔可见性、提交边界及干净重开后的身份。

S3B 验收通过。全量 52 项测试与类型检查通过，包含原 11 项 MVCC 测试和新增 4 项落盘测试。故障钩子读取 WAL 与 SQLite，验证 COMMIT 刷盘前后均还没有发布版本，只有刷盘后 WAL 中存在 COMMIT。正常返回时两个键已一起发布。

WAL 文件为 UTF-8 JSONL，每条记录携带 `lsn` 和 `prevLsn`。事务记录另有 `txnId`。UPDATE 包含 `key`、`versionId`、`before: null` 与 `after`，其中 before 对应版本行创建前的缺失状态。COMMIT 记录 `commitSeq`，END 记录终态。CLR 引用 `versionId`、`undoneLsn` 与 `undoNextLsn`。CHECKPOINT 记录 `beginLsn`、`appliedLsn` 和活跃链尾。

## S3C · 恢复

静止检查点在同步操作之间捕获活跃事务日志链尾与 SQLite 已落盘边界。CHECKPOINT_BEGIN 之后写完整 CHECKPOINT，恢复只选择完整条目。检查点保留原 WAL 和所有已提交历史版本。

1. Analysis 从最近完整检查点恢复活跃事务表，再扫描后缀，区分 COMMIT、ABORT、END 和 CLR。
2. Redo 从检查点记录的物化边界之后按 LSN 重放 UPDATE、COMMIT、CLR 和结束清理。SQLite 游标提供幂等保护。
3. Undo 沿 loser 的 prevLSN 反向处理。每次先持久化 CLR（目标版本、被撤销 LSN 与 undoNextLSN），再删除该版本。重启先 Redo CLR，再沿 undoNextLSN 接着撤销。
4. 恢复完毕后才建立内存引擎并开放读写。事务 ID 与提交序列从 WAL 的持久化历史恢复。

故障点落在 UPDATE 刷盘后、UPDATE 数据事务提交后、COMMIT 刷盘前后、检查点开始后、Redo 物化后和 CLR 刷盘后。S3C 通过抛出模拟中断、关闭并重开同一目录验证。教学恢复参考 [ARIES 原论文](https://people.eecs.berkeley.edu/~brewer/cs262/Aries2.pdf)。

S3C 验收通过。全量 57 项测试与类型检查通过，新增 5 项恢复测试。恢复补齐刷盘 COMMIT、在重做中断后撤销 loser，并在 CLR 刷盘后的中断中重做该 CLR、沿 undoNextLSN 继续撤销。最新完整检查点保留恢复起点；不完整 WAL 帧会在重开时截断。Windows 测试暴露追加模式无法截断的问题，改用同一读写句柄按显式偏移追加后复测通过。

## S3D · 系统实验

通过独立 Compose 文件运行事务服务，实验进程在启用注入时向自身发送 SIGKILL。每个 Run 使用独立项目和专用卷，采集镜像、容器退出码、挂载、HTTP 调用、WAL、恢复日志和断言。T01 验证提交边界与历史，T02 保存带版本 ID 的值班交错，T03 对照重复恢复和一次恢复的终态。停止容器后保留卷和证据供复核。

全量 57 项测试与类型检查通过，涵盖 35 项 Raft 测试和 20 项事务测试。事务与默认 Raft 的 Compose 配置校验通过。下列三个 Run 共通过 46 项断言，记录 10 次真实 SIGKILL，退出码均为 137，Docker 检查均显示 `OOMKilled=false`。每个 Run 的命令、时间、基础 Git SHA、镜像 ID、事件、原始日志和判定齐全。证据在合并提交前采集，元数据保留 `gitDirty=true`，三个 Run 容器中的 `src/` 已逐文件核对，与本轮提交源码一致。所有实验容器已停止，专用卷保留。

| 实验 | Run ID | 判定 |
| --- | --- | --- |
| T01 | [2026-11-07T13-40-24.781Z--ec341268](../../evidence/T01/2026-11-07T13-40-24.781Z--ec341268/result.json) | 29 项断言通过 |
| T02 | [2026-11-07T13-41-40.891Z--561ddfc6](../../evidence/T02/2026-11-07T13-41-40.891Z--561ddfc6/result.json) | 4 项断言通过。无锁时 0 人值班，具名锁时 1 人。重试读到版本 `txn-6:1`，HTTP ABORT 清除私有 null 版本 |
| T03 | [2026-11-07T13-41-46.480Z--f54ca554](../../evidence/T03/2026-11-07T13-41-46.480Z--f54ca554/result.json) | 13 项断言通过。两次恢复与一次恢复对照的终态和 WAL 一致 |

| 故障点 | 预期 | 实测 |
| --- | --- | --- |
| T01 · UPDATE 刷盘后 | WAL 中有 UPDATE，重启时重做物化 | LSN 7 写入 WAL，第一次重启在 Redo 落盘后终止 |
| T01 · Redo 中 | 再启动跳过已物化动作并撤销 loser | 跳过已物化的 LSN 7，撤销该 UPDATE |
| T01 · 未提交数据落盘后 | 原卷存在待提交版本，恢复撤销 | LSN 12 跳过 Redo 并被 Undo，已确认值保留 |
| T01 · 写 COMMIT 前 | 无 COMMIT，整笔撤销 | LSN 18、17 均撤销，两个键保留先前值 |
| T01 · COMMIT 刷盘后 | 即使客户端连接断开，两键也一起恢复 | LSN 26 重放成功，AS OF 25 是旧状态，AS OF 26 同时出现新值与墓碑 |
| T01 · 检查点中 | 从上一完整检查点恢复 | 跳过未完成的检查点开始记录 LSN 32，使用检查点 31 并撤销 LSN 29 |
| T01 · 恢复完成后再次 SIGKILL | 重启终态和历史稳定 | WAL 相同，无额外 Redo 或 Undo，历史查询一致 |
| T03 · CLR 刷盘后 | 重放已持久 CLR，沿 undoNextLsn 撤销余项 | 重放 CLR 12，随后撤销 UPDATE 9 和 6。UPDATE 10 的 CLR 只生成一次，与一次完整恢复的终态相同 |

本轮沿用 S3A 的同步事务引擎和版本选择规则。新增同步持久化边界、版本物化、恢复流程与服务进程。WAL 与已提交历史保留全量，启动仍读取 WAL、装载已提交版本。每条 WAL 记录同步刷盘，同一数据目录按单进程使用。检查点缩短实际恢复扫描范围，磁盘增长和启动装载成本留作当前实现的边界。

停在 S3D 等待统一审查。
