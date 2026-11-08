# 控制台 UI 与交互收束

合并控制台导航、布局稳定性、演示负载、泳道、设计令牌和写入追踪六份小修记录。这里只保留最终生效的行为与验证；视觉语言细节见[Warm Soft 重设计](2026-11-08-console-visual-redesign.md)，最终数据语义见[真实性审计](2026-11-08-console-final-audit.md)。

## 导航与壳层

- 侧栏收束为 Raft、事务、一致性验证、设置四组。集群、实时事件、实验回放共享同一个 `<main>`，用 `RaftTabs` 切换内部内容；`#/timeline`、`#/runs` 深链保留。
- 移除整页进入动画，统一 banner 高度；轮询失败保留最后快照并显示离线警告，不重排整个页面。
- `html` 使用 `scrollbar-gutter: stable`，不支持时回退 `overflow-y: scroll`，避免抽屉/设置页切换时滚动条占位变化。

## 固定骨架与增量更新

- 拓扑节点按成员清单固定槽位；Leader 变化只改变角色样式和关系线，不移动节点。
- 泳道行高、事件表列宽和高度、工作负载面板和追踪面板保持稳定；新事件只增量更新对应区域。
- Timeline 的 1 秒时钟只驱动泳道内部重绘；选中事件在首次出现后保持，除非被筛选掉或缓存淘汰。
- 原生 `<select>` 全部由 `web/src/select.tsx` 替代：自定义触发器/浮层、12px 箭头内边距、键盘导航、外部点击关闭，展开不改变页面几何。
- 写追踪只在用户明确点击事件行或复制组后出现；默认最新事件不自动展开；没有复制证据时不渲染空的“按节点观测”表。

## 演示负载与泳道

- 演示负载只写 `demo/<session>/k0..k11`，使用公开 KV API，不修改 Raft 内部状态、不写 Evidence；实验锁或调度任务存在时自动暂停。
- 事件通过现有 SSE 进入 `demo.*` 行、泳道和原始 JSON；停止时只清理被停止 session 的键，并发布 `demo.stop` / `demo.cleanup`。
- 泳道是纯投影：按节点排序角色区间，处理终止/恢复窗口、隔离窗口、分区/缺口标记和 RPC 弧线；回放轴固定为 Run 范围，实时轴由当前窗口驱动。
- 角色 seed 使用节点实际 `observedAt`，失败采样在该时刻转 unknown；复制组按完整载荷、同 follower 重复和 500ms 窗口区分 RPC 尝试。缺失接受证据显示未确认，不当作拒绝。

## 设计令牌

- 使用 `web/src/style.css` 的 `:root` 令牌统一暖象牙画布、奶油表面、圆角、阴影、蓝色主交互、Iris 小面积品牌点缀和 Gold/Love 警告色；深色主题独立校准。
- 系统 Serif 用于标题/指标，Sans 用于正文和控件，Mono 用于 ID、term、索引和 LSN；角色和故障状态同时使用文字和颜色。
- 背景使用纯色，不保留波纹/等高线纹理；视觉细节和评审记录见[Warm Soft 重设计](2026-11-08-console-visual-redesign.md)。

## 写入追踪

- `containerEvent` 保留 AppendEntries 的绝对索引、key、value 和 command type；选中 PUT 或带 key 的 AppendEntries 后关联 demo 请求/响应、复制组、提交和应用采样。
- 复制组只聚合同一逻辑复制的 follower 应答；提交对应 `commitIndex >= index` 的采样水位，应用对应 `lastApplied >= index` 的采样水位，均不等同于精确事件时间。
- 缺失条目、RPC 或状态采样时显示未观测；Evidence 未记录条目/索引时保持 unknown。

## 验证

- 当前 `pnpm test` 通过 18 个文件、118 项；`pnpm typecheck`、`pnpm build:web` 通过。
- Edge 实测覆盖：四组侧栏、三个 Raft 页签、固定拓扑槽位、1440/1280/390px 布局、深色主题、自定义下拉、泳道选中与暂停跟随、写追踪出现/消失、SSE 重连和离线警告。
- 已知未覆盖：无头 Edge 使用 overlay scrollbar，常驻滚动条下的最终视觉验收需在对应环境确认；未做自动视觉回归，视觉批注以真实页面复核为准。
