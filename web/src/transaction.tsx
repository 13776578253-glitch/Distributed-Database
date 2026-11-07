/** Displays transaction service observations and replays recorded transaction experiments. */
import { useContext, useEffect, useState } from 'react';
import { transactionExperiments } from '../../src/contracts/console.ts';
import type { TransactionReadResult } from '../../src/contracts/transaction.ts';
import { getJson, usePolling } from './console-api.ts';
import { Icon } from './icons.tsx';
import { PreferencesContext } from './preferences.tsx';
import { Experiments } from './timeline.tsx';

interface Status {
  commitSeq: number;
  active: string[];
  pending: number;
  committed: number;
  appliedLsn: number;
  lastLsn: number;
}
interface WalRecord {
  lsn: number;
  prevLsn: number | null;
  type: string;
  txnId?: string;
  key?: string;
  versionId?: string;
  undoneLsn?: number;
  undoNextLsn?: number | null;
}
interface Recovery {
  checkpointLsn: number | null;
  analysisStartLsn: number;
  redoStartLsn: number;
  redoLsns: number[];
  undoneLsns: number[];
  winners: string[];
  losers: string[];
}
const api = '/api/transaction';

function AsOf() {
  const [result, setResult] = useState<{ key: string; lsn: string; value: TransactionReadResult }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return <section className="panel run-summary">
    <div className="activity-heading"><div><h2>MVCC 历史读取</h2><p className="muted">按 WAL LSN 查询指定键当时的已提交可见值。</p></div></div>
    <form className="filters inline-filters" onSubmit={async event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const key = String(fields.get('key'));
      const lsn = String(fields.get('lsn'));
      setBusy(true);
      setResult(undefined);
      setError('');
      try {
        const value = await getJson<TransactionReadResult>(api + '/as-of?' + new URLSearchParams({ key, lsn }), AbortSignal.timeout(4000));
        setResult({ key, lsn, value });
      } catch (failure) { setError((failure as Error).message); }
      finally { setBusy(false); }
    }}>
      <label>键<input name="key" required maxLength={1024} /></label>
      <label>LSN<input name="lsn" type="number" min="0" step="1" required /></label>
      <button className="action" type="submit" disabled={busy}>{busy ? '查询中…' : '查询'}</button>
    </form>
    {error && <p className="warning" role="alert">{error}</p>}
    {result && <div role="status"><p>{result.key} · LSN {result.lsn} · {result.value.found ? '存在可见版本' : '无可见值'}</p>
      <pre>{JSON.stringify(result.value, null, 2)}</pre></div>}
  </section>;
}

