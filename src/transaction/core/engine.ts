/** Owns active transaction state, locks, isolation checks, and commit order. */
import type { Scalar } from '../../contracts/history.ts';
import type {
  AbortedTransaction, CommitSeq, CommittedTransaction, IsolationLevel, TransactionAccess,
  TransactionId, TransactionReadResult, TransactionTrace, TransactionWrite, VersionData,
} from '../../contracts/transaction.ts';
import { readValue, VersionStore } from './versions.ts';
import type { CommittedVersion } from './versions.ts';

/** 活动事务；writes 只保留每个键的最后一次写，accesses 保留全部写尝试。 */
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

/** 同步持久化钩子：返回前完成写入；异常由调用方终止进程，恢复处理残留动作。 */
export interface TransactionDurability {
  begin(txnId: TransactionId): void;
  update(txnId: TransactionId, write: TransactionWrite): void;
  commit(txnId: TransactionId, commitSeq: CommitSeq): void;
  abort(txnId: TransactionId): void;
}

/** 恢复后重建引擎所需的事务号、提交水位和已提交版本链。 */
export type RecoveredState = {
  nextTxnId: number;
  commitSeq: CommitSeq;
  versions: readonly CommittedVersion[];
};

/** 活动事务、提交水位与版本链的唯一可变所有者；公开方法同步执行。 */
export class TransactionEngine {
  private readonly active = new Map<TransactionId, ActiveTransaction>();
  /** 具名锁只由 begin 成功的事务持有，abort/commit 通过 finish 释放。 */
  private readonly locks = new Map<string, TransactionId>();
  private readonly versions = new VersionStore();
  private readonly durability?: TransactionDurability;
  private nextTxnId = 1;
  private commitSeq: CommitSeq = 0;

  /** recovered 用于启动时恢复事务号、提交水位和版本链。 */
  constructor(durability?: TransactionDurability, recovered?: RecoveredState) {
    this.durability = durability;
    if (recovered) {
      this.nextTxnId = recovered.nextTxnId;
      this.commitSeq = recovered.commitSeq;
      for (const version of recovered.versions) this.versions.append(version);
    }
  }

  /** 可选的具名排他锁在取 SI 快照前申请。争用者用新事务重试。 */
  begin(isolation: IsolationLevel, lock?: string): BeginResult {
    if (lock !== undefined && this.locks.has(lock)) return { ok: false, error: 'LOCK_CONFLICT' };

    const txnId = `txn-${this.nextTxnId}`;
    this.durability?.begin(txnId);
    this.nextTxnId++;
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

  /** own 写优先；否则读取 viewSeq 前最新已提交版本，并记录本次可见性证据。 */
  read(txnId: TransactionId, key: string): TransactionReadResult {
    const txn = this.requireActive(txnId);
    // SI 固定 begin 时的快照；RC 每次读使用当前提交水位。
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

  /**
   * SI 先检查所有写键是否在快照后被提交，任一冲突则整体中止；RC 不检查。
   * 提交先完成 durability.commit 的同步持久化，再推进内存并发布版本。
   */
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

    const commitSeq = this.commitSeq + 1;
    // 持久化返回后再推进内存，异常时不会发布半个提交。
    this.durability?.commit(txnId, commitSeq);
    this.commitSeq = commitSeq;
    for (const write of txn.writes.values()) {
      this.versions.append({
        key: write.key, versionId: write.createdVersionId, creatorTxn: txnId,
        commitSeq, data: { ...write.data },
      });
    }
    return { ok: true, history: { ...this.finish(txn), status: 'committed', commitSeq } };
  }

  /** 中止先完成 durability.abort，再释放活动状态；不会发布任何版本。 */
  abort(txnId: TransactionId): AbortedTransaction {
    const txn = this.requireActive(txnId);
    this.durability?.abort(txnId);
    return { ...this.finish(txn), status: 'aborted' };
  }

  /** 在 commitSeq 历史水位读取；超出当前水位直接拒绝。 */
  asOf(key: string, commitSeq: CommitSeq): TransactionReadResult {
    if (!Number.isSafeInteger(commitSeq) || commitSeq < 0 || commitSeq > this.commitSeq) {
      throw new RangeError('INVALID_COMMIT_SEQ');
    }
    return readValue(this.versions.visible(key, commitSeq)?.data);
  }

  status() {
    return { commitSeq: this.commitSeq, active: [...this.active.keys()] };
  }

  /** 先持久化 UPDATE，再更新内存；同键后写只保留最后一条待发布写。 */
  private write(txnId: TransactionId, key: string, data: VersionData): void {
    const txn = this.requireActive(txnId);
    const write: TransactionWrite = {
      kind: 'write', key, data, createdVersionId: `${txnId}:${txn.writeOrdinal + 1}`,
    };
    this.durability?.update(txnId, write);
    txn.writeOrdinal++;
    txn.writes.set(key, write);
    txn.trace.accesses.push(write);
  }

  private requireActive(txnId: TransactionId): ActiveTransaction {
    const txn = this.active.get(txnId);
    if (!txn) throw new Error('TXN_NOT_ACTIVE');
    return txn;
  }

  /** 活动状态与具名锁的唯一释放路径；返回不可变事务历史供调用方记录。 */
  private finish(txn: ActiveTransaction): TransactionTrace {
    const { txnId, lock } = txn.trace;
    this.active.delete(txnId);
    if (lock !== undefined) this.locks.delete(lock);
    return txn.trace;
  }
}
