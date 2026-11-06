# Raft 控制台第三批 · 调度与服务管理

## 运行边界

- 网页只提交白名单操作。Observer 校验环回 Host、同源 Origin 和 JSON，启动独立任务进程。任务与 CLI 复用同一执行器，使用 Compose 解析出的项目名和环回端口。
- 启动初始化、实验、单节点重启、Observer 重启、`pnpm demo` 和 `pnpm reset:destructive` 使用同一项目锁。任务创建 Evidence 后上报真实 Run ID，判定由运行器写入，原始日志与 JSONL 保留在本机。页面列出当前 Observer 会话中的最近 20 个网页任务，Observer 重启后历史 Run 继续从磁盘读取。
- 节点重启和实验恢复阶段由任务进程上报。节点重启确认原容器 ID 与节点 HTTP 健康。Observer 重启由启动器接管，重新挂接现有项目，项目为空时保持空状态。监听地址和端口按实际配置显示。轮询、时间格式、主题和页面日志显示上限是浏览器偏好。
- R01 重启原 Leader，R02 尝试恢复所有 RPC 链路。恢复动作失败时保留带 `recoveryRequired` 的项目锁，异常进程退出也保留锁文件。需要恢复时，先核实锁中的 PID 与 Run Evidence，按原实验恢复容器或链路并核对五节点状态，然后移除对应的 `.scratch/cluster-operations/<项目名>.lock`。直接执行的 Docker 命令由操作者协调。

## 验收

- `pnpm test` 22 项通过，`pnpm typecheck` 与 `pnpm build:web` 通过。
- 隔离 Compose 上通过同源 HTTP 调度 R02 和 R01，均写入新的 PASS Evidence。R02 恢复五个节点的链路设置，R01 保留终止及恢复事件。 [R01](../../evidence/R01/2026-11-06T15-10-34.566Z--d3e57aec/result.json) · [R02](../../evidence/R02/2026-11-06T15-10-31.537Z--ed1a419e/result.json)
- R02 持锁时重复提交实验、重启节点及重启 Observer 均返回 HTTP 409，同期 CLI 请求退出码为 1。跨域请求返回 403，执行 R04 请求返回 400。
- 单节点重启恢复 HTTP，项目容器 ID 保持一致。随后重启 Observer，PID 改变且原项目仍为五节点可达。现有默认项目容器 ID 在隔离验收前后相同。 [服务操作证据](../../evidence/SERVICE/2026-11-06T15-10-40.396Z--709016de/result.json) · [整体验收断言](../../evidence/CONSOLE-OPERATIONS/2026-11-06T15-10-19.090Z--b06e3522/result.json)
- 新 Run 验证了节点重启先报告恢复中，再给出 PASS。R03 采集了六条调用返回，保留 `INCONCLUSIVE`。 [阶段与 R03 验收](../../evidence/CONSOLE-JOB-PHASE/2026-11-06T15-18-40.289Z--c2081031/result.json)
- 在临时项目验证 CLI 冒烟与显式重置，并核对 Observer 重启后仍保持空项目。 [CLI 验收](../../evidence/CONSOLE-CLI/2026-11-06T15-14-04.368Z--5705c5ca/result.json) · [空项目重启验收](../../evidence/CONSOLE-CLI/2026-11-06T15-17-00.620Z--82a02ffb/result.json)
- Edge 无截图功能检查覆盖侧栏导航、SSE 暂停／恢复、R03 回放与原始文件入口、主题切换、手动刷新，以及 390 像素宽首页无横向溢出。首次检查发现下拉框可访问标签的精确定位问题，修正后通过。
