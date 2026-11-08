/** Controls the observer's continuous demo workload from the Timeline page. */
import { useState } from 'react';
import type { WorkloadStatus } from '../../src/contracts/console.ts';
import { postJson, usePolling } from './console-api.ts';
import { Select } from './select.tsx';

const rates = [1, 2, 5] as const;
type Rate = typeof rates[number];

export function WorkloadPanel() {
  const { data, error } = usePolling<WorkloadStatus>('/api/workload', 1000);
  const [rate, setRate] = useState<Rate>(2);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const running = data?.running === true;
  const paused = data?.paused === true;
  const successRate = data && data.operations > 0
    ? Math.round((data.successes / data.operations) * 100) : undefined;

  async function submit(action: 'start' | 'stop') {
    setBusy(true);
    setMessage('');
    try {
      const status = await postJson<WorkloadStatus>('/api/workload',
        action === 'start' ? { action, rate } : { action });
      setMessage(action === 'start' ? `已开始 · ${status.rate} ops/s` : '已停止，正在清理演示键');
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel run-summary workload-panel">
    <div className="activity-heading">
      <div>
        <h2><span className={`live-dot${running ? ' on' : ''}`} aria-hidden="true" />实时演示负载</h2>
        <p className="muted">仅写入 demo/ 前缀 · 实验期间自动暂停</p>
      </div>
      <div className="workload-controls">
        <label>速率<Select label="演示负载速率" value={rate}
          options={rates.map(value => ({ value, label: `${value} ops/s` }))}
          onChange={setRate} disabled={running || busy} /></label>
        <button type="button" className={`action${running ? '' : ' primary'}`}
          disabled={busy || paused} onClick={() => void submit(running ? 'stop' : 'start')}>
          {busy ? '处理中…' : running ? '停止演示' : paused ? '实验期间暂停' : '开始演示'}
        </button>
      </div>
    </div>
    <dl className="service-facts">
      <div><dt>状态</dt><dd>{running ? (paused ? '已暂停' : '运行中') : paused ? '实验暂停' : data ? '已停止' : '读取中'}</dd></div>
      <div><dt>当前 Leader</dt><dd>{data?.leader ?? '—'}</dd></div>
      <div><dt>操作数</dt><dd>{data?.operations ?? '—'}</dd></div>
      <div><dt>成功率</dt><dd>{successRate === undefined ? '—' : `${successRate}%`}</dd></div>
      <div><dt>未知结果</dt><dd>{data?.unknown ?? 0}</dd></div>
      <div><dt>P50 延迟</dt><dd>{data?.p50LatencyMs === undefined ? '—' : `${data.p50LatencyMs} ms`}</dd></div>
      <div><dt>最近结果</dt>
        <dd className="workload-last" title={data?.lastKey ? `${data.lastKey} · ${data.lastOutcome ?? '—'}` : undefined}>
          {data?.lastKey ? `${data.lastKey} · ${data.lastOutcome ?? '—'}` : '—'}
        </dd></div>
    </dl>
    {message && <p className="muted" role="status">{message}</p>}
    {error && <p className="warning" role="alert">{error}</p>}
  </section>;
}
