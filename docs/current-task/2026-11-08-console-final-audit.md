# 控制台最终真实性审计

2026-11-08，`main`。范围是 Observer 数据投影、Demo Runner、Timeline/泳道/写追踪、事务页与 Evidence 可达性。Raft/MVCC 协议、Evidence 格式和页面视觉设计不重构；本轮只修正数据语义、证据等级、时间边界和完成收束。

## P0：已确认问题与修复

- **Demo Runner 没有读取 Raft `ClientReply.result`**。成功 GET 总被判为 absent，PUT/DELETE 靠硬编码 outcome；现统一解析嵌套 `result`，GET 区分 found/absent，PUT 校验 stored，DELETE 区分 deleted/absent，非法成功响应标为 `INVALID_RESULT`。`classifyReply` 用于真实请求循环。
- **Leader 规则只看自报 Leader**。现在先对全部有效节点取最高观测任期，再要求该任期唯一 Leader；低任期 Leader 不再压过高任期 follower 证据。Demo 与拓扑共用同一判定语义。
- **复制组混淆不同 RPC 尝试**。身份现在包含 leader、term、索引范围和完整条目载荷；同一 follower 在同一载荷上重复出现即开启新尝试，超过 500ms 的同载荷事件也分段，不再用后一次 reply 覆盖前一次。
- **缺失 RPC 接受证据被当作拒绝**。现在 reply.accepted 可为 undefined；只有明确 false 才进入 rejected，未知状态使用灰色虚线/半透明标记，写追踪也显示未观测。
- **写追踪过度确定**。提交/应用改为 `commitIndex` / `lastApplied` 采样水位，明确不是精确事件时间；新增 `entryIdentity`，只有 RPC 载荷与索引同时匹配才标“条目：RPC 载荷”，否则提示仅索引关联。
- **泳道把角色倒填到整个窗口**。角色 seed 带节点 `observedAt`，只影响采样之后的区间；采样失败的节点在该时刻转 unknown，不再把最新角色补到历史左端。

## P1：完整性与可达性

- 无 Leader、请求连接异常、停止和清理都可能缺少事件。无 Leader 现在发布 `demo.error`；连接异常发布错误并清除旧 Leader 缓存，下一次立即重解析；停止发布 `demo.stop` 和 `demo.cleanup`，只清理被停止 session 的演示键，避免与下一次 start 竞争。
- UNKNOWN_OUTCOME 不再算确认失败：`WorkloadStatus` 增加 `unknown`，UI 单独显示；NOT_LEADER 仍可重试一次，UNKNOWN_OUTCOME 不重试。
- 事务服务离线时，事务状态页保留最近一次成功采样并显示警告；WAL/恢复采样失败也不清空已显示记录。服务恢复后自动刷新。

## P2：标签、单位与交付收束

- 集群页把“自报 Leader”改为“观测 Leader”；banner 不再固定显示“协议多数派待观测”，改为实际 Leader/任期或“Leader 未确认”；实验页补充“当前集群”范围，避免把历史 Evidence 当成实时状态。
- RPC 图例新增“RPC 未确认”；复制组标题显示接受数、拒绝列表和未确认数。
- 运行下拉按实验顺序排列，同实验内新到旧，默认仍选最新报告；运行切换沿用稳定的旧内容 + 覆盖式加载。
- 保留现有视觉设计、导航和组件结构；仅对语义标签和证据态样式做增量调整。补充最终审计文档、回归测试和真实 R01 Evidence。

## 数据来源与转换

| 链路 | 来源 | 转换 | 页面 | 边界 |
| --- | --- | --- | --- | --- |
| Raft status | 节点 `/internal/raft/status` | `clusterReader` 校验并生成 `NodeObservation` → `/api/cluster` → `placeMembers` | 集群、拓扑、实验上下文 | 有观测时间和 HTTP 可达性；不可达节点保留失败原因，不推断状态 |
| Raft RPC | 容器日志 `raft.rpc` | `containerEvent` → `TimelineEvent` / `RpcObservation` → `liveEvents` / SSE | Timeline、泳道、拓扑最近 RPC | 8 秒日志窗口；400 条历史；缺失 reply 为未知 |
| Demo | Raft KV HTTP / `ClientReply` | `classifyReply` → `demo.request/response/error/cleanup` → `WorkloadStatus` / `deriveWriteTrace` | 工作负载、写追踪 | 成功、拒绝、UNKNOWN_OUTCOME、连接异常分列；提交/应用只是水位 |
| Transaction | `/txn/status`、`/internal/txn/wal`、`/internal/txn/recovery`、`/txn/as-of` | `transactionReader` → `/api/transaction/*` | 事务页 | 外部 Compose 服务；离线保留上次采样 |
| Run/Evidence | `evidence/<ID>/<Run>/result.json`、`events.jsonl`、文件 | `evidenceReader` → `/api/runs` → `RunSummary` / `RunDetail` | 实验回放、验证 | Evidence 是历史事实；缺失 RPC/条目显示未观测 |
| R03/T02 → Verification | Evidence `events.jsonl` 的 source 事件 | `verification.tsx` 关联 source run → V01/V02/V03 | 一致性验证 | 判定必须引用证据；INCONCLUSIVE 不当作失败或通过 |

