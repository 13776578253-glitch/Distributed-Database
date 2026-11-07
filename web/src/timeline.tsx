/** Renders live protocol events and stepwise playback of immutable Evidence. */
import { useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { experimentNames, raftExperiments } from '../../src/contracts/console.ts';
import type { ExperimentId, RunDetail, RunSummary, TimelineEvent } from '../../src/contracts/console.ts';
import { getJson } from './console-api.ts';
import { Icon } from './icons.tsx';
import { Clock, PreferencesContext } from './preferences.tsx';

const kindLabels: Record<string, string> = {
  'raft.role': '角色变化', 'raft.status': '状态采样', 'observer.gap': '采集缺口',
  vote: 'RequestVote', append: 'AppendEntries', assertion: '实验断言',
  snapshot: 'InstallSnapshot', 'read-index': 'ReadIndex',
  'fault.kill': '终止节点', 'fault.restart': '重启节点', 'fault.partition': 'RPC 分区',
  'fault.links': '链路配置', 'client.invoke': '调用发起', 'client.return': '调用返回',
  'verification.pending': '判定待接入',
};

function EventTable({ events, reverse = false }: { events: TimelineEvent[]; reverse?: boolean }) {
  const [node, setNode] = useState('');
  const [term, setTerm] = useState('');
  const [index, setIndex] = useState('');
  const [kind, setKind] = useState('');
  const [selection, select] = useState<string>();
  const nodes = [...new Set([...events.flatMap(event => event.nodes)])];
  const kinds = [...new Set(events.map(event => event.kind))];
  const filtered = events.filter(event =>
    (!node || event.nodes.includes(node))
    && (!kind || event.kind === kind)
    && (!term || event.term === Number(term) || event.terms?.includes(Number(term)))
    && (!index || event.indexSamples?.includes(Number(index))
      || (event.indexes && Number(index) >= event.indexes[0] && Number(index) <= event.indexes[1])));
  const rows = reverse ? filtered.toReversed() : filtered;
  const selected = rows.find(event => event.id === selection) ?? filtered.at(-1);

  return <section className="panel activity">
    <div className="filters">
      <label>节点<select aria-label="节点" value={node} onChange={event => setNode(event.target.value)}>
        <option value="">全部</option>{nodes.map(id => <option key={id}>{id}</option>)}</select></label>
      <label>任期<input type="number" min="0" step="1" value={term} placeholder="全部" onChange={event => setTerm(event.target.value)} /></label>
      <label>索引<input type="number" min="0" step="1" value={index} placeholder="全部" onChange={event => setIndex(event.target.value)} /></label>
      <label>类型<select aria-label="类型" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="">全部</option>{kinds.map(id => <option key={id} value={id}>{kindLabels[id] ?? id}</option>)}</select></label>
      <span className="muted">{filtered.length} / {events.length} 条</span>
    </div>
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>时间</th><th>事件</th><th>节点</th><th>任期</th><th>索引</th></tr></thead>
        <tbody>{rows.map(event => <tr key={event.id} className={selected?.id === event.id ? 'selected-row' : ''}>
          <td><Clock at={event.at} /></td>
          <td><button type="button" className="row-action" aria-pressed={selected?.id === event.id} onClick={() => select(event.id)}>
            {kindLabels[event.kind] ?? event.kind}
            {event.label !== event.kind && <small>{event.label}</small>}
          </button></td>
          <td>{event.nodes.join(' → ') || '—'}</td>
          <td>{event.term ?? (event.terms?.join(' / ') || '—')}</td>
          <td>{event.indexes?.join('–') ?? (event.indexSamples?.join(' / ') || '—')}</td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <p className="empty-state">当前没有符合条件的事件</p>}
    </div>
    {selected && <details className="raw-event" open>
      <summary>原始事件 · {selected.at}</summary>
      <pre>{JSON.stringify(selected.raw, null, 2)}</pre>
    </details>}
  </section>;
}

export function Timeline() {
  const { logLimit } = useContext(PreferencesContext);
  const [entries, setEntries] = useState<TimelineEvent[]>([]);
  const [frozen, freeze] = useState<TimelineEvent[]>();
  const [state, setState] = useState('连接中');
  const [gap, setGap] = useState('');

  useEffect(() => {
    const stream = new EventSource('/api/events/stream');
    stream.onopen = () => setState('已连接');
    stream.onerror = () => setState('等待重连');
    stream.onmessage = message => {
      const entry: TimelineEvent = JSON.parse(message.data);
      setEntries(previous => previous.some(event => event.id === entry.id) ? previous : [...previous, entry].slice(-logLimit));
    };
    stream.addEventListener('gap', message => {
      setEntries([]);
      setGap(JSON.parse(message.data).reason);
    });
    return () => stream.close();
  }, [logLimit]);

  return <main aria-labelledby="timeline-heading">
    <header className="overview-banner">
      <span className="overview-icon"><Icon name="topology" /></span>
      <div><h1 id="timeline-heading">Raft Timeline</h1><p>Compose 实时日志 · <span role="status">{state}</span></p></div>
      <button type="button" className="action" onClick={() => freeze(frozen ? undefined : entries)}>
        {frozen ? '恢复跟随' : '暂停跟随'}
      </button>
    </header>
    {gap && <p className="warning" role="status">{gap}</p>}
    <EventTable events={frozen ?? entries} reverse />
  </main>;
}

function Playback({ run, findings }: { run: RunDetail; findings?: ReactNode }) {
  const [count, setCount] = useState(run.events.length);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || count >= run.events.length) return;
    const current = Date.parse(run.events[count - 1]?.at ?? run.events[0].at);
    const next = Date.parse(run.events[count].at);
    const timer = setTimeout(() => setCount(count + 1), Math.max(160, Math.min(1500, next - current)));
    return () => clearTimeout(timer);
  }, [count, playing, run]);
  const path = `/api/runs/${run.result.experimentId}/${run.result.runId}/files/`;
  return <>
    <section className="panel run-summary">
      <div className="activity-heading">
        <div><h2>{run.result.experimentId} · {experimentNames[run.result.experimentId as keyof typeof experimentNames]}</h2>
          <p className="muted">{run.result.runId}</p></div>
        <span className={`badge verdict-${run.result.status.toLowerCase()}`}>{run.result.status}</span>
      </div>
      {run.result.experimentId === 'R03' && <p className="muted">并发历史已采集，线性一致性此记录为历史采集，验证结果可在一致性页面查看。</p>}
      {run.result.experimentId === 'R04' && <p className="muted">隔离探针历史 · 事件按证据文件顺序展示。</p>}
      <div className="evidence-links">{run.files.map(name => <a key={name} href={path + name} target="_blank" rel="noreferrer">{name}</a>)}</div>
      <details><summary>断言与运行元数据</summary>
        <ul className="assertions">{run.result.assertionResults.map((item, i) =>
          <li key={i}><strong>{item.passed ? '通过' : '失败'}</strong> · {item.name}</li>)}</ul>
        <pre>{JSON.stringify(run.metadata, null, 2)}</pre>
      </details>
    </section>
    {findings}
    {run.invalidLines > 0 && <p className="warning">{run.invalidLines} 行事件无法解析，原始记录仍可打开。</p>}
    <div className="activity-controls">
      <button className="action" type="button" disabled={!run.events.length} onClick={() => { setCount(0); setPlaying(true); }}>从头播放</button>
      <button className="action" type="button" disabled={count >= run.events.length}
        onClick={() => setPlaying(!playing)}>{playing ? '暂停' : '继续'}</button>
      <button className="action" type="button" disabled={count >= run.events.length}
        onClick={() => { setPlaying(false); setCount(count + 1); }}>下一步</button>
      <button className="action" type="button" onClick={() => { setPlaying(false); setCount(run.events.length); }}>显示全部</button>
      <span className="muted">{count} / {run.events.length} 步</span>
    </div>
    <EventTable events={run.events.slice(0, count)} />
  </>;
}

