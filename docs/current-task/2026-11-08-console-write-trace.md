# Timeline 语义降噪与写入追踪

2026-11-08，`feat/visualization`。范围是 Observer 事件投影、Timeline 泳道聚合和单次 PUT 追踪；Raft 协议核心、SSE 重连和实验回放入口不变。

## 链路审计

- `http-transport` 只在投票、携带条目的 AppendEntries、快照和读屏障时记录 `raft.rpc`，空心跳不写日志；错误记录 `raft.rpc.error`。
- `containerEvent` 原先只保留 term、index 和 accepted，丢弃 AppendEntries 的 command key/value；Timeline 只能看到“接受/拒绝”，无法关联一次 PUT。
- 集群状态接口已有 `commitIndex`、`lastApplied`、`logLength` 和采样时间；本轮不新增后端协议字段。
- SSE 事件已有稳定 id、时间、节点、term 和 indexes；demo 事件已有 session、seq、key，可作为关联键。

## 机制

- 扩展 `TimelineEvent.entries`：绝对索引、key、value 和 command type；AppendEntries 标签带首键。
- 将 `raft.rpc.error` 投影为 `rpc.error`，保留原 raw；拒绝和超时仍进入表格与泳道。
- `groupReplication` 把同一 leader、任期、索引区间和条目载荷的多个 follower 应答聚合为一个逻辑复制组。泳道默认只画组刻度，焦点组画最多四条弧线；原始 AppendEntries 行仍在表格中，可按节点、任期、索引和类型筛选。
- 新增 `deriveWriteTrace`：优先用 demo session/seq/key 与 AppendEntries 的 entries 关联；选中 AppendEntries 行时反向寻找 demo 请求/响应。请求成功来自 HTTP 返回，复制来自 AppendEntries，提交和应用来自 `/api/cluster` 采样；缺失时明确显示未观测。
- Timeline 保留最近 40 个集群采样（默认约 2 分钟），实时窗口默认 30 秒；暂停跟随冻结泳道，SSE 仍可重连。
- 写追踪面板包含聚焦复制拓扑、四步事实、按节点复制/应用表和缺失证据说明；Leader 标记为复制“源”。

## 验证

- `pnpm test` 18 个文件 102 项通过；新增覆盖 entries/RPC error、复制分组、写追踪的完整、缺失、AppendEntries 反查和 Evidence 路径。
- `pnpm typecheck`、`pnpm build:web` 通过。
- 浏览器：2 ops/s、30 秒窗口下保留 400 条原始事件；泳道为 4 条聚焦弧线、45 个复制组刻度、50 个事件点，表格 405 行。选中 AppendEntries 后显示 term 97 / index 29943 / 四个 follower 接受 / commitIndex 与 lastApplied 采样。暂停跟随生效；Observer 重启后 SSE 显示已连接和缺口原因；R01 回放选择 client.return 显示请求成功、复制/提交/应用未观测和 Evidence 说明。
- 未在本轮做真实 RPC 拒绝/超时的故障注入；对应投影、分组和渲染由单元测试覆盖。
