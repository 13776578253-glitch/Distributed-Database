# 冻结后端与控制台联调

## 范围和数据流

将冻结点 `b00d946` 合入 `feat/visualization`。Raft、事务存储与验证器核心及其测试和 Compose 定义沿用冻结版。联调涉及 Observer、React 和宿主机 CLI 入口。

- Raft 首页按 Observer 返回的成员清单分配拓扑位置，支持默认五节点及隔离六节点实验。详情展示快照边界、日志末尾与提交任期、当前及已应用的投票配置。SSE 识别冻结服务已记录的 InstallSnapshot 和 ReadIndex。
- Transaction 通过 Observer 发现独立事务项目的本机端口，读取状态、WAL、恢复报告并按键与 LSN 查询历史可见值。页面的版本写入筛选来自 WAL，查询结果来自事务引擎。WAL 表格最多渲染筛选后的最近 150 条。T01–T03 回放独立于事务服务的运行状态。
- Verification 读取已完成的 V01–V03，展示验证结果、合法顺序、反例、依赖环和边、业务不变量违例。来源可按原 Run ID 跳转回放或查看原文。R03 采集和 V01 验证分别保留各自的结果。
- R01–R03 继续由网页和 CLI 共用的任务进程调度。扩展 CLI 与控制台使用同一 Compose 项目锁，E4B 在现有租约内调用同一个成员变更入口。

## 验收结果

- `pnpm test` 通过 82 项测试，`pnpm typecheck` 与 `pnpm build:web` 通过。新增覆盖六节点位置、快照与 ReadIndex 日志以及 R03/V01 判定来源。
- 隔离五节点项目全新初始化成功。Observer 重启前后节点容器 ID 一致。网页请求调度 R01 并取得 [PASS](../../evidence/R01/2026-11-07T15-08-43.583Z--0b929594/result.json)，扩展 CLI 的 E2 [PASS](../../evidence/E2/2026-11-07T15-09-40.884Z--82a68c58/result.json)。
- 隔离事务实例在 LSN 6 建立 Checkpoint，终止并重启后报告撤销 LSN 8，WAL 保留 CLR。以 LSN 6 查询 `console-probe` 返回已提交值 `visible`。Observer 拒绝写入请求及无效 LSN。
- 隔离六节点项目观测到六个运行容器与非投票备用节点。首次 E4B 在子进程重复获取项目锁时 [FAIL](../../evidence/E4B/2026-11-07T15-10-59.541Z--77d98c85/result.json)。共用入口后，通过 CLI 恢复初始投票组并生成独立的 [PASS](../../evidence/E4B/2026-11-07T15-12-22.393Z--07670022/result.json) 记录。
- Edge 功能验收覆盖点击节点、事务查询、CLR 列表、V01–V03 的结果切换和 390px 页面宽度。按用户偏好未截图。

索引级副本身份和精确应用时间仍依赖后续只读观测接口。页面保留现有提交与应用水位。
