/** Presents verifier verdicts and provenance from completed Evidence runs. */
import { verificationExperiments } from '../../src/contracts/console.ts';
import type { RunDetail } from '../../src/contracts/console.ts';
import { Icon } from './icons.tsx';
import { Experiments } from './timeline.tsx';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const label = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '—';

function VerificationFacts({ value }: { value: Record<string, unknown> }) {
  const edges = list(value.edges);
  const cycle = list(value.cycle);
  const witnesses = list(value.witnesses);
  const failure = object(value.counterexample);
  const violation = object(value.violation);
  return <>
    {witnesses.map((witness, index) => <p key={index}><strong>合法顺序</strong> · {label(witness.key)} · {
      Array.isArray(witness.order) ? witness.order.map(label).join(' → ') : '—'}</p>)}
    {failure.key !== undefined && <>
      <p><strong>反例键</strong> · {label(failure.key)}</p>
      {list(failure.mismatches).map((mismatch, index) => <p key={index}>
        调用 {label(mismatch.operationId)} · 期望 <code>{JSON.stringify(mismatch.expected)}</code> · 实际 <code>{JSON.stringify(mismatch.observed)}</code>
      </p>)}
    </>}
    {Array.isArray(value.cycle) && <p><strong>{cycle.length ? '依赖环' : '无环'}</strong>
      {cycle.length > 0 && ' · ' + [label(cycle[0].from), ...cycle.map(edge => label(edge.to))].join(' → ')}
    </p>}
    {edges.length > 0 && <div className="table-scroll">
      <table className="data-table">
        <caption>事务依赖图 · 有向边</caption>
        <thead><tr><th>起点</th><th>类型</th><th>终点</th><th>键</th><th>版本</th></tr></thead>
        <tbody>{edges.map((edge, index) => {
          const inCycle = cycle.some(step => step.from === edge.from && step.to === edge.to
            && step.kind === edge.kind && step.key === edge.key);
          return <tr key={index} className={inCycle ? 'selected-row' : ''}>
            <td>{label(edge.from)}</td><td>{label(edge.kind)}{inCycle && ' · 环内'}</td>
            <td>{label(edge.to)}</td><td>{label(edge.key)}</td>
            <td>{[edge.priorVersionId ?? edge.observedVersionId, edge.nextVersionId].filter(Boolean).map(label).join(' → ') || '—'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {violation.txnId !== undefined && <p><strong>{label(violation.txnId)}</strong> · 提交序号 {label(violation.commitSeq)}
      {' · '}实际在岗 {label(violation.actual)} 人 · 最少 {label(violation.required)} 人</p>}
    {typeof value.checked === 'number' && <p className="muted">已检查 {value.checked} 个提交点</p>}
  </>;
}

function Findings({ run }: { run: RunDetail }) {
  const sources = run.events.filter(event => event.kind === 'source').flatMap(event => {
    const { id, runId } = object(object(event.raw).details);
    return (id === 'R03' || id === 'T02') && typeof runId === 'string' ? [{ id, runId }] : [];
  });
  return <section className="panel run-summary verification-findings">
    <h2>检查结果</h2>
    <p className="muted">运行判定描述实验断言。各检查卡片显示验证器对该输入历史的判定。</p>
    {sources.map(({ id, runId }) => <div key={id + '/' + runId}>
      <p>来源 {id} · <code>{runId}</code></p>
      <div className="evidence-links">
        <a href={(id === 'R03' ? '#/runs' : '#/transaction') + '?run=' + encodeURIComponent(runId)}>回放来源运行</a>
        <a href={'/api/runs/' + id + '/' + encodeURIComponent(runId) + '/files/events.jsonl'} target="_blank" rel="noreferrer">操作历史原文</a>
        <a href={'/api/runs/' + id + '/' + encodeURIComponent(runId) + '/files/result.json'} target="_blank" rel="noreferrer">来源运行判定</a>
      </div>
    </div>)}
    {run.result.assertionResults.map((assertion, index) => {
      const value = object(assertion.details);
      const verdict = value.status === 'PASS' || value.status === 'FAIL' || value.status === 'INCONCLUSIVE' ? value.status : undefined;
      return <article className="verification-check" key={index}>
        <div className="activity-heading">
          <h3>{assertion.name}</h3>
          {verdict && <span className={'badge verdict-' + verdict.toLowerCase()}>{verdict}</span>}
        </div>
        <VerificationFacts value={value} />
        <details><summary>检查详情 · 断言{assertion.passed ? '通过' : '失败'}</summary><pre>{JSON.stringify(assertion.details, null, 2)}</pre></details>
      </article>;
    })}
  </section>;
}

export function VerificationPage() {
  return <main aria-labelledby="verification-heading">
    <header className="overview-banner">
      <span className="overview-icon"><Icon name="detail" /></span>
      <div><h1 id="verification-heading">Verification</h1><p>线性一致性、事务依赖图与业务不变量</p></div>
    </header>
    <Experiments ids={verificationExperiments} renderFindings={run => <Findings run={run} />} />
  </main>;
}
