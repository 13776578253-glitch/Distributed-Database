# S0 · 脚手架

公共契约、Node 与 pnpm 版本、测试和类型检查、五节点 Compose 冒烟。五个 Raft 占位容器使用同一镜像和独立数据卷。

`pnpm test`、`pnpm typecheck`、`docker compose config --quiet` 和 `pnpm demo` 通过。标准入口的 [SMOKE 证据](../../evidence/SMOKE/2026-11-06T10-43-09.162Z--1e992354/result.json) 共 15 项检查。先前镜像标签与运行容器不一致的失败也保留在同一实验目录。

本地提交 `cc4a4e2`。
