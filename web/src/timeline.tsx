/** Renders live protocol events and stepwise playback of immutable Evidence. */
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { experimentNames, raftExperiments } from '../../src/contracts/console.ts';
import type { ExperimentId, RunDetail, RunSummary, TimelineEvent } from '../../src/contracts/console.ts';
import type { ClusterObservation } from '../../src/contracts/observation.ts';
import { getJson, usePolling } from './console-api.ts';
import { Icon } from './icons.tsx';
import { Clock, PreferencesContext } from './preferences.tsx';
import { Select } from './select.tsx';
import { Swimlane } from './swimlane.tsx';
import { deriveLanes, timeExtent } from './swimlane.ts';
import type { RoleSeed } from './swimlane.ts';
import { WorkloadPanel } from './workload.tsx';
import { deriveWriteTrace } from './write-trace.ts';
import { WriteTrace } from './write-trace.tsx';

const kindLabels: Record<string, string> = {
  'raft.role': '角色变化', 'raft.status': '状态采样', 'observer.gap': '采集缺口',
  vote: 'RequestVote', append: 'AppendEntries', assertion: '实验断言',
  snapshot: 'InstallSnapshot', 'read-index': 'ReadIndex',
  'fault.kill': '终止节点', 'fault.restart': '重启节点', 'fault.partition': 'RPC 分区',
  'fault.links': '链路配置', 'client.invoke': '调用发起', 'client.return': '调用返回',
  'verification.pending': '判定待接入', 'rpc.error': 'RPC 失败',
  'demo.start': '演示开始', 'demo.stop': '演示停止',
  'demo.request': '演示请求', 'demo.response': '演示响应', 'demo.error': '演示异常',
};

const EventTable = memo(function EventTable({ events, selectedId, onSelect, followLatest = false, reverse = false }: {
  events: readonly TimelineEvent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  followLatest?: boolean;
  reverse?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!followLatest || !scroller.current) return;
    scroller.current.scrollTop = reverse ? 0 : scroller.current.scrollHeight;
  }, [events.length, followLatest, reverse]);
  return <div className="table-scroll" ref={scroller}>
    <table className="data-table timeline-table">
      <thead><tr><th>时间</th><th>事件</th><th>节点</th><th>任期</th><th>索引</th></tr></thead>
      <tbody>{events.map(event => <tr key={event.id} className={selectedId === event.id ? 'selected-row' : ''}>
        <td><Clock at={event.at} /></td>
        <td><button type="button" className="row-action" aria-pressed={selectedId === event.id}
          onClick={() => onSelect(event.id)}>
          {kindLabels[event.kind] ?? event.kind}
          {event.label !== event.kind && <small>{event.label}</small>}
        </button></td>
        <td>{event.nodes.join(' → ') || '—'}</td>
        <td>{event.term ?? (event.terms?.join(' / ') || '—')}</td>
        <td>{event.indexes?.join('–') ?? (event.indexSamples?.join(' / ') || '—')}</td>
      </tr>)}</tbody>
    </table>
    {!events.length && <p className="empty-state">当前没有符合条件的事件</p>}
  </div>;
});

