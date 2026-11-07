/** Exercises transaction interleavings and checks the histories emitted by the MVCC core. */
import { describe, expect, it } from 'vitest';
import type { IsolationLevel, TransactionId } from '../../src/contracts/transaction.ts';
import { TransactionEngine } from '../../src/transaction/core/engine.ts';

function begin(engine: TransactionEngine, isolation: IsolationLevel, lock?: string) {
  const result = engine.begin(isolation, lock);
  if (!result.ok) throw new Error(result.error);
  return result.txnId;
}

function commit(engine: TransactionEngine, txnId: TransactionId) {
  const result = engine.commit(txnId);
  if (!result.ok) throw new Error(result.error);
  return result.history;
}

describe('MVCC', () => {
  it('RC refreshes its read view per operation and excludes uncommitted writes', () => {
    const engine = new TransactionEngine();
    const initial = begin(engine, 'RC');
    engine.put(initial, 'x', 'before');
    const first = commit(engine, initial);

    const reader = begin(engine, 'RC');
    const writer = begin(engine, 'RC');
    engine.put(writer, 'x', 'after');
    expect(engine.read(reader, 'x')).toEqual({ found: true, value: 'before' });
    const second = commit(engine, writer);
    expect(engine.read(reader, 'x')).toEqual({ found: true, value: 'after' });
    expect(commit(engine, reader)).toMatchObject({
      isolation: 'RC', snapshotSeq: null, status: 'committed', commitSeq: 3,
      accesses: [
        { kind: 'read', key: 'x', source: 'committed', viewSeq: first.commitSeq, observedVersionId: `${initial}:1` },
        { kind: 'read', key: 'x', source: 'committed', viewSeq: second.commitSeq, observedVersionId: `${writer}:1` },
      ],
    });
  });

  it('SI takes its snapshot at BEGIN and keeps it even before its first read', () => {
    const engine = new TransactionEngine();
    const initial = begin(engine, 'RC');
    engine.put(initial, 'x', 'before');
    commit(engine, initial);

    const reader = begin(engine, 'SI');
    const writer = begin(engine, 'RC');
    engine.delete(writer, 'x');
    engine.put(writer, 'new', 7);
    commit(engine, writer);
    expect(engine.read(reader, 'x')).toEqual({ found: true, value: 'before' });
    expect(engine.read(reader, 'new')).toEqual({ found: false });
    expect(engine.read(reader, 'x')).toEqual({ found: true, value: 'before' });
    expect(commit(engine, reader)).toMatchObject({
      snapshotSeq: 1,
      accesses: [
        { viewSeq: 1, observedVersionId: `${initial}:1` },
        { viewSeq: 1, observedVersionId: null, source: 'absent' },
        { viewSeq: 1, observedVersionId: `${initial}:1` },
      ],
    });
  });

  it.each(['RC', 'SI'] as const)('%s reads its own writes and publishes only the final version per key', isolation => {
    const engine = new TransactionEngine();
    const writer = begin(engine, isolation);
    const reader = begin(engine, 'RC');
    engine.put(writer, 'x', 'first');
    expect(engine.read(writer, 'x')).toEqual({ found: true, value: 'first' });
    engine.delete(writer, 'x');
    expect(engine.read(writer, 'x')).toEqual({ found: false });
    engine.put(writer, 'x', 'last');
    expect(engine.read(writer, 'x')).toEqual({ found: true, value: 'last' });
    expect(engine.read(reader, 'x')).toEqual({ found: false });
    expect(commit(engine, writer)).toMatchObject({
      accesses: [
        { kind: 'write', createdVersionId: `${writer}:1`, data: { tombstone: false, value: 'first' } },
        { kind: 'read', source: 'own', observedVersionId: `${writer}:1` },
        { kind: 'write', createdVersionId: `${writer}:2`, data: { tombstone: true } },
        { kind: 'read', source: 'own', observedVersionId: `${writer}:2` },
        { kind: 'write', createdVersionId: `${writer}:3`, data: { tombstone: false, value: 'last' } },
        { kind: 'read', source: 'own', observedVersionId: `${writer}:3` },
      ],
    });
    expect(engine.read(reader, 'x')).toEqual({ found: true, value: 'last' });
    expect(commit(engine, reader).accesses).toMatchObject([
      { source: 'absent', observedVersionId: null },
      { source: 'committed', observedVersionId: `${writer}:3` },
    ]);
  });

  it('SI treats a concurrent tombstone as a write conflict and aborts the whole write set', () => {
    const engine = new TransactionEngine();
    const initial = begin(engine, 'RC');
    engine.put(initial, 'x', 'before');
    commit(engine, initial);

    const loser = begin(engine, 'SI', 'guard');
    const winner = begin(engine, 'SI');
    engine.put(loser, 'another-key', 1);
    engine.put(loser, 'x', 'loser');
    engine.delete(winner, 'x');
    expect(commit(engine, winner).commitSeq).toBe(2);
    expect(engine.commit(loser)).toMatchObject({
      ok: false, error: 'WRITE_CONFLICT', key: 'x',
      history: {
        status: 'aborted', snapshotSeq: 1,
        accesses: [{ createdVersionId: `${loser}:1` }, { createdVersionId: `${loser}:2` }],
      },
    });
    expect(engine.asOf('x', 2)).toEqual({ found: false });
    expect(engine.asOf('another-key', 2)).toEqual({ found: false });
    expect(() => engine.commit(loser)).toThrow('TXN_NOT_ACTIVE');
    expect(commit(engine, begin(engine, 'SI', 'guard')).commitSeq).toBe(3);
  });

  it('SI commits concurrent updates on different keys', () => {
    const engine = new TransactionEngine();
    const a = begin(engine, 'SI');
    const b = begin(engine, 'SI');
    engine.put(a, 'x', 10);
    engine.put(b, 'y', 20);
    expect(commit(engine, b)).toMatchObject({ snapshotSeq: 0, commitSeq: 1 });
    expect(commit(engine, a)).toMatchObject({ snapshotSeq: 0, commitSeq: 2 });
    expect(engine.asOf('x', 1)).toEqual({ found: false });
    expect(engine.asOf('x', 2)).toEqual({ found: true, value: 10 });
    expect(engine.asOf('y', 2)).toEqual({ found: true, value: 20 });
  });

  it('RC orders same-key writes by commit order', () => {
    const engine = new TransactionEngine();
    const a = begin(engine, 'RC');
    const b = begin(engine, 'RC');
    engine.put(a, 'x', 'last to commit');
    engine.put(b, 'x', 'first to commit');
    commit(engine, b);
    commit(engine, a);
    expect(engine.asOf('x', 1)).toEqual({ found: true, value: 'first to commit' });
    expect(engine.asOf('x', 2)).toEqual({ found: true, value: 'last to commit' });
  });

  it.each([false, true])('replays on-call write skew with the explicit guard enabled = %s', guarded => {
    const engine = new TransactionEngine();
    const initial = begin(engine, 'RC');
    engine.put(initial, 'alice', true);
    engine.put(initial, 'bob', true);
    const seed = commit(engine, initial);
    const lock = guarded ? 'on-call' : undefined;
    const alice = begin(engine, 'SI', lock);
    const bob = engine.begin('SI', lock);

    function leaveIfCovered(txnId: TransactionId, doctor: string, other: string) {
      const coverage = engine.read(txnId, other);
      if (coverage.found && coverage.value === true) engine.put(txnId, doctor, false);
    }

    leaveIfCovered(alice, 'alice', 'bob');
    if (guarded) expect(bob).toEqual({ ok: false, error: 'LOCK_CONFLICT' });
    if (bob.ok) leaveIfCovered(bob.txnId, 'bob', 'alice');
    const aliceCommit = commit(engine, alice);

    const bobId = bob.ok ? bob.txnId : begin(engine, 'SI', lock);
    if (!bob.ok) leaveIfCovered(bobId, 'bob', 'alice');
    const bobCommit = commit(engine, bobId);
    expect(aliceCommit.accesses[0]).toMatchObject({ key: 'bob', observedVersionId: `${initial}:2` });
    expect(bobCommit.accesses[0]).toMatchObject({
      key: 'alice', observedVersionId: guarded ? `${alice}:1` : `${initial}:1`,
    });
    expect(bobCommit.snapshotSeq).toBe(guarded ? aliceCommit.commitSeq : seed.commitSeq);
    expect(engine.asOf('alice', bobCommit.commitSeq)).toEqual({ found: true, value: false });
    expect(engine.asOf('bob', bobCommit.commitSeq)).toEqual({ found: true, value: guarded });
  });

  it('distinguishes missing, null, and deleted versions across AS OF boundaries', () => {
    const engine = new TransactionEngine();
    const create = begin(engine, 'RC');
    engine.put(create, 'x', null);
    expect(engine.asOf('x', 0)).toEqual({ found: false });
    commit(engine, create);

    const remove = begin(engine, 'SI');
    engine.delete(remove, 'x');
    expect(engine.asOf('x', 1)).toEqual({ found: true, value: null });
    commit(engine, remove);
    const reader = begin(engine, 'RC');
    expect(engine.read(reader, 'x')).toEqual({ found: false });
    expect(engine.read(reader, 'never-present')).toEqual({ found: false });

    const restore = begin(engine, 'RC');
    engine.put(restore, 'x', 0);
    commit(engine, restore);
    expect(engine.asOf('x', 1)).toEqual({ found: true, value: null });
    expect(engine.asOf('x', 2)).toEqual({ found: false });
    expect(engine.asOf('x', 3)).toEqual({ found: true, value: 0 });
    expect(commit(engine, reader).accesses).toMatchObject([
      { source: 'committed', observedVersionId: `${remove}:1`, result: { found: false } },
      { source: 'absent', observedVersionId: null, result: { found: false } },
    ]);
    for (const invalid of [-1, 1.5, 5]) expect(() => engine.asOf('x', invalid)).toThrow('INVALID_COMMIT_SEQ');
  });

  it('ABORT discards private versions, releases the lock, and preserves the operation trace', () => {
    const engine = new TransactionEngine();
    const initial = begin(engine, 'RC');
    engine.put(initial, 'x', 'before');
    commit(engine, initial);

    const txn = begin(engine, 'SI', 'guard');
    engine.delete(txn, 'x');
    engine.put(txn, 'new', 1);
    expect(engine.abort(txn)).toMatchObject({
      txnId: txn, status: 'aborted',
      accesses: [
        { key: 'x', createdVersionId: `${txn}:1`, data: { tombstone: true } },
        { key: 'new', createdVersionId: `${txn}:2`, data: { tombstone: false, value: 1 } },
      ],
    });
    expect(() => engine.read(txn, 'x')).toThrow('TXN_NOT_ACTIVE');
    const retry = begin(engine, 'SI', 'guard');
    expect(retry).not.toBe(txn);
    expect(engine.read(retry, 'x')).toEqual({ found: true, value: 'before' });
    expect(engine.read(retry, 'new')).toEqual({ found: false });
    expect(commit(engine, retry)).toMatchObject({ snapshotSeq: 1, commitSeq: 2 });
  });
});