## 展示规则

- **实时采样**：展示观测时间和历史保留范围；状态过期时仍显示最后成功快照并明确警告。
- **历史 Evidence**：按文件回放，不把缺失行补齐；条目、RPC、提交/应用缺失时显示未知。
- **推断事实**：泳道角色只按采样时间填充；复制组按 500ms/同 follower 边界聚合；提交/应用是水位下界。
- **未知状态**：无 Leader、RPC 未确认、UNKNOWN_OUTCOME、SSE 采集缺口、事务离线、Evidence 缺口均使用显式未知文案，不用颜色代替文字。
- **RPC 语义**：接受、拒绝、未确认三分；复制组不再把缺失 reply 当拒绝。

## 验证

- `pnpm test`：18 个文件 113 项通过；覆盖新增 GET/PUT/DELETE 解析、NOT_LEADER、UNKNOWN_OUTCOME、连接异常、无 Leader、清理/停止事件、Leader 全任期选择、复制尝试边界、RPC 未知、写追踪水位和泳道 seed 时间。
- `pnpm typecheck`、`pnpm build:web` 通过。
- 真实 Compose（`minidb-lab`）重新执行 R01：`PASS`，新 Evidence `evidence/R01/2026-11-08T13-50-51.369Z--eb744db2/`；恢复后 Leader `raft-1`、任期 182，5/5 可达。演示负载继续，期间记录 1 个 UNKNOWN_OUTCOME，未误计为成功或确认失败。
- 浏览器：实时负载显示未知结果计数；选中带 demo key 的 AppendEntries 后写追踪显示“条目：RPC 载荷”“提交水位”“应用水位”；事务子服务停止时保留状态和恢复数据并显示离线警告，重启后自动恢复；T03、V02、V03 Evidence 回放可见。
- 运行切换、事件自动跟随、旧内容覆盖加载均已在前序检查中验证；本轮保持这些行为。

## 机制变更

- 新增：`classifyReply`、WorkloadStatus.unknown、demo.cleanup、复制尝试窗口/同 follower 分割、RPC 未确认态、TraceObservation.watermark、entryIdentity、带 observedAt 的 RoleSeed、事务离线保留数据。
- 替换：读取顶层 `result` 的硬编码结果、只看 Leader 的任期选择、按 payload 无限聚合复制、seed 填满整段历史、离线隐藏事务快照。
- 删除/不再使用：把缺失 RPC 当拒绝、把 UNKNOWN_OUTCOME 当确认失败、停止清理共享可变 session 的竞态、固定“协议多数派待观测”的静态提示。

## 残留边界及演示影响

- RPC 日志没有 attempt id，复制组只能用“完整载荷 + 500ms 时间窗 + 同 follower 重复”作为身份边界；极端慢 fan-out 或极快重试仍可能被归并/拆分。演示时应把它描述为聚合启发式，而不是逐 RPC 事实。
- 提交与应用来自 `commitIndex`/`lastApplied` 采样，不能还原采样间隙内的精确时间和目标索引的任期身份。演示中必须说“水位覆盖该索引”，不能说“该条目恰好在某一刻提交/应用”。
- Evidence 不记录逐条 RPC/绝对索引时，写追踪保持 unknown；这是正确性要求，不是 UI bug。不能为了演示补造 RPC、索引或提交时间。
- 事务服务是独立 Compose 容器，控制台不会自动拉起；停止时保留旧采样，重启后端口重新发现。课程演示前应先启动事务服务，否则页面只能展示历史 Evidence。
- SSE 仅保留 400 条历史、日志窗口 8 秒；超界会显式 gap，无法恢复已消失的行。演示高负载时要预期短暂缺失，不要把它当成协议丢日志。
- 本轮真实 R01 使用项目 `minidb-lab` Compose 环境，没有另建第二个 Compose 项目；Leader 切换与恢复为真实 Docker 操作，不是 mock。