export function Experiments({ activeRun, ids = raftExperiments, renderFindings }: {
  activeRun?: string;
  ids?: readonly ExperimentId[];
  renderFindings?: (run: RunDetail) => ReactNode;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [category, setCategory] = useState('');
  const [selection, select] = useState('');
  const [run, setRun] = useState<RunDetail>();
  const [error, setError] = useState('');

  useEffect(() => {
    const cancel = new AbortController();
    getJson<RunSummary[]>('/api/runs', cancel.signal).then(items => {
      if (!cancel.signal.aborted) { setRuns(items); setError(''); }
    }).catch((failure: Error) => {
      if (!cancel.signal.aborted) setError(failure.message);
    });
    return () => cancel.abort();
  }, [activeRun]);

  const visible = runs.filter(item => ids.includes(item.experimentId) && (!category || item.experimentId === category));
  const chosen = visible.find(item => item.runId === (selection || activeRun)) ?? visible[0];
  const experimentId = chosen?.experimentId;
  const runId = chosen?.runId;
  useEffect(() => {
    if (!experimentId || !runId) return;
    const cancel = new AbortController();
    getJson<RunDetail>(`/api/runs/${experimentId}/${runId}`, cancel.signal).then(detail => {
      if (cancel.signal.aborted) return;
      setRun(detail);
      setError('');
    }).catch((failure: Error) => {
      if (!cancel.signal.aborted) setError(failure.message);
    });
    return () => cancel.abort();
  }, [experimentId, runId]);

  return <>
    <section className="panel activity">
      <div className="filters">
        <label>实验<select aria-label="实验" value={category} onChange={event => { setCategory(event.target.value); select(''); }}>
          <option value="">全部</option>{ids.map(id => <option key={id} value={id}>{id} · {experimentNames[id]}</option>)}</select></label>
        <label>运行<select aria-label="运行" value={runId ?? ''} onChange={event => select(event.target.value)}>
          {!visible.length && <option value="">暂无记录</option>}
          {visible.map(item => <option key={item.runId} value={item.runId}>{item.experimentId} · {item.runId} · {item.status}</option>)}</select></label>
      </div>
    </section>
    {error && <p className="warning" role="alert">{error}</p>}
    {run && run.result.runId === runId ? <Playback key={runId} run={run} findings={renderFindings?.(run)} />
      : runId && !error ? <p className="muted" role="status">读取 Evidence 中…</p> : null}
  </>;
}
