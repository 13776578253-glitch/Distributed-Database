# Timeline 泳道时序图

2026-11-07，`feat/visualization`。范围是实时事件和 Raft 实验回放的可视化层，后端契约、Evidence 写入和既有判定不变。

## 范围与数据流

- `web/src/swimlane.ts` 是纯投影：按节点自然排序，从 `raft.role` 与 `raft.status` 提取角色区间，从 `fault.kill` / `fault.restart` 和 `fault.links.blockedPeers` 构造终止与隔离窗口，从 `fault.partition` / `observer.gap` 生成全高标记，并按绘图宽度收敛时间刻度。
- `web/src/swimlane.tsx` 只消费 `TimelineEvent` 和可选的角色种子，用 SVG 绘制角色带、RPC 弧线、故障窗口和事件点，不引入图表库。
- 实时模式用 `/api/cluster` 的最近采样补齐窗口左端的成员行和角色，SSE 只追加事件；回放模式以整个 Run 的时间范围为固定轴，按播放进度揭示事件。筛选作用于泳道事件和表格，角色区间与故障窗口保留为时间轴上下文。表格继续提供键盘操作与原始 JSON。
- 终止窗口内以及重启后尚未再次采样的角色显示为未知，避免把终止前的 Leader 继续画到后半段。隔离窗口保留角色，使用警告虚线描边。故障窗口边界和分区、缺口标记均来自真实事件时间。

## 验证

- `pnpm test` 通过 16 个文件 89 项测试。新增 `tests/observer/swimlane.test.ts` 覆盖节点排序、角色分段、连续采样合并、终止/隔离窗口、RPC 判定和时间刻度。
- `pnpm typecheck`、`pnpm build:web` 通过。
- 在 5174 端口以 `--attach-only` 挂接现有五节点项目：R01 回放验证 Leader→Follower→终止→未知区间，R02 回放验证 3–2 分区的隔离窗口，深色主题和 390px 宽度均可读。实时页通过一次可回滚的临时键 put/delete 触发真实 AppendEntries，观测到 `raft-5 → raft-1..4` 的四条方向弧线；临时键已删除。现有集群镜像对 `safe-follower` 返回 `NOT_LEADER`，未据此修改冻结后端。
- 未覆盖：RPC 拒绝弧线的真实样本，以及精确提交/应用时间；后者仍依赖[开发计划](../PLAN.md)中待讨论的只读观测接口。
