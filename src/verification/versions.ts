/**
 * Indexes a complete committed transaction prefix and its final per-key
 * versions. Missing or duplicate evidence returns a reason instead of a
 * partial index, so callers must report INCONCLUSIVE.
 */
import type { CommittedTransaction, TransactionHistory, VersionData } from '../contracts/transaction.ts';
import { isScalar } from '../contracts/history.ts';

/** 已提交版本；commitSeq 唯一决定链位置，id 用于匹配读写观测。 */
export type Version = { id: string; txnId: string; key: string; commitSeq: number; data: VersionData };
/** writes 是每个提交事务每个键的最后一次写；chains 是按 commitSeq 排列的键版本链。 */
type IndexedHistory = { commits: CommittedTransaction[]; chains: Map<string, Version[]>; writes: Map<string, Version[]> };

/**
 * 验证事务边界、写证据和提交序号连续性，再构造版本链。中止事务参与证据
 * 校验但不进入链；空 history 也是合法索引。
 */
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
    // 一个事务可以多次写同一键；只有最后一次写会成为提交版本。
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

  // 提交序号必须从 1 连续递增；缺口或重复都使证据不可判定。
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
