/** Checks coverage after each atomic commit in a declared on-call interval. */
import type { TransactionHistory, TransactionRead } from '../contracts/transaction.ts';
import { indexHistory } from './versions.ts';
import type { Version } from './versions.ts';

type OnCallViolation = {
  txnId: string;
  commitSeq: number;
  required: 1;
  actual: 0;
  observed: { key: string; version: Version | null }[];
  related: { txnId: string; reads: TransactionRead[] }[];
};

export type InvariantResult =
  | { status: 'PASS'; checked: number }
  | { status: 'FAIL'; checked: number; violation: OnCallViolation }
  | { status: 'INCONCLUSIVE'; reason: string };

export function checkOnCall(
  history: readonly TransactionHistory[], keys: readonly string[], fromCommitSeq: number, throughCommitSeq?: number,
): InvariantResult {
  const index = indexHistory(history);
  if ('reason' in index) return { status: 'INCONCLUSIVE', reason: index.reason };
  const { commits, writes } = index;
  const through = throughCommitSeq ?? commits.length;
  if (!keys.length || new Set(keys).size !== keys.length || !Number.isSafeInteger(fromCommitSeq)
    || !Number.isSafeInteger(through) || fromCommitSeq < 1 || through > commits.length || through < fromCommitSeq) {
    return { status: 'INCONCLUSIVE', reason: 'Missing coverage interval or keys' };
  }
  const heads = new Map<string, Version | null>(keys.map(key => [key, null]));
  let checked = 0;
  for (const txn of commits.slice(0, through)) {
    for (const version of writes.get(txn.txnId)!) {
      if (heads.has(version.key)) heads.set(version.key, version);
    }
    if (txn.commitSeq < fromCommitSeq) continue;
    const observed = [...heads].map(([key, version]) => ({ key, version }));
    const values = observed.map(({ version }) => version?.data.tombstone === false ? version.data.value : false);
    if (values.some(value => typeof value !== 'boolean')) {
      return { status: 'INCONCLUSIVE', reason: `Non-boolean coverage at commit ${txn.commitSeq}` };
    }
    checked++;
    if (values.some(value => value === true)) continue;

    const ids = new Set([txn.txnId, ...observed.flatMap(({ version }) => version ? [version.txnId] : [])]);
    const related = commits.filter(item => ids.has(item.txnId)).map(item => ({
      txnId: item.txnId,
      reads: item.accesses.filter((access): access is TransactionRead => access.kind === 'read' && heads.has(access.key)),
    }));
    return {
      status: 'FAIL', checked,
      violation: { txnId: txn.txnId, commitSeq: txn.commitSeq, required: 1, actual: 0, observed, related },
    };
  }
  return { status: 'PASS', checked };
}
