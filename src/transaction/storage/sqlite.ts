/** Materializes WAL actions into SQLite version rows and an atomic replay cursor. */
import { DatabaseSync } from 'node:sqlite';
import type { VersionData } from '../../contracts/transaction.ts';
import type { CommittedVersion } from '../core/versions.ts';
import type { WalRecord } from './wal.ts';

export class SqliteVersions {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK (id = 1), applied_lsn INTEGER NOT NULL);
      INSERT OR IGNORE INTO progress VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS versions (
        version_id TEXT PRIMARY KEY, txn_id TEXT NOT NULL, key TEXT NOT NULL,
        data TEXT NOT NULL, update_lsn INTEGER NOT NULL, commit_seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS versions_txn ON versions(txn_id, commit_seq, key, update_lsn);
    `);
  }

  appliedLsn(): number {
    return this.db.prepare('SELECT applied_lsn FROM progress WHERE id = 1').get()!.applied_lsn as number;
  }

  /** 物化动作与游标在同一个 SQLite 事务中提交，重放可以安全跳过已落盘动作。 */
  apply(record: WalRecord): boolean {
    const physical = record.type === 'UPDATE' || record.type === 'COMMIT' || record.type === 'CLR'
      || (record.type === 'END' && record.outcome === 'aborted');
    if (!physical || record.lsn <= this.appliedLsn()) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      switch (record.type) {
        case 'UPDATE':
          this.db.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?, NULL)')
            .run(record.versionId, record.txnId, record.key, JSON.stringify(record.after), record.lsn);
          break;
        case 'COMMIT':
          this.db.prepare(`
            DELETE FROM versions WHERE txn_id = ? AND commit_seq IS NULL AND update_lsn NOT IN (
              SELECT MAX(update_lsn) FROM versions WHERE txn_id = ? AND commit_seq IS NULL GROUP BY key
            )
          `).run(record.txnId, record.txnId);
          this.db.prepare('UPDATE versions SET commit_seq = ? WHERE txn_id = ? AND commit_seq IS NULL')
            .run(record.commitSeq, record.txnId);
          break;
        case 'END':
          this.db.prepare('DELETE FROM versions WHERE txn_id = ? AND commit_seq IS NULL').run(record.txnId);
          break;
        case 'CLR':
          this.db.prepare('DELETE FROM versions WHERE version_id = ? AND commit_seq IS NULL').run(record.versionId);
          break;
      }
      this.db.prepare('UPDATE progress SET applied_lsn = ? WHERE id = 1').run(record.lsn);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  committed(): CommittedVersion[] {
    return this.db.prepare(`
      SELECT key, version_id, txn_id, commit_seq, data FROM versions
      WHERE commit_seq IS NOT NULL ORDER BY commit_seq
    `).all().map(row => ({
      key: row.key as string, versionId: row.version_id as string, creatorTxn: row.txn_id as string,
      commitSeq: row.commit_seq as number, data: JSON.parse(row.data as string) as VersionData,
    }));
  }

  counts(): { pending: number; committed: number } {
    const row = this.db.prepare('SELECT COUNT(*) - COUNT(commit_seq) AS pending, COUNT(commit_seq) AS committed FROM versions').get()!;
    return { pending: row.pending as number, committed: row.committed as number };
  }

  close(): void {
    this.db.close();
  }
}
