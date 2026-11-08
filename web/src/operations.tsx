/** Presents approved experiment and service actions with their actual Evidence IDs. */
import { useContext, useState } from 'react';
import { experimentNames } from '../../src/contracts/console.ts';
import type { ConsoleOperation, OperationJob, OperationsStatus, ServiceStatus } from '../../src/contracts/console.ts';
import { postJson, usePolling } from './console-api.ts';
import { Icon } from './icons.tsx';
import { Clock, intervals, logLimits, PreferencesContext } from './preferences.tsx';
import type { Preferences } from './preferences.tsx';
import { Select } from './select.tsx';
import { ThemePicker } from './theme-picker.tsx';
import { Experiments } from './timeline.tsx';

const actionLabels = {
  R01: '终止当前 Leader，等待重新选举，随后恢复原节点。',
  R02: '暂时阻断 3–2 组之间的 RPC，验证后恢复链路。',
  R03: '采集并发读写历史，供验证器独立回放。',
};
const jobLabels = { running: '执行中', succeeded: '执行完成', failed: '执行失败' };
const impactLabels = { R01: '影响：Leader 切换', R02: '影响：3–2 网络分区', R03: '影响：只采集，不改拓扑' } as const;

function useOperations() {
  const { data, error } = usePolling<OperationsStatus>('/api/operations', 1000);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const busy = submitting || !data || Boolean(error || data.lock || data.jobs.some(job => job.status === 'running'));

  async function submit(action: ConsoleOperation) {
    const description = action.kind === 'experiment' ? actionLabels[action.experimentId] : `重启当前 Compose 项目的 ${action.nodeId}。`;
    if (!window.confirm(description)) return;
    setSubmitting(true);
    setMessage('');
    try {
      const job = await postJson<OperationJob>('/api/operations', action);
      setMessage(`已开始 · ${job.runId}`);
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : String(failure));
    } finally { setSubmitting(false); }
  }
  return { data, busy, disabled: busy || !data?.project, feedback: error || message, submit };
}

function JobList({ jobs }: { jobs: OperationJob[] }) {
  return <div className="job-list">
    {!jobs.length && <p className="muted">当前会话暂无任务。</p>}
    {jobs.map(job => <div className="job" key={job.id}>
      <div>
        <strong>{job.action.kind === 'experiment'
          ? `${job.action.experimentId} · ${experimentNames[job.action.experimentId]}`
          : `重启 ${job.action.nodeId}`}</strong>
        {job.runId && <small>{job.runId}</small>}
        {job.action.kind === 'experiment' && <small className="job-impact">{impactLabels[job.action.experimentId]}</small>}
        {job.error && <small className="job-error">{job.error}</small>}
      </div>
      <span className="muted"><Clock at={job.startedAt} /></span>
      <span className={`badge ${job.status === 'failed' ? 'unknown' : 'follower'}`}>
        {job.phase === 'recovering' ? '恢复中' : jobLabels[job.status]}
      </span>
      {job.verdict && <span className={`badge verdict-${job.verdict.toLowerCase()}`}>{job.verdict}</span>}
      {job.action.kind === 'experiment' && job.action.experimentId !== 'R03'
        && <a className="job-link" href="#cluster-heading">查看集群</a>}
      {job.runId && job.verdict && <a className="file-link"
        href={`/api/runs/${job.action.kind === 'experiment' ? job.action.experimentId : 'SERVICE'}/${job.runId}/files/result.json`}
        target="_blank" rel="noreferrer">判定原文</a>}
    </div>)}
  </div>;
}

export interface ClusterContext {
  leader?: string;
  term?: number;
  reachable: number;
  total: number;
  offline: boolean;
}

export function ExperimentPage({ activeRun, cluster }: { activeRun?: string; cluster: ClusterContext }) {
  const operations = useOperations();
  const jobs = operations.data?.jobs.filter(job => job.action.kind === 'experiment') ?? [];
  const finished = jobs.find(job => job.status !== 'running' && job.verdict);

  return <>
    <header className="overview-banner">
      <span className="overview-icon"><Icon name="detail" /></span>
      <div><h1 id="runs-heading">实验与回放</h1><p>调度 Raft 实验，按 Run 查看原始 Evidence</p></div>
    </header>
    <section className="panel run-summary">
      <div className="activity-heading"><h2>实验调度</h2><span className="muted">{operations.data?.project}</span></div>
      <div className={`cluster-context${cluster.offline ? ' offline' : ''}`}>
        <span className="cluster-state">
          <span className={`dot ${cluster.offline ? 'offline' : cluster.total === 0 ? 'unknown' : cluster.leader ? 'online' : 'unknown'}`} />
          {cluster.offline ? '观测离线' : cluster.total === 0 ? '等待集群采样'
            : cluster.leader ? `Leader ${cluster.leader}${cluster.term ? ` · T${cluster.term}` : ''}` : 'Leader 未确认'}
          <span className="muted">{cluster.total ? `${cluster.reachable}/${cluster.total} 可达` : '—'}</span>
        </span>
        <span className="muted">R01 切换 Leader · R02 3–2 分区 · R03 只采集历史</span>
        <a className="context-link" href="#cluster-heading">查看集群变化</a>
      </div>
      <div className="activity-controls">
        {(['R01', 'R02', 'R03'] as const).map(experimentId => <button key={experimentId} type="button"
          className="action" disabled={operations.disabled || operations.data?.membershipLab}
          onClick={() => void operations.submit({ kind: 'experiment', experimentId })}>
          {experimentId} · {experimentNames[experimentId]}
        </button>)}
      </div>
      {operations.data?.membershipLab && <p className="muted">R01–R03 使用固定五节点实验环境。</p>}
      {operations.data?.lock && <p className="muted">
        {operations.data.lock.recoveryRequired ? '上次故障恢复失败，项目等待人工恢复' : '项目操作锁已占用'} {operations.data.lock.runId ?? ''}
      </p>}
      {operations.feedback && <p className="muted" role="status">{operations.feedback}</p>}
      <JobList jobs={jobs} />
    </section>
    <Experiments key={activeRun} activeRun={activeRun ?? finished?.runId} swimlane />
  </>;
}

