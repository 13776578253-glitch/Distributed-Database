/** Renders the fixed cluster topology and details for one selected member. */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NodeObservation, RpcObservation } from '../../src/contracts/observation.ts';
import { Icon } from './icons.tsx';
import { Navigation } from './navigation.tsx';
import { ExperimentPage, Services } from './operations.tsx';
import { Clock, PreferencesContext, usePreferences } from './preferences.tsx';
import { placeMembers } from './topology.ts';
import { Timeline } from './timeline.tsx';
import { TransactionPage } from './transaction.tsx';
import { useCluster } from './use-cluster.ts';
import { VerificationPage } from './verification.tsx';
import './style.css';

const roleLabels = { leader: 'Leader', candidate: 'Candidate', follower: 'Follower' };
const rpcLabels = { vote: 'RequestVote', append: 'AppendEntries', snapshot: 'InstallSnapshot', 'read-index': 'ReadIndex' };

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
      <h2 id="detail-heading" tabIndex={-1}><Icon name="detail" />节点详情</h2>
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
          <div><dt>日志末尾索引 <code>logLength</code></dt><dd>{status.logLength}</dd></div>
          <div><dt>已提交 <code>commitIndex</code></dt><dd>{status.commitIndex}</dd></div>
          <div><dt>已应用 <code>lastApplied</code></dt><dd>{status.lastApplied}</dd></div>
          {status.committedTerm !== undefined && <div><dt>提交位置任期</dt><dd>{status.committedTerm}</dd></div>}
          {status.snapshotIndex !== undefined && <>
            <div><dt>快照边界</dt><dd>{status.snapshotIndex} · 任期 {status.snapshotTerm}</dd></div>
            <div><dt>保留日志条目</dt><dd>{status.retainedEntries}</dd></div>
          </>}
        </dl>
      </div>
      <details className="digest">
        <summary>已提交前缀摘要</summary>
        <code>{status.committedDigest}</code>
      </details>
      {status.appliedDigest && <details className="digest">
        <summary>已应用状态摘要</summary><code>{status.appliedDigest}</code>
      </details>}
      {status.membership && <details className="digest">
        <summary>投票配置 · {status.voter ? '投票成员' : '非投票成员'}</summary>
        <p>当前配置索引 {status.membership.index} · {status.membership.configuration.voters.join('、')}</p>
        {status.membership.configuration.next && <p>联合配置新组 · {status.membership.configuration.next.join('、')}</p>}
        {status.appliedMembership && <p>已应用配置索引 {status.appliedMembership.index} · {
          status.appliedMembership.configuration.voters.join('、')}</p>}
      </details>}
    </> : <div className="missing">
      <strong>{probeLabel(node, observerOffline)}</strong>
      <p>等待下一轮采样取得节点状态。</p>
    </div>}
    <section className="recent-rpc" aria-labelledby="rpc-heading">
      <h3 id="rpc-heading">最近 RPC 应答</h3>
      {replies.length ? <ul>{replies.map(event =>
        <li key={`${event.from}/${event.to}`}>
          <span>{event.from} → {event.to}</span>
          <small>{rpcLabels[event.kind]} · {event.accepted ? '接受' : '拒绝'}</small>
          <Clock at={event.at} />
        </li>)}</ul>
        : <p>{rpc ? '近 8 秒无该节点的 RPC 日志，常规心跳省略。' : '暂无可用的 RPC 日志。'}</p>}
    </section>
    <footer className="detail-foot">
      {status && node ? <>节点采样 <Clock at={node.observedAt} /></>
        : lastSeen ? <>最后成功采样 <Clock at={lastSeen} /></> : '暂无成功采样'}
    </footer>
  </aside>;
}

