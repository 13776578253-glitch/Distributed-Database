/** Owns active transactions, isolation checks, lock ownership, and commit order. */
import type { Scalar } from '../../contracts/history.ts';
import type {
  AbortedTransaction, CommitSeq, CommittedTransaction, IsolationLevel, TransactionAccess,
  TransactionId, TransactionReadResult, TransactionTrace, TransactionWrite, VersionData,
} from '../../contracts/transaction.ts';
import { readValue, VersionStore } from './versions.ts';

type ActiveTransaction = {
  trace: TransactionTrace & { accesses: TransactionAccess[] };
  writes: Map<string, TransactionWrite>;
  writeOrdinal: number;
};

export type BeginResult =
  | { ok: true; txnId: TransactionId }
  | { ok: false; error: 'LOCK_CONFLICT' };

export type CommitResult =
  | { ok: true; history: CommittedTransaction }
  | { ok: false; error: 'WRITE_CONFLICT'; key: string; history: AbortedTransaction };

export class TransactionEngine {
  private readonly active = new Map<TransactionId, ActiveTransaction>();
  private readonly locks = new Map<string, TransactionId>();
  private readonly versions = new VersionStore();
  private nextTxnId = 1;
  private commitSeq: CommitSeq = 0;

  /** 可选的具名排他锁在取 SI 快照前申请。争用者用新事务重试。 */
  begin(isolation: IsolationLevel, lock?: string): BeginResult {
    if (lock !== undefined && this.locks.has(lock)) return { ok: false, error: 'LOCK_CONFLICT' };

    const txnId = `txn-${this.nextTxnId++}`;
    if (lock !== undefined) this.locks.set(lock, txnId);
    this.active.set(txnId, {
      trace: {
        txnId, isolation, lock, snapshotSeq: isolation === 'SI' ? this.commitSeq : null,
        accesses: [],
      },
      writes: new Map(),
      writeOrdinal: 0,
    });
    return { ok: true, txnId };
  }

  read(txnId: TransactionId, key: string): TransactionReadResult {
    const txn = this.requireActive(txnId);
    const viewSeq = txn.trace.snapshotSeq ?? this.commitSeq;
    const own = txn.writes.get(key);
    const committed = own ? undefined : this.versions.visible(key, viewSeq);
    const result = readValue(own?.data ?? committed?.data);
    txn.trace.accesses.push({
      kind: 'read', key, viewSeq,
      source: own ? 'own' : committed ? 'committed' : 'absent',
      observedVersionId: own?.createdVersionId ?? committed?.versionId ?? null,
      result: { ...result },
    });
    return result;
  }

  put(txnId: TransactionId, key: string, value: Scalar): void {
    this.write(txnId, key, { tombstone: false, value });
  }

  delete(txnId: TransactionId, key: string): void {
    this.write(txnId, key, { tombstone: true });
  }

  commit(txnId: TransactionId): CommitResult {
    const txn = this.requireActive(txnId);
    const { snapshotSeq } = txn.trace;
    if (snapshotSeq !== null) {
      // 校验全部键后才发布任何版本，避免冲突中止留下部分写入。
      for (const key of txn.writes.keys()) {
        const latest = this.versions.visible(key, this.commitSeq);
        if (latest && latest.commitSeq > snapshotSeq) {
          return { ok: false, error: 'WRITE_CONFLICT', key, history: this.abort(txnId) };
        }
      }
    }

    const commitSeq = ++this.commitSeq;
    for (const write of txn.writes.values()) {
      this.versions.append({
        key: write.key, versionId: write.createdVersionId, creatorTxn: txnId,
        commitSeq, data: { ...write.data },
      });
    }
    return { ok: true, history: { ...this.finish(txn), status: 'committed', commitSeq } };
  }

  abort(txnId: TransactionId): AbortedTransaction {
    return { ...this.finish(this.requireActive(txnId)), status: 'aborted' };
  }

  asOf(key: string, commitSeq: CommitSeq): TransactionReadResult {
    if (!Number.isSafeInteger(commitSeq) || commitSeq < 0 || commitSeq > this.commitSeq) {
      throw new RangeError('INVALID_COMMIT_SEQ');
    }
    return readValue(this.versions.visible(key, commitSeq)?.data);
  }

  private write(txnId: TransactionId, key: string, data: VersionData): void {
    const txn = this.requireActive(txnId);
    const write: TransactionWrite = {
      kind: 'write', key, data, createdVersionId: `${txnId}:${++txn.writeOrdinal}`,
    };
    txn.writes.set(key, write);
    txn.trace.accesses.push(write);
  }

  private requireActive(txnId: TransactionId): ActiveTransaction {
    const txn = this.active.get(txnId);
    if (!txn) throw new Error('TXN_NOT_ACTIVE');
    return txn;
  }

  private finish(txn: ActiveTransaction): TransactionTrace {
    const { txnId, lock } = txn.trace;
    this.active.delete(txnId);
    if (lock !== undefined) this.locks.delete(lock);
    return txn.trace;
  }
}
