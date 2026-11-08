/**
 * Builds direct WW/WR/RW dependencies from committed versions and read
 * evidence, then searches for a serialization cycle. Invalid or incomplete
 * evidence produces INCONCLUSIVE; a detected cycle produces FAIL.
 */
import type { TransactionHistory, TransactionWrite, VersionData } from '../contracts/transaction.ts';
import { indexHistory, versionAt } from './versions.ts';

type Connection = { from: string; to: string; key: string };
/** WW: prior→next writer; WR: observed writer→reader; RW: reader→next writer. */
export type DependencyEdge = Connection & (
  | { kind: 'WW'; priorVersionId: string; nextVersionId: string }
  | { kind: 'WR'; observedVersionId: string; accessIndex: number }
  | { kind: 'RW'; observedVersionId: string | null; nextVersionId: string; accessIndex: number }
);
export type DependencyResult =
  | { status: 'PASS' | 'FAIL'; nodes: string[]; edges: DependencyEdge[]; cycle: DependencyEdge[] }
  | { status: 'INCONCLUSIVE'; reason: string };

/** 有向图 DFS；返回形成回边的环，空数组表示无环。 */
export function findCycle(nodes: readonly string[], edges: readonly DependencyEdge[]): DependencyEdge[] {
  const outgoing = new Map(nodes.map(id => [id, [] as DependencyEdge[]]));
  for (const edge of edges) outgoing.get(edge.from)!.push(edge);
  const active = new Set<string>();
  const done = new Set<string>();
  const parent = new Map<string, DependencyEdge>();

  for (const root of nodes) {
    if (done.has(root)) continue;
    const stack = [{ id: root, offset: 0 }];
    active.add(root);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const edge = outgoing.get(frame.id)![frame.offset++];
      if (!edge) {
        stack.pop();
        active.delete(frame.id);
        done.add(frame.id);
      } else if (active.has(edge.to)) {
        const cycle = [edge];
        for (let id = edge.from; id !== edge.to;) {
          const step = parent.get(id)!;
          cycle.push(step);
          id = step.from;
        }
        return cycle.reverse();
      } else if (!done.has(edge.to)) {
        parent.set(edge.to, edge);
        active.add(edge.to);
        stack.push({ id: edge.to, offset: 0 });
      }
    }
  }
  return [];
}

export function buildDependencyGraph(history: readonly TransactionHistory[]): DependencyResult {
  const index = indexHistory(history);
  if ('reason' in index) return { status: 'INCONCLUSIVE', reason: index.reason };
  const { commits, chains } = index;
  // 提交版本链的相邻写产生 WW；链本身已按 commitSeq 排序。
  const edges: DependencyEdge[] = [];
  for (const [key, chain] of chains) {
    for (let i = 1; i < chain.length; i++) {
      const before = chain[i - 1];
      const after = chain[i];
      edges.push({ kind: 'WW', from: before.txnId, to: after.txnId, key, priorVersionId: before.id, nextVersionId: after.id });
    }
  }
  for (const txn of commits) {
    const { txnId, isolation, snapshotSeq, commitSeq, accesses } = txn;
    // 读视图必须早于本事务提交；SI 还必须等于 begin 时固定的快照。
    const validView = (seq: number) => Number.isSafeInteger(seq) && seq >= 0 && seq < commitSeq;
    if (!(isolation === 'SI' && snapshotSeq !== null && validView(snapshotSeq)
      || isolation === 'RC' && snapshotSeq === null)) {
      return { status: 'INCONCLUSIVE', reason: `Missing isolation evidence: ${txnId}` };
    }
    let lastView = 0;
    const privateWrites = new Map<string, TransactionWrite>();
    for (const [accessIndex, access] of accesses.entries()) {
      if (access.kind === 'write') { privateWrites.set(access.key, access); continue; }
      const { key, viewSeq, source, observedVersionId, result } = access;
      if (!key || !validView(viewSeq) || viewSeq < lastView || (snapshotSeq !== null && viewSeq !== snapshotSeq)) {
        return { status: 'INCONCLUSIVE', reason: `Invalid read view: ${txnId}[${accessIndex}]` };
      }
      lastView = viewSeq;
      const own = privateWrites.get(key);
      const chain = chains.get(key) ?? [];
      const position = versionAt(chain, viewSeq);
      const prior = chain[position];
      const data: VersionData | undefined = own?.data ?? prior?.data;
      const found = data?.tombstone === false;
      // 来源、版本 ID 和值必须与记录一致，否则不能据此建立依赖边。
      if (source !== (own ? 'own' : prior ? 'committed' : 'absent')
        || observedVersionId !== (own?.createdVersionId ?? prior?.id ?? null)
        || result?.found !== found || (found && (!result.found || result.value !== data.value))) {
        return { status: 'INCONCLUSIVE', reason: `Unverifiable read version: ${txnId}[${accessIndex}]` };
      }
      if (own) continue;
      // 读观察到的前驱写形成 WR；该键此时的下一个写形成 RW，跳过本事务自己的后续写。
      if (prior) edges.push({ kind: 'WR', from: prior.txnId, to: txnId, key, observedVersionId: prior.id, accessIndex });
      const next = chain[position + 1];
      if (next && next.txnId !== txnId) {
        edges.push({ kind: 'RW', from: txnId, to: next.txnId, key, observedVersionId, nextVersionId: next.id, accessIndex });
      }
    }
  }
  const nodes = commits.map(txn => txn.txnId);
  const cycle = findCycle(nodes, edges);
  return { status: cycle.length ? 'FAIL' : 'PASS', nodes, edges, cycle };
}
