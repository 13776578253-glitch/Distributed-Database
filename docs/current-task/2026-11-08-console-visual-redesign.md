# 控制台 Warm Soft UI 重设计

2026-11-08，`feat/visualization`。范围是 `web/` 的视觉系统、壳层、控件、主题切换和数据视图样式；路由、SSE/轮询、写追踪事实、固定槽位和增量更新逻辑保持不变。后端、协议、合同、Observer 和测试代码未改。

## 设计结果

- 浅色使用 Rosé Pine Dawn：`#faf4ed` 暖象牙画布、`#fffaf3` 奶油表面；主交互、聚焦和选中态使用蓝色（`#4a7fa3` / `#2f5c7a`），Iris 仅用于页头品牌、顶部图标和主题预览等小面积点缀；Gold 警告、深 Love 危险。
- 深色使用 Rosé Pine 深色底：`#14121f` 画布、`#1f1d2e` 表面、蓝色 `#8ab8d9`，Iris `#c4a7e7` 点缀；输入、表格、抽屉 scrim 和选中态独立校准。
- 标题、指标数值和品牌使用系统 Serif；正文、控件、表格使用 Sans；索引、LSN 和时间保留 Mono。无外网字体依赖。
- 24px 面板/大卡片圆角、14px 控件圆角、pill 按钮/页签/徽章；纯色暖象牙背景替代蓝色光晕和波纹纹理；双层柔和阴影 + inset 高光，避免厚重拟物。
- 设置页“主题”从下拉改为浅色 / 深色 / 跟随系统三段式 pill，带色板预览和选中勾选；仍写入原有 `preferences.theme`。
- 选中表格行、泳道组和拓扑节点使用蓝色；主题卡选中态保留 Iris；键盘 focus 使用蓝色 outline；主按钮和导航使用蓝色。

## 批次

1. 基础 token、背景、字体、页头、抽屉、Raft 页签、banner、favicon。
2. 面板/指标卡、输入/自绘下拉、按钮、表格选中态、主题 pill。
3. 拓扑、泳道、写追踪、工作负载、事务/验证/设置业务视图。
4. 深色、响应式、对比度、键盘与收尾验证。

## 验证

- `pnpm test`：18 个文件 102 项通过。
- `pnpm typecheck`、`pnpm build:web` 通过。
- Edge 浏览器：1440×1000 检查 cluster / timeline / settings / transaction / verification 的浅色；cluster / timeline / settings 的深色；390×844 检查移动端主题 pill、页签、工作负载和过滤栏。
- 390、768 宽度下 `document.documentElement.scrollWidth <= innerWidth`；事件表和服务表在窄屏内部横向滚动，页面本身不横向溢出。
- 主题 pill 点击切换有效，选中态和持久化沿用原设置；深色下选中卡、输入和表格层次可见。
- 关键对比度（WCAG 计算）：浅色 ink/panel 7.00、muted/panel 5.38、accent-strong/panel 5.81、warning/warning-bg 4.71、danger/danger-bg 5.11、success/success-bg 5.24；深色 ink/panel 12.50、muted/panel 6.58、accent-strong/accent-bg 9.28、selection/panel 9.76。
- 全仓未再发现旧的冷蓝 token（`#00627b`、`#0369a1`、`#e2f1f2`、`#7dd3fc` 等）。

## 评审修正

- 回放稳定性：`EventExplorer` 增加 playback 模式，事件表容器固定为 26rem 最小高度；原始事件在回放中默认折叠，未选中时保留“等待播放”摘要占位。点击“从头播放”不再因表格和原始区高度塌陷而把页面拉回顶部。
- 实验上下文：`ExperimentPage` 传入当前集群摘要，在调度区显示实时 Leader、任期和可达节点数，并增加“查看集群变化”链接；任务卡显示影响类型，R01/R02 提供“查看集群”入口。
- 事务不可达：事务页说明控制台通过 Docker Compose 发现 `minidb-txn` 的 `transaction` 服务，当前端口发现/连接失败；给出服务未启动、Docker 未运行或 8080 端口未发布三种原因和启动命令。
- 标题头收敛：`overview-banner` 改为 `var(--banner)` 纯色，去掉径向/线性渐变，高度收敛到 72px，h1 收敛到 1.25rem。

## 评审验证

