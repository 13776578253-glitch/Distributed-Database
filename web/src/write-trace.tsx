/** Renders one PUT's request, replication, commit and apply evidence. */
import { memo } from 'react';
import type { WriteTraceResult } from './write-trace.ts';
import { Clock } from './preferences.tsx';

export const WriteTrace = memo(function WriteTrace({ trace }: { trace: WriteTraceResult }) {
  const successful = trace.outcome === 'stored' || trace.outcome === 'ok';
  const requestStatus = successful ? 'ok' : trace.response ? 'warn' : 'unknown';
  const replicationStatus = !trace.group ? 'unknown' : trace.rejected.length ? 'warn' : 'ok';
  const commitStatus = trace.commit ? 'ok' : 'unknown';
  const applyStatus = trace.apply ? 'ok' : 'unknown';
  const statusBadge: [string, string] = successful
    ? ['leader', '请求成功']
    : trace.outcome
      ? ['candidate', `结果 ${trace.outcome}`]
      : ['follower', '请求未观测'];
  const followers = trace.nodes.filter(node => node.role === 'follower');

  return <section className="write-trace" aria-labelledby="write-trace-heading">
    <div className="activity-heading">
      <div>
        <h2 id="write-trace-heading">写入追踪</h2>
        <p className="muted">
          {trace.key}{trace.seq !== undefined ? ` · seq ${trace.seq}` : ''}
          {trace.index !== undefined ? ` · index ${trace.index}` : ''}
        </p>
      </div>
      <span className={`badge ${statusBadge[0]}`}>{statusBadge[1]}</span>
    </div>
    {trace.leader && <div className="trace-flow" aria-label="复制拓扑">
      <span className="trace-node leader">{trace.leader}</span>
      {followers.length > 0 && <span className="trace-arrow" aria-hidden="true">→</span>}
      {followers.map(node => <span key={node.nodeId}
        className={`trace-node ${node.replicated === 'accepted' ? 'ok' : node.replicated === 'rejected' ? 'bad' : ''}`}>
        {node.nodeId}
      </span>)}
    </div>}
    <ol className="write-steps">
      <li className={requestStatus}><span className="step-dot" aria-hidden="true" />
        <strong>请求</strong>
        <span>{trace.request ? <>PUT <Clock at={trace.request.at} /></> : '未观测到请求'}
          {trace.httpStatus !== undefined ? ` · HTTP ${trace.httpStatus}` : ''}
          {trace.outcome ? ` · ${trace.outcome}` : ''}</span></li>
      <li className={replicationStatus}><span className="step-dot" aria-hidden="true" />
        <strong>日志复制</strong>
        <span>{trace.group
          ? <>任期 {trace.term ?? '—'} · 索引 {trace.index ?? trace.group.indexes?.join('–') ?? '—'}
            {' · '}接受 {trace.accepted.join('、') || '无'}
            {trace.rejected.length ? ` · 拒绝 ${trace.rejected.join('、')}` : ''}
            {' · '}<Clock at={trace.group.events[0].at} /></>
          : '未观测到 AppendEntries 证据'}</span></li>
      <li className={commitStatus}><span className="step-dot" aria-hidden="true" />
        <strong>提交</strong>
        <span>{trace.commit
          ? <>commitIndex ≥ {trace.commit.index} · {trace.commit.nodeId} · 采样 <Clock at={trace.commit.at} /></>
          : trace.index === undefined ? '未观测到条目索引' : '未观测到提交采样'}</span></li>
      <li className={applyStatus}><span className="step-dot" aria-hidden="true" />
        <strong>状态机应用</strong>
        <span>{trace.apply
          ? <>lastApplied ≥ {trace.apply.index} · {trace.apply.nodeId} · 采样 <Clock at={trace.apply.at} /></>
          : trace.index === undefined ? '未观测到条目索引' : '未观测到应用采样'}</span></li>
    </ol>
    {(trace.group || trace.isEvidence) && trace.nodes.length > 0 && <div className="table-scroll trace-table">
      <table className="data-table">
        <caption>按节点观测</caption>
        <thead><tr><th>节点</th><th>复制</th><th>应用</th><th>lastApplied</th></tr></thead>
        <tbody>{trace.nodes.map(node => <tr key={node.nodeId}>
          <td><strong>{node.nodeId}</strong>{node.role === 'leader' ? ' · Leader' : ''}</td>
          <td>{node.replicated === 'source' ? '源' : node.replicated === 'accepted' ? '接受' : node.replicated === 'rejected' ? '拒绝' : '未观测'}</td>
          <td>{node.applied === 'applied' ? '已应用' : node.applied === 'pending' ? '未应用' : '未观测'}</td>
          <td>{node.lastApplied ?? '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    <div className="trace-notes">
      {trace.notes.map((note, index) => <p className="trace-note" key={index}>{note}</p>)}
    </div>
  </section>;
});
