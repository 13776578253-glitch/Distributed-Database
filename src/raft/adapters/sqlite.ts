/**
 * Durable Raft storage backed by SQLite. Owns the hard_state row and the
 * replicated log and snapshot; every mutation commits before returning.
 * This is not the transaction WAL and shares no identifier with it.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Entry, HardState, Snapshot, Storage } from '../core/types.ts';

/** 打开或创建指定路径的存储；单一路径只应由一个节点进程使用。 */
export function sqliteStorage(path: string): Storage {
  const db = new DatabaseSync(path);
  // WAL + FULL：事务提交返回后，硬状态和日志对崩溃恢复可见。
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS hard_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      term INTEGER NOT NULL,
      voted_for TEXT
    ) STRICT;
    INSERT OR IGNORE INTO hard_state VALUES (1, 0, NULL);
    CREATE TABLE IF NOT EXISTS raft_log (
      log_index INTEGER PRIMARY KEY,
      term INTEGER NOT NULL,
      command TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS raft_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_included_index INTEGER NOT NULL,
      last_included_term INTEGER NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
  `);
  // hard_state 固定单行；首次打开时已插入 term=0、voted_for=NULL。
  const hard = db.prepare('SELECT term, voted_for AS votedFor FROM hard_state WHERE id = 1');
  // 预编译语句在连接生命周期内复用；load 按 log_index 顺序返回整条日志。
  const log = db.prepare('SELECT term, command FROM raft_log ORDER BY log_index');
  const save = db.prepare('UPDATE hard_state SET term = ?, voted_for = ? WHERE id = 1');
  const truncate = db.prepare('DELETE FROM raft_log WHERE log_index >= ?');
  const insert = db.prepare('INSERT INTO raft_log VALUES (?, ?, ?)');
  const latestSnapshot = db.prepare('SELECT last_included_index, last_included_term, state FROM raft_snapshot WHERE id = 1');
  const saveSnapshot = db.prepare('INSERT OR REPLACE INTO raft_snapshot VALUES (1, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM raft_log WHERE log_index <= ?');
  const clear = db.prepare('DELETE FROM raft_log');

  function transaction(write: () => void) {
    db.exec('BEGIN IMMEDIATE');
    try {
      write();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 同步实现 Storage 契约：读取完整状态，写入在返回前已提交。 */
  return {
    /** 恢复单行硬状态与快照，日志行按绝对索引排序。 */
    load() {
      const row = latestSnapshot.get();
      return {
        ...hard.get() as HardState,
        entries: log.all().map(row => ({
          term: row.term as number,
          command: JSON.parse(row.command as string) as Entry['command'],
        })),
        ...(row ? { snapshot: {
          lastIncludedIndex: row.last_included_index as number,
          lastIncludedTerm: row.last_included_term as number,
          state: JSON.parse(row.state as string) as Snapshot['state'],
        } } : {}),
      };
    },
    /** 单行更新；synchronous=FULL 下返回即已持久化。 */
    saveHardState({ term, votedFor }) {
      save.run(term, votedFor);
    },
    /** 在单个写事务内截断后缀并写入新条目；entries 为空时仅截断。 */
    replaceSuffix(fromIndex, entries) {
      transaction(() => {
        // 截断与插入必须原子完成，否则崩溃会留下半替换的日志。
        truncate.run(fromIndex);
        for (const [offset, entry] of entries.entries()) {
          insert.run(fromIndex + offset, entry.term, JSON.stringify(entry.command));
        }
      });
    },
    saveSnapshot(snapshot, retainSuffix) {
      transaction(() => {
        // 快照和裁剪必须一起提交，重启只能看到完整的新状态或原来的日志。
        saveSnapshot.run(snapshot.lastIncludedIndex, snapshot.lastIncludedTerm, JSON.stringify(snapshot.state));
        if (retainSuffix) prune.run(snapshot.lastIncludedIndex);
        else clear.run();
      });
    },
  };
}
