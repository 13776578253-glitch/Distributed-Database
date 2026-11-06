# S2 · 容器 Raft

HTTP 将 RPC 和客户端命令交给纯核心。每个节点用独立卷上的 SQLite 保存 Raft 任期、投票和日志。重启时从日志重新应用已提交状态。故障接口只更改 HTTP 传输层的对端阻断表，实验脚本记录命令、客户端历史和容器日志。

GET 采用 `/kv?key=...`，以 URL 查询参数承载任意非空键，包括点号和斜杠。R01 和 R02 验收真实容器故障与恢复，R03 保存并发历史交给 S4。

`pnpm test` 9 项通过，`pnpm typecheck` 与 `docker compose config --quiet` 通过。以下复跑均使用提交 `90d642a` 和同一个镜像。

| 实验 | 结果 |
| --- | --- |
| [SMOKE](../../evidence/SMOKE/2026-11-06T10-56-45.707Z--a7f97de8/result.json) | 18 项通过，五节点健康、独立卷和 put/get/delete |
| [R01](../../evidence/R01/2026-11-06T10-57-02.353Z--76c65d01/result.json) | 通过，从发出 SIGKILL 命令到发现新 Leader 约 844 ms，最新确认值保留，旧节点重启后收敛 |
| [R02](../../evidence/R02/2026-11-06T10-57-06.906Z--77080c4c/result.json) | 通过，多数派确认写入，少数派返回 `UNKNOWN_OUTCOME` / `NO_QUORUM`，五个提交前缀在恢复后匹配 |
| [R03](../../evidence/R03/2026-11-06T10-57-09.811Z--f77dfa23/result.json) | 已采集 6 条包含重叠调用的操作历史，S4 给出判定 |
