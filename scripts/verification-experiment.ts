/** Replays immutable Raft and transaction evidence and writes fresh V01–V03 runs. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientHistory, ExperimentResult } from '../src/contracts/history.ts';
import type { TransactionHistory } from '../src/contracts/transaction.ts';
import { buildDependencyGraph, findCycle } from '../src/verification/dependency-graph.ts';
import { checkOnCall } from '../src/verification/invariants.ts';
import { checkLinearizable } from '../src/verification/linearizability.ts';
import { openEvidence } from './evidence.ts';
import { mixedCycleFixture, registerFixture } from './verification-fixtures.ts';

type Evidence = ReturnType<typeof openEvidence>;
type InputEvent = { kind: string; details: unknown };
type RaftEvent = Omit<ClientHistory, 'outcome'> & { outcome?: ClientHistory['outcome']; consistency?: string };
type TransactionEvent = TransactionHistory & { project: string };
type HttpCall = { project: string; path: string; invocationNs: string };
type HttpResponse = HttpCall & { responseNs: string; status: number; result: { txnId?: string; history?: TransactionHistory } };

class EvidenceGap extends Error {}
function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new EvidenceGap(reason);
}

function loadRun(id: 'R03' | 'T02', runId: string, evidence: Evidence) {
  requireEvidence(/^\d{4}-[\dTZ.-]+--[a-f0-9]{8}$/.test(runId), 'Invalid source run ID');
  const directory = join('evidence', id, runId);
  const read = (filename: string) => {
    try { return readFileSync(join(directory, filename), 'utf8'); }
    catch { throw new EvidenceGap(`Cannot read ${directory}/${filename}`); }
  };
  const raw = read('events.jsonl');
  const resultText = read('result.json');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  evidence.event('source', {
    id, runId, directory, files: { 'events.jsonl': hash(raw), 'result.json': hash(resultText) },
  });
  try {
    const result = JSON.parse(resultText) as ExperimentResult;
    requireEvidence(result?.experimentId === id && result.runId === runId
      && Array.isArray(result.assertionResults), 'Source identity or result shape mismatch');
    const events = raw.trimEnd().split('\n').map(line => JSON.parse(line) as InputEvent);
    return { result, events };
  } catch (error) {
    if (error instanceof SyntaxError) throw new EvidenceGap(`Malformed source JSON in ${directory}`);
    throw error;
  }
}

function raftHistory(runId: string, evidence: Evidence): ClientHistory[] {
  const { events, result } = loadRun('R03', runId, evidence);
  const invokes = new Map<string, RaftEvent>();
  const returns = new Map<string, ClientHistory>();
  for (const { kind, details } of events) {
    if (kind !== 'client.invoke' && kind !== 'client.return') continue;
    const call = details as RaftEvent;
    requireEvidence(call?.runId === runId && call.engine === 'raft' && call.operationId && call.clientId
      && call.operation?.key === `R03/${runId}` && call.consistency !== 'stale', 'Unexpected R03 operation');
    if (kind === 'client.invoke') {
      requireEvidence(!invokes.has(call.operationId), 'Duplicate R03 invocation');
      invokes.set(call.operationId, call);
      continue;
    }
    const original = invokes.get(call.operationId);
    requireEvidence(original && !returns.has(call.operationId) && original.invocationNs === call.invocationNs
      && original.clientId === call.clientId && JSON.stringify(original.operation) === JSON.stringify(call.operation)
      && call.outcome && call.responseNs, 'Unpaired or contradictory R03 return');
    const ambiguous = call.errorCode === 'UNKNOWN_OUTCOME' || call.errorCode === 'TIMEOUT';
    returns.set(call.operationId, { ...call, outcome: ambiguous ? 'unknown' : call.outcome });
  }
  const capture = result.assertionResults.find(item => item.name === 'six invocations and returns captured');
  requireEvidence(capture?.passed && (capture.details as { operations: number }).operations === invokes.size
    && invokes.size > 0 && invokes.size === returns.size, 'Incomplete R03 capture');
  return [...returns.values()];
}

function transactionHistory(runId: string, evidence: Evidence) {
  const { events, result } = loadRun('T02', runId, evidence);
  requireEvidence(result.status === 'PASS', 'T02 source did not complete');
  const reported = events.filter(event => event.kind === 'txn-history').map(event => event.details as TransactionEvent);
  const invokes = events.filter(event => event.kind === 'http-invocation').map(event => event.details as HttpCall);
  const responses = events.filter(event => event.kind === 'http-response').map(event => event.details as HttpResponse);
  const project = reported[0]?.project;
  requireEvidence(project && reported.every(trace => trace.project === project)
    && responses.every(reply => reply.project === project), 'Mixed or missing T02 project');
  const pending = new Map(invokes.map(call => [call.invocationNs, call]));
  requireEvidence(pending.size === invokes.length && invokes.length === responses.length, 'Incomplete T02 HTTP history');
  for (const reply of responses) {
    const call = pending.get(reply.invocationNs);
    requireEvidence(call?.path === reply.path && call.project === project
      && /^\d+$/.test(reply.invocationNs) && /^\d+$/.test(reply.responseNs)
      && BigInt(reply.invocationNs) <= BigInt(reply.responseNs), 'Unpaired T02 HTTP response');
    pending.delete(reply.invocationNs);
  }
  const begun = responses.filter(reply => reply.status === 200 && reply.path === '/txn/begin').map(reply => reply.result.txnId);
  const terminal = responses.filter(reply => reply.status === 200 && /^\/txn\/txn-\d+\/(commit|abort)$/.test(reply.path))
    .map(reply => {
      const history = reply.result.history;
      requireEvidence(history && reply.path === `/txn/${history.txnId}/${history.status === 'committed' ? 'commit' : 'abort'}`,
        'Unpaired T02 terminal reply');
      return history;
    });
  requireEvidence(new Set(begun).size === begun.length && new Set(terminal.map(trace => trace.txnId)).size === terminal.length
    && begun.length === terminal.length && terminal.every(trace => begun.includes(trace.txnId)), 'Incomplete T02 transaction boundaries');
  const commits = terminal.filter(trace => trace.status === 'committed');
  requireEvidence(commits.length === reported.length && commits.every((trace, index) => {
    const { project: _, ...captured } = reported[index];
    return JSON.stringify(captured) === JSON.stringify(trace);
  }), 'T02 transaction history differs from HTTP replies');
  const guardStart = commits.find(trace => trace.lock === 'on-call')?.snapshotSeq;
  requireEvidence(typeof guardStart === 'number' && guardStart > 1 && guardStart < commits.length, 'Missing T02 phase boundary');
  return { terminal, guardStart, commits };
}

function v01(evidence: Evidence, r03: string) {
  const history = raftHistory(r03, evidence);
  const positive = registerFixture(false);
  const negative = registerFixture(true);
  evidence.event('fixtures', { positive, negative });
  const options = { initial: new Map() };
  const pass = checkLinearizable(positive, options);
  const fail = checkLinearizable(negative, options);
  const replay = checkLinearizable(history, options);
  evidence.assert('overlapping writes admit a legal order', pass.status === 'PASS', pass);
  evidence.assert('two completed reads cannot observe different values without another write',
    fail.status === 'FAIL' && fail.counterexample.mismatches.some(item => item.operationId === 'read-second'), fail);
  if (replay.status === 'INCONCLUSIVE') throw new EvidenceGap(replay.reason);
  evidence.assert('R03 has a legal order', replay.status === 'PASS', replay);
  evidence.log(`R03 ${r03}: ${JSON.stringify(replay)}`);
}

function v02(evidence: Evidence, t02: string) {
  const { terminal, guardStart, commits } = transactionHistory(t02, evidence);
  evidence.event('fixture', mixedCycleFixture);
  const fixture = buildDependencyGraph(mixedCycleFixture);
  evidence.assert('injected cycle identifies WW, WR and RW edges', fixture.status === 'FAIL'
    && new Set(fixture.cycle.map(edge => edge.kind)).size === 3, fixture);
  const skew = buildDependencyGraph(terminal.filter(trace => trace.status === 'aborted' || trace.commitSeq < guardStart));
  const full = buildDependencyGraph(terminal);
  if (skew.status === 'INCONCLUSIVE') throw new EvidenceGap(skew.reason);
  if (full.status === 'INCONCLUSIVE') throw new EvidenceGap(full.reason);
  evidence.assert('T02 unlocked schedule has two version-backed antidependencies', skew.status === 'FAIL'
    && skew.cycle.length === 2 && skew.cycle.every(edge => edge.kind === 'RW'), skew);
  const guarded = new Set(commits.filter(trace => trace.commitSeq >= guardStart).map(trace => trace.txnId));
  const guardedEdges = full.edges.filter(edge => guarded.has(edge.from) && guarded.has(edge.to));
  const cycle = findCycle([...guarded], guardedEdges);
  evidence.assert('T02 guarded subgraph is acyclic', cycle.length === 0, { nodes: [...guarded], edges: guardedEdges, cycle });
  evidence.log(`T02 ${t02} serialization cycle: ${JSON.stringify(skew.cycle)}`);
}

function v03(evidence: Evidence, t02: string) {
  const { terminal, guardStart } = transactionHistory(t02, evidence);
  const keys = ['alice', 'bob'];
  const unlocked = checkOnCall(terminal, keys, 1, guardStart - 1);
  const guarded = checkOnCall(terminal, keys, guardStart);
  if (unlocked.status === 'INCONCLUSIVE') throw new EvidenceGap(unlocked.reason);
  if (guarded.status === 'INCONCLUSIVE') throw new EvidenceGap(guarded.reason);
  evidence.assert('unlocked T02 violates on-call coverage', unlocked.status === 'FAIL'
    && unlocked.violation.actual === 0 && unlocked.violation.related.length === 2, unlocked);
  evidence.assert('guarded T02 preserves on-call coverage at every checked commit', guarded.status === 'PASS', guarded);
  evidence.log(`T02 ${t02} coverage: ${JSON.stringify({ unlocked, guarded })}`);
}

const [selection = 'all', r03 = '2026-11-07T12-03-08.334Z--8c1d3503', t02 = '2026-11-07T13-41-40.891Z--561ddfc6'] = process.argv.slice(2);
if (!['all', 'V01', 'V02', 'V03'].includes(selection)) throw new Error('Usage: pnpm verify [all|V01|V02|V03] [R03-run] [T02-run]');
for (const id of ['V01', 'V02', 'V03'] as const) {
  if (selection !== 'all' && selection !== id) continue;
  const evidence = openEvidence(id, `pnpm verify ${id} ${r03} ${t02}`, { r03, t02 });
  let status: ExperimentResult['status'] = 'PASS';
  try {
    if (id === 'V01') v01(evidence, r03);
    if (id === 'V02') v02(evidence, t02);
    if (id === 'V03') v03(evidence, t02);
  } catch (error) {
    status = error instanceof EvidenceGap ? 'INCONCLUSIVE' : 'FAIL';
    evidence.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    evidence.finish(status, { node: process.version, replay: 'offline' });
  }
}
