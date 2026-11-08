/**
 * Append-only JSONL transaction journal. Owns global LSN assignment,
 * per-transaction prevLsn chains, fsync-before-return, and partial-tail repair.
 */
import {
  closeSync, constants, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { CommitSeq, TransactionId, VersionData, VersionId } from '../../contracts/transaction.ts';

/**
 * 物理日志动作。UPDATE 不保存 before 镜像，撤销依赖 versionId 与未提交版本。
 * CLR 的 undoNextLsn 为 null 表示该事务没有更早的更新需要撤销。
 */
export type WalAction =
  | { type: 'BEGIN'; txnId: TransactionId }
  | { type: 'ABORT'; txnId: TransactionId }
  | { type: 'UPDATE'; txnId: TransactionId; key: string; versionId: VersionId; before: null; after: VersionData }
  | { type: 'COMMIT'; txnId: TransactionId; commitSeq: CommitSeq }
  | { type: 'END'; txnId: TransactionId; outcome: 'committed' | 'aborted' }
  | { type: 'CLR'; txnId: TransactionId; versionId: VersionId; undoneLsn: number; undoNextLsn: number | null }
  | { type: 'CHECKPOINT_BEGIN' }
  | { type: 'CHECKPOINT'; beginLsn: number; appliedLsn: number; active: [TransactionId, number][] };

/** lsn 是全局 1-based 序号；prevLsn 指向同一事务的上一条记录。 */
export type WalRecord = WalAction & { lsn: number; prevLsn: number | null };
/** 实验故障注入点；由独立事务服务在测试模式下按名称触发。 */
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
  /** 每个有 txnId 且尚未 END 的事务末条记录 LSN；END 后移除。 */
  private readonly tails = new Map<TransactionId, number>();

  /**
   * 打开已有日志。只截断末尾未成帧的半条记录；已成帧但链校验失败必须抛错。
   * 目录 fsync 仅在支持该语义的平台执行，用于持久化目录项。
   */
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

  /**
   * 追加并 fsync 后才返回。写入循环处理短写；未完成 fsync 前不推进 endOffset
   * 或内存链，确保调用方看到的记录一定已越过持久化边界。
   */
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

  /** 返回 LSN（含）之前最近一次提交的 commitSeq；没有提交时返回 0。 */
  commitSeqAt(lsn: number): CommitSeq {
    if (!Number.isSafeInteger(lsn) || lsn < 0 || lsn > this.entries.length) throw new RangeError('INVALID_LSN');
    for (let index = lsn - 1; index >= 0; index--) {
      const record = this.entries[index];
      if (record.type === 'COMMIT') return record.commitSeq;
    }
    return 0;
  }

  /** 检查点写入的活跃事务末 LSN 快照。 */
  activeTails(): [TransactionId, number][] {
    return [...this.tails];
  }

  close(): void {
    closeSync(this.fd);
  }

  /** 维护全局记录和每个事务的链尾；END 关闭链，物理记录本身仍保留。 */
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
