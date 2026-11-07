/** Injects interruptions at durable boundaries and reopens the same on-disk state. */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTransaction } from '../../src/transaction/storage/durable.ts';
import type { FaultPoint } from '../../src/transaction/storage/wal.ts';

type Store = ReturnType<typeof openTransaction>;

function begin(store: Store) {
  const result = store.engine.begin('SI');
  if (!result.ok) throw new Error(result.error);
  return result.txnId;
}

function stopAt(target: FaultPoint) {
  return (point: FaultPoint) => {
    if (point === target) throw new Error(target);
  };
}

describe('transaction recovery', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'txn-recovery-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('redoes a durable COMMIT, publishes both keys, and leaves history intact on a repeated restart', () => {
    const store = openTransaction(directory, stopAt('after-commit-wal'));
    const txn = begin(store);
    store.engine.put(txn, 'a', null);
    const checkpoint = store.checkpoint();
    store.engine.put(txn, 'b', 2);
    expect(() => store.engine.commit(txn)).toThrow('after-commit-wal');
    const commitLsn = store.wal.records().at(-1)!.lsn;
    store.close();

    const recovered = openTransaction(directory);
    expect(recovered.recovery).toMatchObject({
      checkpointLsn: checkpoint.lsn, analysisStartLsn: checkpoint.lsn + 1,
      redoLsns: [commitLsn], winners: [txn], losers: [],
    });
    expect(recovered.engine.asOf('a', 0)).toEqual({ found: false });
    expect(recovered.engine.asOf('a', 1)).toEqual({ found: true, value: null });
    expect(recovered.engine.asOf('b', 1)).toEqual({ found: true, value: 2 });
    const versions = recovered.data.committed();
    recovered.close();

    const again = openTransaction(directory);
    try {
      expect(again.recovery).toMatchObject({ redoLsns: [], winners: [], losers: [] });
      expect(again.data.committed()).toEqual(versions);
      const reader = begin(again);
      expect(reader).toBe('txn-2');
      expect(again.engine.commit(reader)).toMatchObject({ ok: true, history: { commitSeq: 2 } });
    } finally { again.close(); }
  });

  it('restarts after Redo physically applies an UPDATE and then undoes that loser once', () => {
    const store = openTransaction(directory, stopAt('after-update-wal'));
    const txn = begin(store);
    expect(() => store.engine.put(txn, 'x', 1)).toThrow('after-update-wal');
    const updateLsn = store.wal.records().at(-1)!.lsn;
    expect(store.data.counts().pending).toBe(0);
    store.close();

    expect(() => openTransaction(directory, stopAt('during-redo'))).toThrow('during-redo');
    const resumed = openTransaction(directory);
    try {
      expect(resumed.recovery).toMatchObject({ redoLsns: [], losers: [txn], undoneLsns: [updateLsn] });
      expect(resumed.data.counts()).toEqual({ pending: 0, committed: 0 });
      expect(resumed.wal.records().filter(record => record.type === 'CLR')).toHaveLength(1);
    } finally { resumed.close(); }
  });

  it('redoes a durable CLR and follows undoNextLsn without creating a second CLR for the same update', () => {
    const final = [];
    for (const path of [join(directory, 'interrupted'), join(directory, 'baseline')]) {
      const store = openTransaction(path);
      const winner = begin(store);
      store.engine.put(winner, 'x', 'committed');
      store.engine.commit(winner);
      const loser = begin(store);
      store.engine.put(loser, 'x', 'private');
      const first = store.wal.records().at(-1)!.lsn;
      store.checkpoint();
      store.engine.delete(loser, 'x');
      const second = store.wal.records().at(-1)!.lsn;
      expect(store.data.counts()).toEqual({ pending: 2, committed: 1 });
      store.close();

      if (path.endsWith('interrupted')) {
        expect(() => openTransaction(path, stopAt('after-clr-wal'))).toThrow('after-clr-wal');
      }
      const recovered = openTransaction(path);
      try {
        const clrs = recovered.wal.records().filter(record => record.type === 'CLR');
        expect(clrs.map(record => [record.undoneLsn, record.undoNextLsn])).toEqual([[second, first], [first, first - 1]]);
        if (path.endsWith('interrupted')) {
          expect(recovered.recovery).toMatchObject({ redoLsns: [clrs[0].lsn], undoneLsns: [first] });
        } else {
          expect(recovered.recovery.undoneLsns).toEqual([second, first]);
        }
        expect(recovered.data.counts().pending).toBe(0);
        expect(recovered.engine.asOf('x', 1)).toEqual({ found: true, value: 'committed' });
        final.push(recovered.data.committed());
      } finally { recovered.close(); }
    }
    expect(final[0]).toEqual(final[1]);
  });

  it('ignores an interrupted checkpoint and uses the previous checkpoint to find an active transaction', () => {
    let interrupt = false;
    const store = openTransaction(directory, point => {
      if (interrupt) stopAt('during-checkpoint')(point);
    });
    const txn = begin(store);
    store.engine.put(txn, 'x', 1);
    const checkpoint = store.checkpoint();
    expect(checkpoint).toMatchObject({ type: 'CHECKPOINT', appliedLsn: 2, active: [[txn, 2]] });
    interrupt = true;
    expect(() => store.checkpoint()).toThrow('during-checkpoint');
    store.close();

    const recovered = openTransaction(directory);
    try {
      expect(recovered.recovery).toMatchObject({
        checkpointLsn: checkpoint.lsn, redoStartLsn: 3, losers: [txn], undoneLsns: [2],
      });
      expect(recovered.data.counts()).toEqual({ pending: 0, committed: 0 });
    } finally { recovered.close(); }
  });

  it('truncates an incomplete WAL frame and keeps the last durable identity', () => {
    const store = openTransaction(directory);
    const readOnly = begin(store);
    store.engine.commit(readOnly);
    store.close();
    appendFileSync(join(directory, 'wal.jsonl'), '{"type":"BEGIN","txnId":"txn-2"');

    const recovered = openTransaction(directory);
    try {
      const next = begin(recovered);
      expect(next).toBe('txn-2');
      expect(recovered.wal.records().at(-1)).toMatchObject({ type: 'BEGIN', lsn: 4, prevLsn: null });
      expect(recovered.engine.commit(next)).toMatchObject({ ok: true, history: { commitSeq: 2 } });
    } finally { recovered.close(); }
  });
});
