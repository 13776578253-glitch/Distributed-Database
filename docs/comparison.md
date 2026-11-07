# 一致性与架构选型

对比基于两篇系统论文的实现与实验配置。Spanner 的数字来自 OSDI 2012，Dynamo 的数字来自 SOSP 2007。不同工作负载和分位点分别记录。

| 维度 | Google Spanner | Amazon Dynamo |
| --- | --- | --- |
| 一致性 | 分布式事务提供外部一致性，提交顺序遵守已完成事务的真实时间先后，支持同一时间点的跨组快照。 [Spanner §4.1–4.2](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-16.pdf#page=5) | 优先保证写可用性，副本最终收敛。并发版本可同时返回，向量时钟能识别因果祖先，分叉可由应用合并。 [Dynamo §2.3、§4.4](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf) |
| 时间 | TrueTime 给出带不确定性的时间区间，提交等待使事务时间戳与外部顺序兼容。论文单副本、4 KB 操作实验中，提交等待约 **5 ms**。 [Spanner §3–4、§5.1](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-16.pdf#page=9) | 向量时钟表示因果顺序和分叉，部分应用也可选择以物理时间戳进行冲突归并。 [Dynamo §4.4、§6](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf) |
| 分片 | 有序键空间、目录与 Paxos 组，目录可跨机器和数据中心迁移。论文跨区可用性实验配置 **1,250 个 Paxos 组**。 [Spanner §2.1–2.2、§5.2](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-16.pdf#page=10) | 一致性哈希环，论文比较了令牌和固定分区映射策略，图 8 的实验配置为 **30 个节点、N=3**。 [Dynamo §4.2、§6.2、图 8](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf) |
| 复制 | 每组同步 Paxos，跨组写使用两阶段提交。论文中的 F1 配置为 **5 个跨地域副本**。 [Spanner §1、§4.2](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-16.pdf) | 典型副本数 **N=3**。应用可调 N/R/W，故障时使用 sloppy quorum 和 hinted handoff，另用反熵对账。 [Dynamo §4.3、§4.5–4.7、§5](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf) |
| 接口 | 论文实现提供 SQL 查询、读写事务、只读事务与时间戳快照读取。 [Spanner §2.3、表 2](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-16.pdf#page=6) | 两类主接口 `get(key)` 和 `put(key, context, object)`。客户端传回版本上下文，使写能覆盖所观察的因果祖先。 [Dynamo §4.1](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf) |
| 验证 | 论文记录分区组领导者故障和 TrueTime 尾部。图 5 以 **50,000 次读/秒**发压，强制关闭领导区后吞吐先降至近零，约 **10 秒**恢复。 [Spanner §5.2、图 5](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-16.pdf#page=10) | 购物车生产样本连续 **24 小时**，**99.94%** 请求只见一个版本。表 2 的服务器协调配置给出读写 P99.9 分别 **68.9 ms、68.5 ms**。 [Dynamo §6.3、§6.4、表 2](https://cdn.amazon.science/ac/1d/eb50c4064c538c8ac440ce6a1d91/dynamo-amazons-highly-available-key-value-store.pdf) |

本项目选用单复制组 Raft 验证寄存器的实时顺序，另用单节点 MVCC/WAL 验证事务隔离与恢复。这个组合保留了可以独立验证的两个提交边界。Spanner 的全局时间与跨组提交、Dynamo 的多版本分叉与应用合并都要求不同的历史模型。V01–V03 的检查规则与运行结果见 [方向四任务记录](current-task/2026-11-07-s4-verification.md)。
