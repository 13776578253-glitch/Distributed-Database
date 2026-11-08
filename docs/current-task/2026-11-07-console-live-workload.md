# 实时演示负载

2026-11-07，`feat/visualization`。范围是 Observer 侧的演示流量和 Timeline 控制面板；Raft 核心、Evidence 和实验调度不变。

## 范围

- `src/observer/workload.ts`：非破坏性的 put/get/delete 循环，Leader 发现复用只读状态采样；演示键固定在 `demo/<session>/k0..k11`，停止时清理。
- 操作值使用 JSON 标量序号；所有请求走公开 KV API，不修改 Raft 内部状态，不写 Evidence，也不获取项目实验锁。
- 通过 `liveEvents.publish` 向现有 SSE 发布 `demo.start/stop/request/response/error` 事件，读取和延迟也进入 Timeline、泳道和原始 JSON。
- `scripts/console-server.ts` 新增 `GET/POST /api/workload`；实验锁或调度任务存在时拒绝启动，运行中自动暂停；Observer 关闭时清除定时器。
- `web/src/workload.tsx` 在 Timeline 页提供速率（1/2/5 ops/s）、启停、Leader、操作数、成功率、P50 和最近结果；运行中用绿色脉冲点标记。
- 仅覆盖 Raft 服务；事务和验证器的持续负载留到后续阶段。

## 验证

- `pnpm test` 通过 17 个文件 96 项；新增 workload 测试覆盖动作解析、计划生成、Leader 判定、分位数、单次执行、实验暂停和 `NOT_LEADER` 重试。
- `pnpm typecheck`、`pnpm build:web` 通过。
- 在 5174 端口实测：2 ops/s 运行约 90 秒，181 次操作全部成功，五个节点日志从 29 增长到 210 并全部提交、应用；SSE 中出现 `demo.request` / `demo.response` 和 AppendEntries；Timeline 泳道出现绿色 demo 点和持续复制弧线。停止后抽查三个演示键均返回 `found:false`。
- 首轮发现 PUT 发送对象导致 `INVALID_OPERATION`，改为 JSON 标量序号后写入全部成功；回归测试覆盖该值类型。
- 未覆盖：事务服务的持续负载、实时线性化判定；这些留到后续讨论。
