/** Renders the fixed cluster topology and details for one selected member. */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { nodeIds } from '../../src/raft/config.ts';
import type { NodeObservation, RpcObservation } from '../../src/contracts/observation.ts';
import { Navigation } from './navigation.tsx';
import { placeMembers } from './topology.ts';
import { pollIntervalMs, useCluster } from './use-cluster.ts';
import './style.css';

const roleLabels = { leader: 'Leader', candidate: 'Candidate', follower: 'Follower' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function MetricIcon({ kind }: { kind: 'reachability' | 'leader' | 'term' }) {
  const paths = {
    reachability: 'M2 12h4l3-7 5 14 3-7h5',
    leader: 'm3 6 5 4 4-6 4 6 5-4-2 12H5L3 6Z',
    term: 'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  };
  return <span className="metric-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]} /></svg>
  </span>;
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

function NodeDetails({ nodeId, node, lastSeen, observerOffline, rpc }: {
  nodeId: string;
  node?: NodeObservation;
  lastSeen?: string;
  observerOffline: boolean;
  rpc: RpcObservation[] | null | undefined;
}) {
  const status = node?.ok ? node.status : undefined;
  const replies = rpc?.filter(event => event.from === nodeId || event.to === nodeId).slice(0, 3) ?? [];
  return <aside className="panel detail" id="node-details" aria-labelledby="detail-heading">
    <header className="panel-heading detail-title">
      <h2 id="detail-heading" tabIndex={-1}>节点详情</h2>
      <div className="detail-identity"><strong>{nodeId}</strong>
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
    <section className="recent-rpc" aria-labelledby="rpc-heading">
      <h3 id="rpc-heading">最近 RPC 应答</h3>
      {replies.length ? <ul>{replies.map(event =>
        <li key={`${event.from}/${event.to}`}>
          <span>{event.from} → {event.to}</span>
          <small>{event.kind === 'vote' ? 'RequestVote' : 'AppendEntries'} · {event.accepted ? '接受' : '拒绝'}</small>
          <time dateTime={event.at}>{timeFormat.format(new Date(event.at))}</time>
        </li>)}</ul>
        : <p>{rpc ? '近 8 秒无该节点的 RPC 日志，常规心跳省略。' : '暂无可用的 RPC 日志。'}</p>}
    </section>
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
  const { leader, points } = placeMembers(nodeIds, statuses);
  const relations = leader ? statuses.filter(status => status.nodeId !== leader.nodeId
    && status.term === leader.term && status.leader === leader.nodeId) : [];
  const rpc = snapshot?.recentRpc;
  const activeRpc = rpc?.filter(event => event.term === sampledTerm
    && observations.get(event.from)?.ok && observations.get(event.to)?.ok) ?? [];
  function edge(from: string, to: string) {
    const start = points.get(from)!;
    const end = points.get(to)!;
    const midX = (start.x + end.x) * 5;
    const midY = (start.y + end.y) * 2;
    return `M ${start.x * 10} ${start.y * 4} L ${midX} ${midY} L ${end.x * 10} ${end.y * 4}`;
  }

  return <>
    <Navigation />
    <main aria-labelledby="cluster-heading">
      <header className="page-heading">
        <h1 id="cluster-heading" tabIndex={-1}>Raft Cluster</h1>
        <p>五节点集群总览</p>
      </header>
      {error && <p className="warning" role="alert">观测 API 暂不可用，正在等待重连。</p>}
      {snapshot?.startupWarning && <p className="warning" role="status">Compose 初始化提示 · {snapshot.startupWarning}</p>}
      <dl className="metrics">
        <div className="panel metric"><dt><MetricIcon kind="reachability" />HTTP 可达</dt>
          <dd><span id="reachable">{snapshot ? statuses.length : '—'}</span><small> / {nodeIds.length}</small>
            <span className="metric-note">多数派门槛 3 / 5 · 协议多数派待观测</span></dd></div>
        <div className="panel metric"><dt><MetricIcon kind="leader" />自报 Leader</dt>
          <dd className="leader-text"><span id="leaders">{leaderLabel}</span>
            <span className="metric-note">{leaders.length === 1 ? `任期 ${leaders[0].term}` : leaders.length > 1
              ? leaders.map(leader => `${leader.nodeId} · 任期 ${leader.term}`).join(' / ') : '来自节点状态采样'}</span></dd></div>
        <div className="panel metric"><dt><MetricIcon kind="term" />最高观测任期</dt>
          <dd><span id="term">{sampledTerm}</span>
            <span className="metric-note sampling">
              <span className={`poll-state ${error ? 'offline' : snapshot ? 'polling' : ''}`} role="status">
                <span className="dot" />{connection}{snapshot && ` · ${pollIntervalMs / 1000} 秒`}
              </span>
              {snapshot && <span>最近采样 <time dateTime={snapshot.sampledAt}>{timeFormat.format(new Date(snapshot.sampledAt))}</time></span>}
            </span></dd></div>
      </dl>
      <div className="workspace">
        <section className="panel topology" aria-labelledby="topology-heading">
          <header className="panel-heading">
            <h2 id="topology-heading" tabIndex={-1}>节点拓扑</h2>
            <p role="status">{leader ? `${leader.nodeId} · Leader · 任期 ${leader.term}` : '当前采样未确认唯一 Leader'}</p>
          </header>
          <div className="topology-map">
            {!leader && <span className="leader-placeholder" aria-hidden="true">等待 Leader</span>}
            <svg className="connections" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="rpc-arrow" viewBox="0 0 8 8" refX="4" refY="4"
                  markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M1 1 7 4 1 7Z" fill="var(--accent)" />
                </marker>
                <marker id="rpc-reject-arrow" viewBox="0 0 8 8" refX="4" refY="4"
                  markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M1 1 7 4 1 7Z" fill="var(--warning)" />
                </marker>
              </defs>
              <g key={leader?.nodeId ?? 'no-leader'} className="links">
                {leader && relations.map(status => <path key={status.nodeId} className="relation"
                  vectorEffect="non-scaling-stroke" d={edge(leader.nodeId, status.nodeId)} />)}
                {activeRpc.map(event => <path key={`${event.from}/${event.to}/${event.at}`}
                  className={`rpc-link ${event.accepted ? '' : 'rejected'}`} vectorEffect="non-scaling-stroke"
                  markerMid={event.accepted ? 'url(#rpc-arrow)' : 'url(#rpc-reject-arrow)'}
                  d={edge(event.from, event.to)} />)}
              </g>
            </svg>
            <ul className="nodes">
              {nodeIds.map(nodeId => {
                const node = observations.get(nodeId);
                const status = node?.ok ? node.status : undefined;
                const point = points.get(nodeId)!;
                return <li key={nodeId} style={{ left: `${point.x}%`, top: `${point.y}%` }}>
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
          <div className="topology-legend">
            <span><i className="legend-relation" aria-hidden="true" />节点报告的 Leader 关系</span>
            <span><i className="legend-rpc" aria-hidden="true" />最近 RPC 请求方向</span>
            <span><i className="legend-rejected" aria-hidden="true" />RPC 拒绝</span>
          </div>
        </section>
        <NodeDetails nodeId={selected} node={observations.get(selected)}
          lastSeen={lastSeen[selected]} observerOffline={error} rpc={rpc} />
      </div>
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
