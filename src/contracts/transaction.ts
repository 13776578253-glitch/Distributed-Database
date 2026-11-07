/** Shared MVCC identities and transaction histories for storage and verification. */
import type { OperationResult, Scalar } from './history.ts';

export type TransactionId = string;
export type VersionId = string;
export type CommitSeq = number;
export type IsolationLevel = 'RC' | 'SI';

export type VersionData = Readonly<{ tombstone: true } | { tombstone: false; value: Scalar }>;
export type TransactionReadResult = Readonly<Extract<OperationResult, { found: boolean }>>;

export type TransactionRead = Readonly<{
  kind: 'read';
  key: string;
  viewSeq: CommitSeq;
  source: 'own' | 'committed' | 'absent';
  observedVersionId: VersionId | null;
  result: TransactionReadResult;
}>;

/** 每次写都有更新 ID，提交事务中每个键的最后一条写产生已提交版本。 */
export type TransactionWrite = Readonly<{
  kind: 'write';
  key: string;
  createdVersionId: VersionId;
  data: VersionData;
}>;

export type TransactionAccess = TransactionRead | TransactionWrite;

export type TransactionTrace = Readonly<{
  txnId: TransactionId;
  isolation: IsolationLevel;
  snapshotSeq: CommitSeq | null;
  lock?: string;
  accesses: readonly TransactionAccess[];
}>;

export type CommittedTransaction = TransactionTrace & Readonly<{ status: 'committed'; commitSeq: CommitSeq }>;
export type AbortedTransaction = TransactionTrace & Readonly<{ status: 'aborted' }>;
export type TransactionHistory = CommittedTransaction | AbortedTransaction;