export function Services({ change }: { change: (preferences: Preferences) => void }) {
  const preferences = useContext(PreferencesContext);
  const operations = useOperations();
  const { data: services, error } = usePolling<ServiceStatus>('/api/services', 2500);
  const [restartPid, setRestartPid] = useState<number>();
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState('');
  const awaitingRestart = restartPid !== undefined && services?.pid === restartPid;

  async function restartObserver() {
    if (!services || !window.confirm('重启本机观测服务，实时事件连接将自动重连。')) return;
    setRestarting(true);
    setMessage('');
    try {
      await postJson('/api/services/restart-observer', {});
      setRestartPid(services.pid);
      setMessage('已请求重启');
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : String(failure));
    } finally { setRestarting(false); }
  }

  return <main aria-labelledby="settings-heading">
    <header className="overview-banner">
      <span className="overview-icon"><Icon name="detail" /></span>
      <div><h1 id="settings-heading">设置</h1><p>监听状态、项目容器与本地显示偏好</p></div>
    </header>
    <section className="panel run-summary">
      <div className="activity-heading">
        <div><h2>观测服务</h2><p className="muted">{services?.listener ?? '读取监听状态…'}</p></div>
        <button type="button" className="action" disabled={operations.busy || restarting || awaitingRestart || !services}
          onClick={() => void restartObserver()}>重启观测服务</button>
      </div>
      <dl className="service-facts">
        <div><dt>Compose 项目</dt><dd>{services?.project ?? '—'}</dd></div>
        <div><dt>服务进程</dt><dd>{services?.pid ?? '—'}</dd></div>
        <div><dt>日志采集</dt><dd>{services?.logs.available === true ? '可用' : services?.logs.available === false ? '读取中断' : '等待采样'}</dd></div>
        <div><dt>SSE 订阅</dt><dd>{services?.logs.subscribers ?? '—'}</dd></div>
      </dl>
      {message && <p className="muted" role="status">
        {restartPid !== undefined && !awaitingRestart && services ? `观测服务已重启 · PID ${services.pid}` : message}
      </p>}
      {error && <p className="warning" role="status">{error}</p>}
    </section>
    <section className="panel run-summary">
      <div className="activity-heading"><h2>Docker 容器</h2><span className="muted">{operations.data?.lock ? '项目操作锁已占用' : '项目成员'}</span></div>
      {services?.dockerError && <p className="warning" role="status">{services.dockerError}</p>}
      <div className="table-scroll">
        <table className="data-table service-table">
          <thead><tr><th>节点</th><th>容器状态</th><th>健康检查</th><th>操作</th></tr></thead>
          <tbody>{services?.nodes.map(node => <tr key={node.nodeId}>
            <td><strong>{node.nodeId}</strong></td><td>{node.state}</td><td>{node.health}</td>
            <td><button className="action" type="button" disabled={operations.disabled || Boolean(error) || !node.containerId}
              onClick={() => void operations.submit({ kind: 'restart-node', nodeId: node.nodeId })}>重启 {node.nodeId}</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {operations.feedback && <p className="muted" role="status">{operations.feedback}</p>}
      <JobList jobs={operations.data?.jobs.filter(job => job.action.kind === 'restart-node') ?? []} />
    </section>
    <section className="panel run-summary">
      <div className="activity-heading"><div><h2>数据、日志与外观</h2><p className="muted">偏好保存在当前浏览器</p></div></div>
      <div className="filters preferences">
        <div className="theme-field"><span>主题</span>
          <ThemePicker value={preferences.theme} onChange={theme => change({ ...preferences, theme })} />
        </div>
        <label>集群轮询<Select label="集群轮询" value={preferences.interval}
          options={intervals.map(interval => ({ value: interval, label: interval ? `${interval / 1000} 秒` : '暂停' }))}
          onChange={interval => change({ ...preferences, interval })} /></label>
        <label>时间格式<Select label="时间格式" value={preferences.hour12 ? '12' : '24'}
          options={[{ value: '24', label: '24 小时制' }, { value: '12', label: '12 小时制' }]}
          onChange={value => change({ ...preferences, hour12: value === '12' })} /></label>
        <label>实时日志显示上限<Select label="实时日志显示上限" value={preferences.logLimit}
          options={logLimits.map(limit => ({ value: limit, label: `${limit} 条` }))}
          onChange={logLimit => change({ ...preferences, logLimit })} /></label>
      </div>
      <p className="muted">Observer 固定保留最近 400 条用于 SSE 续传。实验原始证据由运行器保存。</p>
    </section>
  </main>;
}