- 实验回放（R03，16 步）点击“从头播放”前后：`scrollY 382`、文档高度 `1829`、表格 `416`、原始区 `60`、控制条顶部 `478` 完全一致。
- 验证回放点击播放前后：`scrollY 541`、文档高度 `1691`、表格 `416`、原始区 `60`、按钮顶部 `478` 完全一致。
- 修正前事务容器状态：`docker compose -f compose.transaction.yaml -p minidb-txn port transaction 8080` 返回 `service "transaction" is not running`。
- `pnpm test` 18 个文件 102 项通过；`pnpm typecheck`、`pnpm build:web` 通过。

## 评审修正（2）

- 切换运行 Evidence 时，`Experiments` 保留上一次已加载的 `Playback` 内容，新的加载状态以绝对定位覆盖层显示在 `experiment-stage` 内；不再移除下方内容或把“读取 Evidence 中…”插到面板外。运行数据在加载完成后原位替换。
- 回放事件表增加 `followLatest`：播放时选中最新事件并滚动到表格底部，实时视图反向表格滚动到顶部；用户不再只看到默默追加的旧行。
- 运行下拉按固定实验顺序（`ids`）排序，同实验内按开始时间从新到旧；默认仍选中最新报告。
- 全站文字缩小一档：正文 15px→14px、最小元数据 11px、表格 13px、标题 22/18/16px、指标值 22px；指标卡高度 96px、页签 32px、下拉选项 32px。
- 移除 `web/src/texture.tsx` 和 `.page-texture` CSS；画布只保留纯色 `--canvas`，没有波纹、等高线或径向光晕。
- 事务服务已启动：`minidb-txn-transaction-1` 运行中，宿主端口 `54812`，`/api/transaction/status` 返回 200；事务页显示真实状态。若服务停止，只保留一行紧凑警告，不再渲染大段报告。

## 评审验证（2）

- 运行切换：制造 5s Evidence 延迟后，选中新运行仍显示 `loading:true`，旧 stage 高度 `1099`、`scrollY 99` 不变；加载覆盖层位于 stage 内。
- 回放自动跟随：R03 全量回放时表格 `scrollTop === scrollHeight - clientHeight (675)`，选中最后一行的“判定待接入”事件。
- 事务页已从不可达切换为真实状态数据；不再出现事务服务报告块。
- 背景截图确认无波纹；纯色画布在浅色/深色下生效。
- `pnpm test` 18 个文件 102 项通过；`pnpm typecheck`、`pnpm build:web` 通过。

## 终轮收敛

- 主色从 Iris 改回蓝色，实验回放的 Leader、角色带、RPC 弧和选中态恢复蓝色；Iris 只保留在页头/品牌图标和主题预览等小面积点缀。
- 字号再收紧一档：基准 14px、组件正文 13px、元数据 10px、表格 12px、标题 20/17/15px、指标值 20px；指标卡 88px、页签 30px、下拉选项 30px、字段/按钮 40px。
- 运行切换时保留旧 `Playback`，加载覆盖层继续固定在 `experiment-stage` 内；回放事件表继续自动跟随最新行，运行下拉按实验顺序排列。
- 事务服务保持运行并可发现；如果停止，只显示紧凑单行状态，不渲染大段报告。

## 终轮验证

- 蓝色主题截图：集群 Leader、指标图标、活动页签、连接状态和实验回放泳道均恢复蓝色；Iris 仅出现在页头品牌/主题预览。
- 字号/密度截图：控制台在 1280 宽度下文字和控件明显收紧，页面无横向溢出。
- `pnpm test` 18 个文件 102 项通过；`pnpm typecheck`、`pnpm build:web` 通过。

## 边界与未验证

- 系统 Serif 的 CJK 回退因平台不同（Iowan/Songti/SimSun 等）；本轮接受系统字体差异，未自托管字体。
- 默认控件边框按“低对比暖边框”设计，依靠背景和 inset 阴影区分；交互 focus/selected 使用蓝色，已优先保证清楚。未做屏幕阅读器人工巡检。
- 移动端 banner 高度仍会随子页 action 内容略变；壳层和页签位置保持，未把 action 移出 banner。
- 未新增视觉回归测试；验收以构建、测试、浏览器截图、几何溢出检查和对比度计算为准。
