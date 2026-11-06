# Raft 控制台第二批 · 实时事件和实验回放

- Observer 的一次 Compose 日志采样同时供首页近期 RPC 与 Timeline 使用。有实时订阅时每秒采样，读取最近 8 秒的日志窗口。SSE 保留 400 条、用事件 ID 续传并提示过期游标、采样中断及容器身份变化。常规心跳与精确提交、应用时刻取决于现有日志覆盖。
- 实验回放按 `events.jsonl` 的文件顺序，支持播放、暂停、单步和按节点、任期、索引、事件类型筛选。R01–R04 判定来自 `result.json`，R03 保留 `INCONCLUSIVE`，R04 标识为隔离探针。可通过文件白名单读取原始证据。
- `pnpm test` 19 项通过，`pnpm typecheck` 与 `pnpm build:web` 通过。
- 隔离 Compose 上用真实读取产生 RPC，通过 HTTP 断开并按 `Last-Event-ID` 恢复 SSE，验证容器重启和重建后的事件及缺口提示。核对四种历史实验、原始日志访问与路径拒绝。 [实测断言](../../evidence/CONSOLE-SSE/2026-11-06T14-55-30.860Z--2d186362/result.json)
