/** Shared MVCC identities and transaction histories. */
import type { OperationResult, Scalar } from './history.ts';

export type TransactionId = string;
export type VersionId = string;
/** 事务提交序号，由引擎单调分配。 */
export type CommitSeq = number;
export type IsolationLevel = 'RC' | 'SI';

/** 提交版本保存 JSON 标量或删除墓碑；墓碑在读取时表现为 found:false。 */
export type VersionData = Readonly<{ tombstone: true } | { tombstone: false; value: Scalar }>;
/** found:false 同时表示键缺失、最后一次可见写是墓碑，或本事务已删除。 */
export type TransactionReadResult = Readonly<Extract<OperationResult, { found: boolean }>>;

/** 一次读的可见边界固定为 viewSeq；own 写优先于已提交版本链。 */
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

/**
 * 事务完整观测记录。SI 在 begin 时固定 snapshotSeq；RC 为 null，读时使用
 * 当前 commitSeq。accesses 按调用顺序保留读和每次写尝试。
 */
export type TransactionTrace = Readonly<{
  txnId: TransactionId;
  isolation: IsolationLevel;
  snapshotSeq: CommitSeq | null;
  lock?: string;
  accesses: readonly TransactionAccess[];
}>;

/** 只有提交事务拥有 commitSeq；中止事务不发布版本。 */
export type CommittedTransaction = TransactionTrace & Readonly<{ status: 'committed'; commitSeq: CommitSeq }>;
export type AbortedTransaction = TransactionTrace & Readonly<{ status: 'aborted' }>;
export type TransactionHistory = CommittedTransaction | AbortedTransaction;
