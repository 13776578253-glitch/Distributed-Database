/** Indexes a complete committed transaction prefix and its final per-key versions. */
import type { CommittedTransaction, TransactionHistory, VersionData } from '../contracts/transaction.ts';
import { isScalar } from '../contracts/history.ts';

export type Version = { id: string; txnId: string; key: string; commitSeq: number; data: VersionData };
type IndexedHistory = { commits: CommittedTransaction[]; chains: Map<string, Version[]>; writes: Map<string, Version[]> };

export function indexHistory(history: readonly TransactionHistory[]): IndexedHistory | { reason: string } {
  const ids = new Set<string>();
  const versionIds = new Set<string>();
  const commits: CommittedTransaction[] = [];
  const writes = new Map<string, Version[]>();
  const chains = new Map<string, Version[]>();

  for (const txn of history) {
    if (!txn?.txnId || ids.has(txn.txnId) || (txn.status !== 'committed' && txn.status !== 'aborted')
      || !Array.isArray(txn.accesses)) return { reason: `Invalid transaction boundary: ${txn?.txnId}` };
    ids.add(txn.txnId);
    const final = new Map<string, Version>();
    for (const access of txn.accesses) {
      if (access?.kind === 'read') continue;
      if (access?.kind !== 'write' || !access.key || !access.createdVersionId || versionIds.has(access.createdVersionId)
        || !(access.data?.tombstone === true || (access.data?.tombstone === false && isScalar(access.data.value)))) {
        return { reason: `Invalid write evidence: ${txn.txnId}` };
      }
      versionIds.add(access.createdVersionId);
      if (txn.status === 'committed') {
        final.set(access.key, {
          id: access.createdVersionId, key: access.key, txnId: txn.txnId, commitSeq: txn.commitSeq, data: access.data,
        });
      }
    }
    if (txn.status === 'committed') {
      commits.push(txn);
      writes.set(txn.txnId, [...final.values()]);
    }
  }

  commits.sort((left, right) => left.commitSeq - right.commitSeq);
  for (const [i, txn] of commits.entries()) {
    if (txn.commitSeq !== i + 1) return { reason: `Missing or duplicate commit sequence at ${i + 1}` };
    for (const version of writes.get(txn.txnId)!) {
      const chain = chains.get(version.key) ?? [];
      chain.push(version);
      chains.set(version.key, chain);
    }
  }
  return { commits, chains, writes };
}

/** 返回指定视图最后一个已提交版本的位置，-1 表示初始缺失。 */
export function versionAt(chain: readonly Version[], viewSeq: number): number {
  let start = 0;
  let end = chain.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (chain[middle].commitSeq <= viewSeq) start = middle + 1;
    else end = middle;
  }
  return start - 1;
}