function EventExplorer({ events, lanes, extent, windowMs, follow, seeds, samples, reverse = false, swimlane = false, trace = false, playback = false, windowControl }: {
  events: readonly TimelineEvent[];
  lanes?: readonly string[];
  extent?: readonly [number, number];
  windowMs?: number;
  follow?: boolean;
  seeds?: readonly RoleSeed[];
  samples?: readonly ClusterObservation[];
  reverse?: boolean;
  swimlane?: boolean;
  trace?: boolean;
  playback?: boolean;
  windowControl?: ReactNode;
}) {
  const [node, setNode] = useState('');
  const [term, setTerm] = useState('');
  const [index, setIndex] = useState('');
  const [kind, setKind] = useState('');
  const [selection, select] = useState<string>();
  const [manual, setManual] = useState(false);
  const nodes = useMemo(() => lanes?.length ? lanes : deriveLanes(events), [lanes, events]);
  const kinds = useMemo(() => [...new Set(events.map(event => event.kind))], [events]);
  const filtered = useMemo(() => events.filter(event =>
    (!node || event.nodes.includes(node))
    && (!kind || event.kind === kind)
    && (!term || event.term === Number(term) || event.terms?.includes(Number(term)))
    && (!index || event.indexSamples?.includes(Number(index))
      || (event.indexes && Number(index) >= event.indexes[0] && Number(index) <= event.indexes[1]))),
  [events, node, term, index, kind]);
  const rows = useMemo(() => reverse ? filtered.toReversed() : filtered, [filtered, reverse]);
  const selected = rows.find(event => event.id === selection)
    ?? (playback ? rows.at(-1) : rows[0]);
  useEffect(() => {
    const latest = playback ? rows.at(-1) : rows[0];
    if (playback && !manual) {
      if (latest && latest.id !== selection) select(latest.id);
      return;
    }
    if (selection !== undefined && rows.some(event => event.id === selection)) return;
    if (latest && latest.id !== selection) {
      select(latest.id);
      setManual(false);
    }
  }, [rows, selection, playback, manual]);
  const choose = useCallback((id: string) => {
    setManual(true);
    select(id);
  }, []);
  const writeTrace = useMemo(() => trace && manual && selected
    ? deriveWriteTrace(events, selected, samples) : undefined,
  [trace, manual, events, selected, samples]);

  return <section className={`panel activity${playback ? ' playback' : ''}`}>
    <div className="filters">
      <label>节点<Select label="节点" value={node}
        options={[{ value: '', label: '全部' }, ...nodes.map(id => ({ value: id, label: id }))]}
        onChange={setNode} /></label>
      <label>任期<input type="number" min="0" step="1" value={term} placeholder="全部"
        onChange={event => setTerm(event.target.value)} /></label>
      <label>索引<input type="number" min="0" step="1" value={index} placeholder="全部"
        onChange={event => setIndex(event.target.value)} /></label>
      <label>类型<Select label="类型" value={kind}
        options={[{ value: '', label: '全部' }, ...kinds.map(id => ({ value: id, label: kindLabels[id] ?? id }))]}
        onChange={setKind} /></label>
      {windowControl}
      <span className="muted">{filtered.length} / {events.length} 条</span>
    </div>
    {swimlane && <Swimlane events={filtered} lanes={nodes} history={events} extent={extent}
      windowMs={windowMs} follow={follow} seeds={seeds} selectedId={selected?.id}
      focusGroupKey={writeTrace?.groupKey} onSelect={choose} />}
    {swimlane && writeTrace && <WriteTrace trace={writeTrace} />}
    <EventTable events={rows} selectedId={selected?.id} onSelect={choose}
      followLatest={reverse || playback} reverse={reverse} />
    {selected ? <details className="raw-event" open={!playback}>
      <summary>原始事件 · {selected.at}</summary>
      <pre>{JSON.stringify(selected.raw, null, 2)}</pre>
    </details> : playback && <details className="raw-event">
      <summary>原始事件 · 等待播放</summary>
    </details>}
  </section>;
}