function App() {
  const [preferences, changePreferences] = usePreferences();
  const [revision, refresh] = useState(0);
  const { snapshot, lastSeen, error } = useCluster(preferences.interval, revision);
  const [selection, setSelected] = useState<string>();
  const nodeIds = snapshot?.nodes.map(node => node.nodeId) ?? [];
  const selected = selection ?? nodeIds[0];
  const [route, setRoute] = useState(location.hash.slice(1));
  const [view, search] = route.split('?', 2);
  const activeRun = new URLSearchParams(search).get('run') ?? undefined;
  useEffect(() => {
    const navigate = () => setRoute(location.hash.slice(1));
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  useEffect(() => {
    if (view.startsWith('/')) window.scrollTo(0, 0);
    else if (view) document.getElementById(view)?.scrollIntoView();
  }, [view]);
  const observations = new Map(snapshot?.nodes.map(node => [node.nodeId, node]));
  const statuses = snapshot?.nodes.flatMap(node => node.ok ? [node.status] : []) ?? [];
  const leaders = statuses.filter(status => status.role === 'leader');
  const sampledTerm = statuses.length > 0 ? Math.max(...statuses.map(status => status.term)) : '—';
  const leaderLabel = leaders.map(leader => leader.nodeId).join(' / ') || (snapshot ? '未观测到' : '—');
  const connection = error ? 'offline' : snapshot ? 'online' : 'connecting';
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

  return <PreferencesContext.Provider value={preferences}>
    <Navigation connection={connection} view={view.startsWith('/') ? view : 'cluster-heading'} />
    {view === '/timeline' ? <Timeline /> : view === '/runs' ? <ExperimentPage activeRun={activeRun} />
      : view === '/transaction' ? <TransactionPage activeRun={activeRun} /> : view === '/verification' ? <VerificationPage />
      : view === '/settings' ? <Services change={changePreferences} /> : <main aria-labelledby="cluster-heading">
      <header className="overview-banner">
        <span className="overview-icon"><Icon name="topology" /></span>
        <div>
          <h1 id="cluster-heading" tabIndex={-1}>Raft Cluster</h1>
          <p>Raft 集群 · {preferences.interval ? `每 ${preferences.interval / 1000} 秒采样` : '自动采样已暂停'}</p>
        </div>
        {preferences.interval ? <small>协议多数派待观测</small>
          : <button type="button" className="action" onClick={() => refresh(revision + 1)}>刷新状态</button>}
      </header>
      {error && <p className="warning" role="alert">观测 API 暂不可用，正在等待重连。</p>}
      {snapshot?.startupWarning && <p className="warning" role="status">Compose 初始化提示 · {snapshot.startupWarning}</p>}
      <dl className="metrics">
        <div className="panel metric"><dt><span className="metric-icon"><Icon name="reachability" /></span>HTTP 可达</dt>
          <dd><span id="reachable">{snapshot ? statuses.length : '—'}</span><small> / {nodeIds.length || '—'}</small>
            <span className="metric-note">节点 HTTP 状态采样</span></dd></div>
        <div className="panel metric"><dt><span className="metric-icon"><Icon name="leader" /></span>自报 Leader</dt>
          <dd className="leader-text"><span id="leaders">{leaderLabel}</span>
            <span className="metric-note">{leaders.length === 1 ? `任期 ${leaders[0].term}` : leaders.length > 1
              ? leaders.map(leader => `${leader.nodeId} · 任期 ${leader.term}`).join(' / ') : '来自节点状态采样'}</span></dd></div>
        <div className="panel metric"><dt><span className="metric-icon"><Icon name="term" /></span>最高观测任期</dt>
          <dd><span id="term">{sampledTerm}</span>
            <span className="metric-note">
              {snapshot ? <>最近采样 <Clock at={snapshot.sampledAt} /></> : '等待采样'}
            </span></dd></div>
      </dl>
      <div className="workspace">
        <section className="panel topology" aria-labelledby="topology-heading">
          <header className="panel-heading">
            <h2 id="topology-heading" tabIndex={-1}><Icon name="topology" />节点拓扑</h2>
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
        {selected && <NodeDetails nodeId={selected} node={observations.get(selected)}
          lastSeen={lastSeen[selected]} observerOffline={error} rpc={rpc} />}
      </div>
    </main>}
  </PreferencesContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
