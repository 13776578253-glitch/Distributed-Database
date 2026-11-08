/** Checkpoints and recovers materialized versions before the engine starts. */
import type { TransactionId } from '../../contracts/transaction.ts';
import type { SqliteVersions } from './sqlite.ts';
import type { Fault, Wal, WalRecord } from './wal.ts';

/** 恢复分析中的事务链尾；只有 committed 进入 winner，其他沿链 Undo。 */
type TransactionTail = { lastLsn: number; status: 'active' | 'committed' | 'aborted' };

/**
 * 写入检查点开始/完成记录，不截断 WAL。完成的检查点保存 SQLite 已物化
 * 游标和当时所有未结束事务的链尾，供下次恢复从正确位置分析。
 */
export function checkpoint(wal: Wal, data: SqliteVersions, fault?: Fault): WalRecord {
  const begin = wal.append({ type: 'CHECKPOINT_BEGIN' });
  fault?.('during-checkpoint', begin);
  return wal.append({
    type: 'CHECKPOINT', beginLsn: begin.lsn, appliedLsn: data.appliedLsn(), active: wal.activeTails(),
  });
}

/**
 * Analysis 从检查点之后开始；Redo 从 SQLite 游标之后重放物理记录；随后
 * 提交者补 END，未结束者补 ABORT/CLR/END。CLR 沿 undoNextLsn 逆行，避免
 * 二次恢复重复撤销同一条 UPDATE。
 */
export function recover(wal: Wal, data: SqliteVersions, fault?: Fault) {
  const records = wal.records();
  const lastCheckpoint = records.findLast(record => record.type === 'CHECKPOINT');
  const analysisStartLsn = (lastCheckpoint?.lsn ?? 0) + 1;
  const redoStartLsn = (lastCheckpoint?.appliedLsn ?? 0) + 1;
  const appliedLsn = data.appliedLsn();
  if (appliedLsn < redoStartLsn - 1 || appliedLsn > records.length) {
    throw new Error('SQLite progress is outside the WAL recovery range');
  }

  const transactions = new Map<TransactionId, TransactionTail>();
  for (const [txnId, lastLsn] of lastCheckpoint?.active ?? []) {
    transactions.set(txnId, { lastLsn, status: 'active' });
  }
  for (const record of records.slice(analysisStartLsn - 1)) {
    if (!('txnId' in record)) continue;
    if (record.type === 'END') transactions.delete(record.txnId);
    else {
      const status = record.type === 'COMMIT' ? 'committed'
        : record.type === 'ABORT' || record.type === 'CLR' ? 'aborted' : 'active';
      transactions.set(record.txnId, { lastLsn: record.lsn, status });
    }
  }

  // Redo 由 SQLite 的 applied_lsn 做幂等跳过。
  const redoLsns: number[] = [];
  for (const record of records.slice(redoStartLsn - 1)) {
    if (!data.apply(record)) continue;
    redoLsns.push(record.lsn);
    fault?.('during-redo', record);
  }

  const winners: TransactionId[] = [];
  const losers: TransactionId[] = [];
  const undoneLsns: number[] = [];
  for (const [txnId, tail] of transactions) {
    if (tail.status === 'committed') {
      // COMMIT 已落 WAL；补 END 只收尾链，不再改变已提交版本。
      winners.push(txnId);
      wal.append({ type: 'END', txnId, outcome: 'committed' });
      continue;
    }
    losers.push(txnId);
    if (tail.status === 'active') wal.append({ type: 'ABORT', txnId });
    // 撤销按事务沿链逆行。各事务独占自己的未提交版本 ID，撤销之间互不覆盖。
    let lsn: number | null = tail.lastLsn;
    while (lsn !== null) {
      const record: WalRecord = records[lsn - 1];
      // 已经写下的 CLR 表示这一段已经撤销，直接跳到它的下一条目标。
      if (record.type === 'CLR') {
        lsn = record.undoNextLsn;
        continue;
      }
      if (record.type === 'UPDATE') {
        const clr = wal.append({
          type: 'CLR', txnId, versionId: record.versionId, undoneLsn: record.lsn, undoNextLsn: record.prevLsn,
        });
        fault?.('after-clr-wal', clr);
        data.apply(clr);
        undoneLsns.push(record.lsn);
      }
      lsn = record.prevLsn;
    }
    data.apply(wal.append({ type: 'END', txnId, outcome: 'aborted' }));
  }

  return { checkpointLsn: lastCheckpoint?.lsn ?? null, analysisStartLsn, redoStartLsn, redoLsns, winners, losers, undoneLsns };
}
