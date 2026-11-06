import { DatabaseSync } from 'node:sqlite';
import type { Entry, HardState, Storage } from '../core/types.ts';

export function sqliteStorage(path: string): Storage {
  const db = new DatabaseSync(path);
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
  `);
  const hard = db.prepare('SELECT term, voted_for AS votedFor FROM hard_state WHERE id = 1');
  const log = db.prepare('SELECT term, command FROM raft_log ORDER BY log_index');
  const save = db.prepare('UPDATE hard_state SET term = ?, voted_for = ? WHERE id = 1');
  const truncate = db.prepare('DELETE FROM raft_log WHERE log_index >= ?');
  const insert = db.prepare('INSERT INTO raft_log VALUES (?, ?, ?)');

  return {
    load() {
      return {
        ...hard.get() as HardState,
        entries: log.all().map(row => ({
          term: row.term as number,
          command: JSON.parse(row.command as string) as Entry['command'],
        })),
      };
    },
    saveHardState({ term, votedFor }) {
      save.run(term, votedFor);
    },
    replaceSuffix(fromIndex, entries) {
      db.exec('BEGIN IMMEDIATE');
      try {
        truncate.run(fromIndex);
        for (const [offset, entry] of entries.entries()) {
          insert.run(fromIndex + offset, entry.term, JSON.stringify(entry.command));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
