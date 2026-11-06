/** Renders the fixed cluster topology and details for one selected member. */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { nodeIds } from '../../src/raft/config.ts';
import type { NodeObservation } from '../../src/contracts/observation.ts';
import { pollIntervalMs, useCluster } from './use-cluster.ts';
import './style.css';

const roleLabels = { leader: 'Leader', candidate: 'Candidate', follower: 'Follower' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function ClusterIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M12 5v5m-7 2h5m4 0h5m-7 2v5" />
    <rect x="10" y="10" width="4" height="4" rx="1" />
    <circle cx="12" cy="3" r="2" /><circle cx="3" cy="12" r="2" />
    <circle cx="21" cy="12" r="2" /><circle cx="12" cy="21" r="2" />
  </svg>;
}

function probeLabel(node: NodeObservation | undefined, observerOffline: boolean) {
  if (node?.ok) return '可达';
  if (!node) return observerOffline ? '观测中断' : '待采样';
  switch (node.reason) {
    case 'timeout': return '响应超时';
    case 'unreachable': return '不可达';
    case 'http': return `HTTP ${node.httpStatus}`;
    case 'invalid-response': return '响应无效';
    case 'unconfigured': return '端口未配置';
  }
}

function NodeDetails({ nodeId, node, lastSeen, observerOffline }: {
  nodeId: string;
  node?: NodeObservation;
  lastSeen?: string;
  observerOffline: boolean;
}) {
  const status = node?.ok ? node.status : undefined;
  return <aside className="panel detail" id="node-details" aria-labelledby="detail-heading">
    <header className="panel-heading">
      <p className="eyebrow">节点详情</p>
      <div className="detail-title">
        <h2 id="detail-heading">{nodeId}</h2>
        <span className={`badge ${status?.role ?? 'unknown'}`}>
          {status ? roleLabels[status.role] : probeLabel(node, observerOffline)}
        </span>
      </div>
    </header>
    {status ? <>
      <dl className="node-fields">
        <div><dt>当前任期</dt><dd>{status.term}</dd></div>
        <div><dt>节点报告的 Leader</dt><dd>{status.leader ?? '—'}</dd></div>
        <div><dt>Leader 就绪 <code>ready</code></dt><dd>{String(status.ready)}</dd></div>
      </dl>
      <div className="log-progress">
        <h3>日志进度</h3>
        <dl>
          <div><dt>日志长度 <code>logLength</code></dt><dd>{status.logLength}</dd></div>
          <div><dt>已提交 <code>commitIndex</code></dt><dd>{status.commitIndex}</dd></div>
          <div><dt>已应用 <code>lastApplied</code></dt><dd>{status.lastApplied}</dd></div>
        </dl>
      </div>
      <details className="digest">
        <summary>已提交前缀摘要</summary>
        <code>{status.committedDigest}</code>
      </details>
    </> : <div className="missing">
      <strong>{probeLabel(node, observerOffline)}</strong>
      <p>等待下一轮采样取得节点状态。</p>
    </div>}
    <footer className="detail-foot">
      {status && node ? <>节点采样 <time dateTime={node.observedAt}>{timeFormat.format(new Date(node.observedAt))}</time></>
        : lastSeen ? <>最后成功采样 <time dateTime={lastSeen}>{timeFormat.format(new Date(lastSeen))}</time></> : '暂无成功采样'}
    </footer>
  </aside>;
}

function App() {
  const { snapshot, lastSeen, error } = useCluster();
  const [selected, setSelected] = useState(nodeIds[0]);
  const observations = new Map(snapshot?.nodes.map(node => [node.nodeId, node]));
  const statuses = snapshot?.nodes.flatMap(node => node.ok ? [node.status] : []) ?? [];
  const leaders = statuses.filter(status => status.role === 'leader');
  const sampledTerm = statuses.length > 0 ? Math.max(...statuses.map(status => status.term)) : '—';
  const leaderLabel = leaders.map(leader => leader.nodeId).join(' / ') || (snapshot ? '未观测到' : '—');
  const connection = error ? '观测服务离线' : snapshot ? '轮询中' : '连接中';

  return <>
    <header className="topbar">
      <div className="topbar-content">
        <div className="brand"><span className="brand-icon"><ClusterIcon /></span> Distributed Database</div>
        <span className="topbar-caption">Raft 观测控制台</span>
      </div>
    </header>
    <main>
      <div className="page-heading">
        <div>
          <p className="eyebrow">集群观测</p>
          <h1>Raft Cluster</h1>
          <p>查看五节点角色、任期和日志进度。</p>
        </div>
        <div className="poll-state">
          <span className={`badge ${error ? 'unknown' : 'polling'}`} role="status">
            <span className="dot" />{connection}
          </span>
          <span>每 {pollIntervalMs / 1000} 秒刷新</span>
        </div>
      </div>
      {error && <p className="warning" role="alert">观测 API 暂不可用，正在等待重连。</p>}
      {snapshot?.startupWarning && <p className="warning" role="status">Compose 初始化提示 · {snapshot.startupWarning}</p>}
      <dl className="metrics">
        <div className="panel metric"><dt>HTTP 可达</dt>
          <dd><span id="reachable">{snapshot ? statuses.length : '—'}</span><small> / {nodeIds.length}</small>
            <span className="metric-note">多数派门槛 3 / 5 · 协议多数派待观测</span></dd></div>
        <div className="panel metric"><dt>自报 Leader</dt>
          <dd className="leader-text"><span id="leaders">{leaderLabel}</span>
            <span className="metric-note">{leaders.length > 0 ? leaders.map(leader => `${leader.nodeId} · 任期 ${leader.term}`).join(' / ') : '来自节点状态采样'}</span></dd></div>
        <div className="panel metric"><dt>观测到的最高任期</dt>
          <dd><span id="term">{sampledTerm}</span>
            <span className="metric-note">{snapshot ? <>最近采样 <time dateTime={snapshot.sampledAt}>{timeFormat.format(new Date(snapshot.sampledAt))}</time></> : '等待采样'}</span></dd></div>
      </dl>
      <div className="workspace">
        <section className="panel topology" aria-labelledby="topology-heading">
          <header className="panel-heading">
            <h2 id="topology-heading">节点拓扑</h2>
            <p>选择节点查看详情。连线表示固定成员关系。</p>
          </header>
          <div className="topology-map">
            <svg className="connections" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
              <path d="M500 68V200M185 184l315 16 315-16M500 200 300 328m200-128 200 128" />
            </svg>
            <div className="topology-hub" aria-hidden="true"><ClusterIcon /></div>
            <ul className="nodes">
              {nodeIds.map(nodeId => {
                const node = observations.get(nodeId);
                const status = node?.ok ? node.status : undefined;
                return <li key={nodeId}>
                  <button type="button" className={`node ${status?.role ?? 'unknown'}`}
                    data-node={nodeId} aria-pressed={selected === nodeId} aria-controls="node-details"
                    onClick={() => setSelected(nodeId)}>
                    <strong>{nodeId}</strong>
                    <span className="node-status"><span className="dot" />
                      {status ? roleLabels[status.role] : probeLabel(node, error)}</span>
                    {status && <small>任期 {status.term} · 可达</small>}
                  </button>
                </li>;
              })}
            </ul>
          </div>
        </section>
        <NodeDetails nodeId={selected} node={observations.get(selected)}
          lastSeen={lastSeen[selected]} observerOffline={error} />
      </div>
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
