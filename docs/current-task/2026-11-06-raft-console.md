# Raft 观测控制台第一批

2026-11-06，`feat/visualization`。本批范围是启动入口、五节点状态聚合、固定拓扑、节点详情、轮询刷新与浏览器功能验收。视觉截图单独交付审阅，后续页面按开发计划排期。

## 数据流和故障边界

- `pnpm console` 用 Vite 生成浏览器资源，由一个本机 Node.js 进程同源提供页面和 `GET /api/cluster`。构建资源由当前进程持有，`pnpm build:web` 可另外输出静态产物。
- 启动器通过 Compose 的解析结果取得五个成员的环回端口及卷名。已有任何项目成员时只挂接。空项目创建五个外部卷，构建镜像并启动集群。端口冲突在启动 Docker 操作前报错，Docker 命令失败时显示启动提示。
- Observer 并行访问五个 `/internal/raft/status`。每节点有独立的 1 秒超时，覆盖响应头和正文，并校验节点身份和字段。每轮只共享在途 Promise。错误节点保留在五成员列表中，并报告错误类型。
- React 每轮请求结束后间隔 3 秒再取样，只保留最近一轮、各节点最后成功时间和当前选中节点。节点故障时显示探测失败，原详情选择仍有效。HTTP 可达数按成功取得的状态响应统计，协议多数派单独标为待观测。

## 功能验收

| 验收项 | 实测结果 |
| --- | --- |
| 测试、类型检查、前端构建 | `pnpm test` 13 项通过，含 4 项 Observer 和启动器用例。 `pnpm typecheck`、`pnpm build:web` 通过。 |
| 挂接已有集群 | `pnpm console` 启动后五个容器 ID 与启动前一致。聚合 API 的五份状态逐字段与节点直连响应相同。 |
| 初始化空集群 | 使用单独 Compose 项目、镜像、19081–19085 端口和五个新建外部卷，`pnpm console` 初始化后五个容器均为 healthy。 |
| 浏览器点击与同源 | Microsoft Edge Chromium 打开页面，点击 Leader 后核对三个日志字段和 `ready`，浏览器资源使用同一个 origin，控制台无错误。 |
| 故障和恢复 | 隔离项目的 `raft-1`（任期 1）被 SIGKILL 后，原页面在轮询中显示 `4/5`、`raft-5` 接任、任期 2。五个按钮坐标及选中项保持一致。重启 `raft-1` 后页面回到 `5/5`，所选节点重新显示日志进度。 |

验收时从当前 `docker compose config --format json` 生成隔离配置，替换项目名、网络名、五个公开端口、镜像名和外部卷名。使用该文件作为 `COMPOSE_FILE`，设置 `CONSOLE_PORT=5174` 后运行 `pnpm console`。故障和恢复命令都指定同一个隔离 Compose 文件。成功记录包含[断言](../../evidence/CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/result.json)和[原始命令输出](../../evidence/CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/raw.log)。首次运行因浏览器测试的相对定位器重复限定父元素而超时，[失败记录](../../evidence/CONSOLE/2026-11-06T13-50-40.606Z--161acd35/result.json)保留，修正验收定位器后重跑。

## 视觉审阅

截图采用暖白底色、青蓝 Leader 高亮与固定五节点布局。桌面为 1440 × 900，窄屏为 390 像素宽，浏览器测得无横向溢出。截图供用户独立验收。

- [桌面拓扑与节点详情](../../evidence/CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/desktop.png)
- [窄屏节点列表与详情](../../evidence/CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/narrow.png)
- [Leader 故障后](../../evidence/CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/leader-failure.png)
- [旧 Leader 恢复后](../../evidence/CONSOLE/2026-11-06T13-51-30.946Z--7f1b1871/recovered.png)
