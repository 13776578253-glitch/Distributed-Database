/** Coordinates synchronous WAL and SQLite writes at the transaction engine boundary. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitSeq, TransactionId, TransactionWrite } from '../../contracts/transaction.ts';
import { TransactionEngine } from '../core/engine.ts';
import type { TransactionDurability } from '../core/engine.ts';
import { checkpoint, recover } from './recovery.ts';
import { SqliteVersions } from './sqlite.ts';
import { Wal } from './wal.ts';
import type { Fault } from './wal.ts';

/**
 * Opens the WAL and SQLite version store, completes recovery, then returns the
 * engine and observation handles. Failure closes stores already opened.
 */
export function openTransaction(directory: string, fault?: Fault) {
  mkdirSync(directory, { recursive: true });
  const wal = new Wal(join(directory, 'wal.jsonl'));
  let data: SqliteVersions | undefined;
  try {
    data = new SqliteVersions(join(directory, 'versions.sqlite'), wal.records());
    const recovery = recover(wal, data, fault);
    const storage = new DurableTransaction(wal, data, fault);
    return {
      engine: storage.engine(), wal, data, recovery,
      checkpoint: () => storage.checkpoint(), close: () => storage.close(),
    };
  } catch (error) {
    data?.close();
    wal.close();
    throw error;
  }
}

class DurableTransaction implements TransactionDurability {
  private readonly wal: Wal;
  private readonly data: SqliteVersions;
  private readonly fault?: Fault;

  constructor(wal: Wal, data: SqliteVersions, fault?: Fault) {
    this.wal = wal;
    this.data = data;
    this.fault = fault;
  }

  /** 从事务链与 SQLite 已提交版本恢复事务号、提交水位和版本链。 */
  engine(): TransactionEngine {
    const records = this.wal.records();
    const lastBegin = records.findLast(record => record.type === 'BEGIN');
    const lastCommit = records.findLast(record => record.type === 'COMMIT');
    return new TransactionEngine(this, {
      nextTxnId: lastBegin ? Number(lastBegin.txnId.slice(4)) + 1 : 1,
      commitSeq: lastCommit?.commitSeq ?? 0,
      versions: this.data.committed(),
    });
  }

  begin(txnId: TransactionId): void {
    this.wal.append({ type: 'BEGIN', txnId });
  }

  /** UPDATE 先落 WAL；SQLite 失败时由重放补齐。 */
  update(txnId: TransactionId, write: TransactionWrite): void {
    const record = this.wal.append({
      type: 'UPDATE', txnId, key: write.key, versionId: write.createdVersionId, before: null, after: write.data,
    });
    this.fault?.('after-update-wal', record);
    this.data.apply(record);
    this.fault?.('after-update-data', record);
  }

  /** COMMIT 先落 WAL，再物化 SQLite；END 只关闭事务链。 */
  commit(txnId: TransactionId, commitSeq: CommitSeq): void {
    this.fault?.('before-commit-wal');
    const record = this.wal.append({ type: 'COMMIT', txnId, commitSeq });
    this.fault?.('after-commit-wal', record);
    this.data.apply(record);
    this.wal.append({ type: 'END', txnId, outcome: 'committed' });
  }

  /** ABORT 记录不物化；END 清理该事务的未提交版本。 */
  abort(txnId: TransactionId): void {
    this.wal.append({ type: 'ABORT', txnId });
    this.data.apply(this.wal.append({ type: 'END', txnId, outcome: 'aborted' }));
  }

  checkpoint() {
    return checkpoint(this.wal, this.data, this.fault);
  }

  close(): void {
    this.data.close();
    this.wal.close();
  }
}