function Storage() {
  const [sample, setSample] = useState<{ wal: WalRecord[]; recovery: Recovery }>();
  const [revision, refresh] = useState(0);
  const [error, setError] = useState('');
  const [key, setKey] = useState('');
  const [selected, select] = useState<number>();
  useEffect(() => {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(4000)]);
    setError('');
    Promise.all([getJson<WalRecord[]>(api + '/wal', signal), getJson<Recovery>(api + '/recovery', signal)])
      .then(([wal, recovery]) => {
        if (!stop.signal.aborted) setSample({ wal, recovery });
      }).catch((failure: Error) => {
        if (!stop.signal.aborted) { setError(failure.message); setSample(undefined); }
      });
    return () => stop.abort();
  }, [revision]);
  const recovery = sample?.recovery;
  const records = sample?.wal.filter(record => !key || record.key?.includes(key)) ?? [];
  const visible = records.slice(-150).reverse();
  const record = visible.find(record => record.lsn === selected) ?? visible[0];
  const checkpoint = sample?.wal.findLast(record => record.type === 'CHECKPOINT');

  return <>
    <section className="panel run-summary">
      <div className="activity-heading">
        <div><h2>最近启动恢复</h2><p className="muted">分析、重做和撤销来自事务服务本次启动的恢复报告。</p></div>
        <button type="button" className="action" onClick={() => refresh(revision + 1)}>刷新 WAL 与恢复报告</button>
      </div>
      {error && <p className="warning" role="alert">{error}</p>}
      {recovery ? <>
        <dl className="service-facts">
          <div><dt>分析起点 LSN</dt><dd>{recovery.analysisStartLsn}</dd></div>
          <div><dt>重做起点 LSN</dt><dd>{recovery.redoStartLsn}</dd></div>
          <div><dt>重做记录</dt><dd>{recovery.redoLsns.join('、') || '无'}</dd></div>
          <div><dt>撤销记录</dt><dd>{recovery.undoneLsns.join('、') || '无'}</dd></div>
          <div><dt>恢复依据 Checkpoint</dt><dd>{recovery.checkpointLsn ?? '无'}</dd></div>
          <div><dt>WAL 最新 Checkpoint</dt><dd>{checkpoint?.lsn ?? '无'}</dd></div>
        </dl>
        <details><summary>恢复报告原文</summary><pre>{JSON.stringify(recovery, null, 2)}</pre></details>
      </> : !error && <p className="muted" role="status">正在读取恢复报告…</p>}
    </section>
    <section className="panel activity">
      <div className="filters">
        <h2>WAL 记录</h2>
        <label>按键筛选版本写入<input value={key} onChange={event => { setKey(event.target.value); select(undefined); }} /></label>
        <span className="muted">{sample ? '显示 ' + visible.length + ' / ' + records.length + ' 条' : '等待 WAL'}</span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>LSN</th><th>类型</th><th>事务</th><th>前序 LSN</th><th>键 / 版本</th><th>撤销链</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.lsn} className={record?.lsn === row.lsn ? 'selected-row' : ''}>
            <td><button type="button" className="row-action" aria-pressed={record?.lsn === row.lsn}
              onClick={() => select(row.lsn)}>{row.lsn}</button></td>
            <td>{row.type}</td><td>{row.txnId ?? '—'}</td><td>{row.prevLsn ?? '—'}</td>
            <td>{[row.key, row.versionId].filter(Boolean).join(' / ') || '—'}</td>
            <td>{row.undoneLsn === undefined ? '—' : row.undoneLsn + ' → ' + (row.undoNextLsn ?? '结束')}</td>
          </tr>)}</tbody>
        </table>
        {sample && !visible.length && <p className="empty-state">当前筛选下没有 WAL 记录</p>}
      </div>
      {record && <details className="raw-event" open><summary>原始记录 · LSN {record.lsn}</summary>
        <pre>{JSON.stringify(record, null, 2)}</pre></details>}
    </section>
  </>;
}

export function TransactionPage({ activeRun }: { activeRun?: string }) {
  const { interval } = useContext(PreferencesContext);
  const [revision, refresh] = useState(0);
  const { data, error } = usePolling<Status>(api + '/status', interval, revision);
  return <main aria-labelledby="transaction-heading">
    <header className="overview-banner">
      <span className="overview-icon"><Icon name="detail" /></span>
      <div><h1 id="transaction-heading">Transaction</h1><p>独立事务服务 · MVCC、WAL 与恢复</p></div>
      {!interval && <button type="button" className="action" onClick={() => refresh(revision + 1)}>刷新状态</button>}
    </header>
    {error ? <p className="warning" role="status">{error}。下方可回放已完成的事务实验。</p>
      : data ? <>
        <section className="panel run-summary">
          <h2>事务状态</h2>
          <dl className="service-facts">
            <div><dt>提交序号</dt><dd>{data.commitSeq}</dd></div>
            <div><dt>活动事务</dt><dd>{data.active.join('、') || '无'}</dd></div>
            <div><dt>版本（已提交 / 待提交）</dt><dd>{data.committed} / {data.pending}</dd></div>
            <div><dt>LSN（已应用 / WAL 末尾）</dt><dd>{data.appliedLsn} / {data.lastLsn}</dd></div>
          </dl>
        </section>
        <AsOf />
        <Storage />
      </> : <p className="muted" role="status">正在读取事务服务状态…</p>}
    <section className="panel run-summary"><h2>事务实验回放</h2><p className="muted">隔离级别、写偏斜和故障恢复的历史 Evidence。</p></section>
    <Experiments key={activeRun} activeRun={activeRun} ids={transactionExperiments} />
  </main>;
}
