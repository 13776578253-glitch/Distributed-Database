/** Presents approved experiment and service actions with their actual Evidence IDs. */
import { useContext, useState } from 'react';
import { experimentNames } from '../../src/contracts/console.ts';
import type { ConsoleOperation, OperationJob, OperationsStatus, ServiceStatus } from '../../src/contracts/console.ts';
import { postJson, usePolling } from './console-api.ts';
import { Icon } from './icons.tsx';
import { Clock, intervals, logLimits, PreferencesContext, themes } from './preferences.tsx';
import type { Preferences } from './preferences.tsx';
import { Experiments } from './timeline.tsx';

const actionLabels = {
  R01: '终止当前 Leader，等待重新选举，随后恢复原节点。',
  R02: '暂时阻断 3–2 组之间的 RPC，验证后恢复链路。',
  R03: '采集并发读写历史，判定留待 S4。',
};
const jobLabels = { running: '执行中', succeeded: '执行完成', failed: '执行失败' };

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
        {job.error && <small className="job-error">{job.error}</small>}
      </div>
      <span className="muted"><Clock at={job.startedAt} /></span>
      <span className={`badge ${job.status === 'failed' ? 'unknown' : 'follower'}`}>
        {job.phase === 'recovering' ? '恢复中' : jobLabels[job.status]}
      </span>
      {job.verdict && <span className={`badge verdict-${job.verdict.toLowerCase()}`}>{job.verdict}</span>}
      {job.runId && job.verdict && <a className="file-link"
        href={`/api/runs/${job.action.kind === 'experiment' ? job.action.experimentId : 'SERVICE'}/${job.runId}/files/result.json`}
        target="_blank" rel="noreferrer">判定原文</a>}
    </div>)}
  </div>;
}

export function ExperimentPage() {
  const operations = useOperations();
  const jobs = operations.data?.jobs.filter(job => job.action.kind === 'experiment') ?? [];
  const finished = jobs.find(job => job.status !== 'running' && job.verdict);

  return <main aria-labelledby="runs-heading">
    <header className="overview-banner">
      <span className="overview-icon"><Icon name="detail" /></span>
      <div><h1 id="runs-heading">实验与回放</h1><p>调度 Raft 实验，按 Run 查看原始 Evidence</p></div>
    </header>
    <section className="panel run-summary">
      <div className="activity-heading"><h2>实验调度</h2><span className="muted">{operations.data?.project}</span></div>
      <div className="activity-controls">
        {(['R01', 'R02', 'R03'] as const).map(experimentId => <button key={experimentId} type="button"
          className="action" disabled={operations.disabled} onClick={() => void operations.submit({ kind: 'experiment', experimentId })}>
          {experimentId} · {experimentNames[experimentId]}
        </button>)}
      </div>
      {operations.data?.lock && <p className="muted">
        {operations.data.lock.recoveryRequired ? '上次故障恢复失败，项目等待人工恢复' : '项目操作锁已占用'} {operations.data.lock.runId ?? ''}
      </p>}
      {operations.feedback && <p className="muted" role="status">{operations.feedback}</p>}
      <JobList jobs={jobs} />
    </section>
    <Experiments activeRun={finished?.runId} />
  </main>;
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
        <label>集群轮询<select aria-label="集群轮询" value={preferences.interval}
          onChange={event => change({ ...preferences, interval: Number(event.target.value) as Preferences['interval'] })}>
          {intervals.map(interval => <option key={interval} value={interval}>{interval ? `${interval / 1000} 秒` : '暂停'}</option>)}
        </select></label>
        <label>时间格式<select aria-label="时间格式" value={preferences.hour12 ? '12' : '24'}
          onChange={event => change({ ...preferences, hour12: event.target.value === '12' })}>
          <option value="24">24 小时制</option><option value="12">12 小时制</option>
        </select></label>
        <label>主题<select aria-label="主题" value={preferences.theme}
          onChange={event => change({ ...preferences, theme: event.target.value as Preferences['theme'] })}>
          {themes.map(theme => <option key={theme} value={theme}>{{ light: '浅色', dark: '深色', system: '跟随系统' }[theme]}</option>)}
        </select></label>
        <label>实时日志显示上限<select aria-label="实时日志显示上限" value={preferences.logLimit}
          onChange={event => change({ ...preferences, logLimit: Number(event.target.value) as Preferences['logLimit'] })}>
          {logLimits.map(limit => <option key={limit} value={limit}>{limit} 条</option>)}
        </select></label>
      </div>
      <p className="muted">Observer 固定保留最近 400 条用于 SSE 续传。实验原始证据由运行器保存。</p>
    </section>
  </main>;
}
