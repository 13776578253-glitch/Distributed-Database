/** Checks on-disk WAL ordering, atomic visibility, and durable identifier high-water marks. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionEngine } from '../../src/transaction/core/engine.ts';
import { openTransaction } from '../../src/transaction/storage/durable.ts';
import { SqliteVersions } from '../../src/transaction/storage/sqlite.ts';
import { Wal } from '../../src/transaction/storage/wal.ts';

function begin(engine: TransactionEngine, isolation: 'RC' | 'SI' = 'RC') {
  const result = engine.begin(isolation);
  if (!result.ok) throw new Error(result.error);
  return result.txnId;
}

describe('durable transactions', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'txn-durable-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('flushes UPDATE and COMMIT before changing SQLite, and publishes all final versions together', () => {
    const store = openTransaction(directory, (point, record) => {
      if (point !== 'after-update-wal' && point !== 'after-commit-wal') return;
      const lines = readFileSync(join(directory, 'wal.jsonl'), 'utf8').trimEnd().split('\n');
      expect(JSON.parse(lines.at(-1)!)).toEqual(record);
      expect(store.data.appliedLsn()).toBeLessThan(record!.lsn);
      expect(store.data.committed()).toEqual([]);
    });
    try {
      const writer = begin(store.engine, 'SI');
      const reader = begin(store.engine);
      store.engine.put(writer, 'a', 1);
      store.engine.put(writer, 'b', 2);
      store.engine.put(writer, 'a', 3);
      expect(store.data.counts()).toEqual({ pending: 3, committed: 0 });
      expect(store.engine.read(reader, 'a')).toEqual({ found: false });
      expect(store.engine.read(writer, 'a')).toEqual({ found: true, value: 3 });
      expect(store.engine.commit(writer)).toMatchObject({ ok: true, history: { commitSeq: 1 } });
      expect(store.data.counts()).toEqual({ pending: 0, committed: 2 });
      expect(store.data.committed()).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'a', versionId: `${writer}:3`, commitSeq: 1 }),
        expect.objectContaining({ key: 'b', versionId: `${writer}:2`, commitSeq: 1 }),
      ]));
      expect(store.engine.read(reader, 'a')).toEqual({ found: true, value: 3 });
      expect(store.engine.read(reader, 'b')).toEqual({ found: true, value: 2 });
      store.engine.abort(reader);
      expect(store.wal.records().map(({ lsn, prevLsn, type }) => [lsn, prevLsn, type])).toEqual([
        [1, null, 'BEGIN'], [2, null, 'BEGIN'], [3, 1, 'UPDATE'], [4, 3, 'UPDATE'], [5, 4, 'UPDATE'],
        [6, 5, 'COMMIT'], [7, 6, 'END'], [8, 2, 'ABORT'], [9, 8, 'END'],
      ]);
    } finally { store.close(); }
  });

  it('keeps committed versions and advances all identifiers after reopening, including read-only commits', () => {
    const first = openTransaction(directory);
    try {
      const writer = begin(first.engine);
      first.engine.put(writer, 'key', null);
      expect(first.engine.commit(writer)).toMatchObject({ ok: true, history: { commitSeq: 1 } });
      const readOnly = begin(first.engine);
      expect(first.engine.commit(readOnly)).toMatchObject({ ok: true, history: { commitSeq: 2 } });
      const aborted = begin(first.engine);
      first.engine.delete(aborted, 'key');
      first.engine.abort(aborted);
      expect(first.data.counts()).toEqual({ pending: 0, committed: 1 });
    } finally { first.close(); }

    const reopened = openTransaction(directory);
    try {
      expect(reopened.engine.asOf('key', 1)).toEqual({ found: true, value: null });
      const writer = begin(reopened.engine, 'SI');
      expect(writer).toBe('txn-4');
      reopened.engine.delete(writer, 'key');
      expect(reopened.engine.commit(writer)).toMatchObject({
        ok: true, history: { snapshotSeq: 2, commitSeq: 3, accesses: [{ createdVersionId: 'txn-4:1' }] },
      });
      expect(reopened.engine.asOf('key', 3)).toEqual({ found: false });
      expect(reopened.data.committed().map(version => version.versionId)).toEqual(['txn-1:1', 'txn-4:1']);
    } finally { reopened.close(); }
  });

  it.each(['before-commit-wal', 'after-commit-wal'] as const)('persists the expected boundary at %s', point => {
    const store = openTransaction(directory, current => {
      if (current === point) throw new Error('interrupted');
    });
    try {
      const txn = begin(store.engine);
      store.engine.put(txn, 'a', true);
      store.engine.put(txn, 'b', false);
      expect(() => store.engine.commit(txn)).toThrow('interrupted');
    } finally { store.close(); }

    const wal = new Wal(join(directory, 'wal.jsonl'));
    const data = new SqliteVersions(join(directory, 'versions.sqlite'));
    try {
      expect(data.counts()).toEqual({ pending: 2, committed: 0 });
      expect(wal.records().map(record => record.type)).toEqual(
        point === 'after-commit-wal' ? ['BEGIN', 'UPDATE', 'UPDATE', 'COMMIT'] : ['BEGIN', 'UPDATE', 'UPDATE'],
      );
    } finally {
      data.close();
      wal.close();
    }
  });
});
