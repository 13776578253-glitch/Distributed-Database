# Raft 四项扩展设计

实施顺序为 E0 → E1 → E2 → 验收停点 → E3A → E3B → E4A → E4B。E0–E2 继续用固定五节点和现有 SQLite 日志。扩展仅属于 Raft，事务 WAL 和外部历史检查器仍独立。

| 阶段 | 源码落点与行为 | 独立验收 |
| --- | --- | --- |
| E0 基线 | 固定源码提交与 R01–R04。处理 `api/http.ts` 的请求目标解析和 `adapters/http-transport.ts` 的响应形状及网络错误边界。给 Compose 的项目名、卷、镜像和端口加实验隔离参数。 | 原测试和类型检查通过。非法 URL 返回 400 后健康接口仍可用。对端坏响应丢弃并记录，正常响应继续进 Core。扩展集群与默认集群资源分开。 |
| E1 批量提交 | `api/write-batch.ts` 将同一任期内并发的 put/delete 合并。最多 64 条，最长等待 5 ms。`core/node.ts` 用一次 `Storage.replaceSuffix` 写入这一批连续日志。每条仍按自己的索引等待提交与应用，原 HTTP 路径和响应形状沿用。 | 可控存储验证单事务和逐条结果。真实容器记录并发吞吐、P50/P95、批次数与大小。已确认批次经 SIGKILL 后可读。少数派的已落盘未确认批次在故障后按未知结果处理，验证构造出的冲突后缀被替换。 |
| E2 Follower Read | `GET /kv?key=…` 维持 Leader 读。显式 `consistency=stale` 从 Follower 本地读取，回报已应用索引。显式 `consistency=safe-follower` 通过 `/internal/raft/read-index` 向已知 Leader 获取本次读的安全索引，由 Follower 等待本地应用再取值。 | 正常路径三种模式结果符合各自合同。3–2 分区内多数派更新后，少数派 stale 返回旧值，safe 和旧 Leader 读拒绝。恢复后 safe 返回新值。另测 Follower 落后时必须等本地应用。 |
| E3A 全局索引 | 将 `core/node.ts` 的 `log.length`、`termAt(index)`、`slice`、应用偏移收口到日志索引表示。用 `baseIndex/baseTerm` 表达基址，默认 0/0。`adapters/sqlite.ts` 继续按绝对索引存条目。此阶段只迁移索引。 | 现有数据库可以重开，投票、回退、提交和读索引沿用原语义。全部旧测试、SMOKE、R01–R04 和 E1/E2 用例回归。 |
| E3B 快照与压缩 | `core` 在已应用边界导出 KV、`lastIncludedIndex/Term`。`sqlite.ts` 原子保存快照和删除覆盖前缀，启动先恢复快照再重放后缀。`main.ts`、HTTP 适配器接 InstallSnapshot，落后节点越过压缩边界后继续 AppendEntries。 | 快照前后读值一致、日志行数减少，SIGKILL 后快照及后缀均能恢复。断开落后节点直到 Leader 压缩，重连后实际发生 InstallSnapshot 并收敛。匹配基址时保留有效后缀，冲突时舍弃。 |
| E4A 配置安全 | `core/types.ts` 增加配置命令，`core/node.ts` 及索引、恢复路径从日志与快照重建有效配置。用 `C_old → C_old,new → C_new`，联合阶段要求旧组和新组各自多数，覆盖选举、提交与 ReadIndex。配置冲突回退时重算有效配置。 | 纯 Core 测试覆盖任一组单独达多数、联合配置未提交时 Leader 崩溃、旧 Leader 被移出、配置日志截断和重启。一次只允许一个变更。 |
| E4B 真实成员变更 | 在 E4A 通过后，把节点身份与可达地址配置接入 Docker、HTTP 和控制台。新增成员先同步，配置由 Raft 日志推进。移除成员停止参选和服务一致性读写。 | 真实 Compose 执行加入、移除及 Leader 在联合阶段崩溃，恢复后核对成员、日志前缀和已确认写。 |

## E1 · 批次与确认

`POST /kv/put|delete → 5 ms 队列 → executeWrites → 一次本地 SQLite 事务 → AppendEntries → apply → 对应请求完成`。

批次的身份是入队时的 Leader 任期。批次落盘前若已降级或换任期，返回 `NOT_LEADER`。SQLite 按索引一次写入全部命令。Leader 继续遵循当前任期提交规则，逐条应用，依索引解决各自等待者。批次允许只提交一个前缀，客户端各自收到结果。已追加的写超时或遇到降级时返回 `UNKNOWN_OUTCOME`。公开接口保持单条语义。

## E2 · 三种读取路径

| 模式 | 请求目标 | 值与失败边界 |
| --- | --- | --- |
| 默认 Leader read | Leader | 本次读取得多数派确认后返回。旧 Leader 失去多数派时拒绝。 |
| `consistency=stale` | Follower | 读取本地已应用 KV，带 `appliedIndex`。可能返回旧值或缺失。 |
| `consistency=safe-follower` | Follower | 在该次请求开始后向已知 Leader 请求新鲜 ReadIndex。等 Follower 的 `lastApplied >= readIndex` 后从本地读取，返回认证任期和读/应用索引。取不到屏障或到期未应用则返回 `NO_QUORUM`。 |

Leader 与 Safe Follower Read 共用 Core 的多数派屏障。屏障必须位于当前任期 no-op 提交之后，确认来自同一任期且带本次或更晚的读标识。Follower 请求经过已有阻断和超时机制。应用索引已包含指定前缀时，可读取到本次调用期间更晚的已提交值。 [Raft 论文 §8](https://raft.github.io/raft.pdf#page=13) · [etcd Raft 的 Follower ReadIndex](https://go.etcd.io/etcd/raft/v3#ReadState)

## E3/E4 代码落点

- E3A 将索引换算迁入 `RaftLog`。E3B 用已应用索引生成快照。过期快照跳过，安装成功在快照与日志变更落盘后回复。 [绝对索引](../src/raft/core/log.ts#L4) · [复制入口](../src/raft/core/node.ts#L359) · [Raft 论文 §7](https://raft.github.io/raft.pdf)
- E4A 按论文的联合共识，从本地最新配置日志计算有效投票集，配置还未提交时也按该日志状态计算。联合条目提交后才追加最终配置。把 `startElection`、`advanceCommit` 和 `completeReads` 接到同一双多数判定，去掉固定门槛。E4B 再执行实际加入、删除和 Leader 崩溃复验。 [现有选举](../src/raft/core/node.ts#L290) · [现有提交](../src/raft/core/node.ts#L449) · [现有读屏障](../src/raft/core/node.ts#L486) · [Raft 论文 §6](https://raft.github.io/raft.pdf)
