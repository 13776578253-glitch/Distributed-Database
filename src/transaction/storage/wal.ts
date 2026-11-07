/** Owns the append-only transaction journal, LSN assignment, and transaction log links. */
import {
  closeSync, constants, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { CommitSeq, TransactionId, VersionData, VersionId } from '../../contracts/transaction.ts';

export type WalAction =
  | { type: 'BEGIN'; txnId: TransactionId }
  | { type: 'ABORT'; txnId: TransactionId }
  | { type: 'UPDATE'; txnId: TransactionId; key: string; versionId: VersionId; before: null; after: VersionData }
  | { type: 'COMMIT'; txnId: TransactionId; commitSeq: CommitSeq }
  | { type: 'END'; txnId: TransactionId; outcome: 'committed' | 'aborted' }
  | { type: 'CLR'; txnId: TransactionId; versionId: VersionId; undoneLsn: number; undoNextLsn: number | null }
  | { type: 'CHECKPOINT_BEGIN' }
  | { type: 'CHECKPOINT'; beginLsn: number; appliedLsn: number; active: [TransactionId, number][] };

export type WalRecord = WalAction & { lsn: number; prevLsn: number | null };
export const faultPoints = [
  'after-update-wal', 'after-update-data', 'before-commit-wal', 'after-commit-wal',
  'during-checkpoint', 'during-redo', 'after-clr-wal',
] as const;
export type FaultPoint = typeof faultPoints[number];
export type Fault = (point: FaultPoint, record?: WalRecord) => void;

export class Wal {
  private readonly fd: number;
  private endOffset: number;
  private readonly entries: WalRecord[] = [];
  private readonly tails = new Map<TransactionId, number>();

  constructor(path: string) {
    this.fd = openSync(path, constants.O_CREAT | constants.O_RDWR);
    try {
      const bytes = readFileSync(this.fd);
      const complete = bytes.lastIndexOf(10) + 1;
      this.endOffset = complete;
      if (complete !== bytes.length) {
        // 末尾未成帧的写入不可能已通过刷盘返回。已成帧的损坏必须报错。
        ftruncateSync(this.fd, complete);
        fsyncSync(this.fd);
      }
      for (const line of bytes.subarray(0, complete).toString('utf8').split('\n').slice(0, -1)) {
        const record = JSON.parse(line) as WalRecord;
        if (record.lsn !== this.entries.length + 1 || record.prevLsn !== this.tail(record)) {
          throw new Error(`Invalid WAL chain at LSN ${record.lsn}`);
        }
        this.track(record);
      }
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(path), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  append(action: WalAction): WalRecord {
    const record: WalRecord = {
      ...action, lsn: this.entries.length + 1, prevLsn: this.tail(action),
    };
    const frame = Buffer.from(JSON.stringify(record) + '\n');
    let offset = 0;
    while (offset < frame.length) {
      const written = writeSync(this.fd, frame, offset, frame.length - offset, this.endOffset + offset);
      if (written === 0) throw new Error('WAL append made no progress');
      offset += written;
    }
    fsyncSync(this.fd);
    this.endOffset += frame.length;
    this.track(record);
    return record;
  }

  records(): readonly WalRecord[] {
    return this.entries;
  }

  commitSeqAt(lsn: number): CommitSeq {
    if (!Number.isSafeInteger(lsn) || lsn < 0 || lsn > this.entries.length) throw new RangeError('INVALID_LSN');
    for (let index = lsn - 1; index >= 0; index--) {
      const record = this.entries[index];
      if (record.type === 'COMMIT') return record.commitSeq;
    }
    return 0;
  }

  activeTails(): [TransactionId, number][] {
    return [...this.tails];
  }

  close(): void {
    closeSync(this.fd);
  }

  private track(record: WalRecord): void {
    this.entries.push(record);
    if (!('txnId' in record)) return;
    if (record.type === 'END') this.tails.delete(record.txnId);
    else this.tails.set(record.txnId, record.lsn);
  }

  private tail(action: WalAction): number | null {
    return 'txnId' in action ? this.tails.get(action.txnId) ?? null : null;
  }
}