export function Timeline() {
  const { logLimit, interval } = useContext(PreferencesContext);
  const [entries, setEntries] = useState<TimelineEvent[]>([]);
  const [frozen, freeze] = useState<TimelineEvent[]>();
  const [state, setState] = useState('连接中');
  const [gap, setGap] = useState('');
  const [windowMs, setWindowMs] = useState(30000);
  const [samples, setSamples] = useState<ClusterObservation[]>([]);
  const { data: cluster } = usePolling<ClusterObservation>('/api/cluster', interval);

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

  useEffect(() => {
    if (!cluster) return;
    setSamples(previous => previous.at(-1)?.sampledAt === cluster.sampledAt
      ? previous : [...previous, cluster].slice(-40));
  }, [cluster]);

  const live = frozen ?? entries;
  const lanes = useMemo(() => cluster?.nodes.map(node => node.nodeId), [cluster]);
  const seeds = useMemo<RoleSeed[]>(() => cluster?.nodes.flatMap(node => node.ok
    ? [{ nodeId: node.nodeId, role: node.status.role, term: node.status.term }]
    : []) ?? [], [cluster]);

  return <>
    <header className="overview-banner">
      <span className="overview-icon"><Icon name="topology" /></span>
      <div><h1 id="timeline-heading">Raft Timeline</h1><p>Compose 实时日志 · <span role="status">{state}</span></p></div>
      <button type="button" className="action" onClick={() => freeze(frozen ? undefined : entries)}>
        {frozen ? '恢复跟随' : '暂停跟随'}
      </button>
    </header>
    {gap && <p className="warning" role="status">{gap}</p>}
    <WorkloadPanel />
    <EventExplorer events={live} lanes={lanes} windowMs={windowMs} follow={!frozen}
      seeds={seeds} samples={samples} reverse swimlane trace
      windowControl={<label>窗口<Select label="时间窗口" value={windowMs}
        options={[{ value: 15000, label: '15 秒' }, { value: 30000, label: '30 秒' },
          { value: 60000, label: '60 秒' }, { value: 0, label: '全部' }]}
        onChange={setWindowMs} /></label>} />
  </>;
}

function Playback({ run, findings, swimlane }: { run: RunDetail; findings?: ReactNode; swimlane?: boolean }) {
  const [count, setCount] = useState(run.events.length);
  const [playing, setPlaying] = useState(false);
  const extent = useMemo(() => timeExtent(run.events), [run.events]);
  const lanes = useMemo(() => deriveLanes(run.events), [run.events]);
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
    <EventExplorer events={run.events.slice(0, count)} lanes={lanes} extent={extent}
      swimlane={swimlane} trace={swimlane} playback />
  </>;
}

export function Experiments({ activeRun, ids = raftExperiments, renderFindings, swimlane }: {
  activeRun?: string;
  ids?: readonly ExperimentId[];
  renderFindings?: (run: RunDetail) => ReactNode;
  swimlane?: boolean;
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

  const visible = useMemo(() => runs
    .filter(item => ids.includes(item.experimentId) && (!category || item.experimentId === category))
    .toSorted((left, right) => {
      const order = ids.indexOf(left.experimentId) - ids.indexOf(right.experimentId);
      return order || Date.parse(right.startedAt) - Date.parse(left.startedAt);
    }), [runs, ids, category]);
  const latest = visible.reduce<RunSummary | undefined>((newest, item) =>
    !newest || Date.parse(item.startedAt) > Date.parse(newest.startedAt) ? item : newest, undefined);
  const chosen = visible.find(item => item.runId === (selection || activeRun)) ?? latest;
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

  const loading = Boolean(runId && !error && (!run || run.result.runId !== runId));
  return <>
    <section className="panel activity">
      <div className="filters">
        <label>实验<Select label="实验" value={category}
          options={[{ value: '', label: '全部' }, ...ids.map(id => ({ value: id, label: `${id} · ${experimentNames[id]}` }))]}
          onChange={value => { setCategory(value); select(''); }} /></label>
        <label>运行<Select label="运行" value={runId ?? ''}
          options={visible.length
            ? visible.map(item => ({ value: item.runId, label: `${item.experimentId} · ${item.runId} · ${item.status}` }))
            : [{ value: '', label: '暂无记录' }]}
          onChange={select} /></label>
      </div>
    </section>
    <div className="experiment-stage" aria-busy={loading}>
      {run
        ? <Playback key={run.result.runId} run={run} findings={renderFindings?.(run)} swimlane={swimlane} />
        : <div className="experiment-placeholder">
            {!runId && <p className="muted">暂无运行记录</p>}
          </div>}
      {loading && <div className="experiment-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>读取 Evidence 中…</span>
      </div>}
      {error && <div className="experiment-loading experiment-error" role="alert">
        <span>{error}</span>
      </div>}
    </div>
  </>;
}
