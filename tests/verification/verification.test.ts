/** Exercises the three verifiers against explicit histories and counterexamples. */
import { describe, expect, it } from 'vitest';
import { call, committed, mixedCycleFixture, read, registerFixture, write } from '../../scripts/verification-fixtures.ts';
import { buildDependencyGraph } from '../../src/verification/dependency-graph.ts';
import { checkOnCall } from '../../src/verification/invariants.ts';
import { checkLinearizable } from '../../src/verification/linearizability.ts';

describe('linearizability', () => {
  const initial = new Map();
  const get = { type: 'get', key: 'x' } as const;
  const put = { type: 'put', key: 'x', value: null } as const;

  it('finds an order that reverses overlapping writes and rejects a later unexplained change', () => {
    expect(checkLinearizable(registerFixture(false), { initial })).toMatchObject({
      status: 'PASS', witnesses: [{ order: ['put-b', 'put-a', 'read-first', 'read-second'] }],
    });
    expect(checkLinearizable(registerFixture(true), { initial })).toMatchObject({
      status: 'FAIL',
      counterexample: {
        prefix: ['put-b', 'put-a', 'read-first'],
        realTime: expect.arrayContaining([{ before: 'read-first', after: 'read-second' }]),
        mismatches: [{ operationId: 'read-second', expected: { found: true, value: 'a' }, observed: { found: true, value: 'b' } }],
      },
    });
  });

  it('can include a timed-out write after the timeout and a subsequent missing read', () => {
    const timeout = call('write', put, '1', '2');
    const before = call('before', get, '3', '4', { found: false });
    const after = call('after', get, '5', '6', { found: true, value: null });
    expect(checkLinearizable([timeout, before, after], { initial })).toMatchObject({
      status: 'PASS', witnesses: [{ order: ['before', 'write', 'after'], omitted: [] }],
    });
    expect(checkLinearizable([timeout, before], { initial })).toMatchObject({
      status: 'PASS', witnesses: [{ order: ['before'], omitted: ['write'] }],
    });
  });

  it('handles a pending delete, rejected put, and an unobserved read separately', () => {
    const pending = call('delete', { type: 'delete', key: 'x' }, '1', undefined);
    const refused = { ...call('rejected', put, '4', '5'), outcome: 'rejected' } as const;
    const readUnknown = call('lost-read', get, '3', undefined);
    const observed = call('read', get, '6', '7', { found: false });
    expect(checkLinearizable([pending, refused, readUnknown, observed], { initial: new Map([['x', null]]) })).toMatchObject({
      status: 'PASS', rejected: ['rejected'], unobservedReads: ['lost-read'], witnesses: [{ order: ['delete', 'read'] }],
    });
  });

  it('rejects a read that would need a write invoked after its response', () => {
    expect(checkLinearizable([
      call('read', get, '1', '2', { found: true, value: null }), call('late', put, '3', undefined),
    ], { initial })).toMatchObject({ status: 'FAIL' });
  });

  it('checks delete results and partitions multiple keys', () => {
    const history = [
      call('x', { type: 'delete', key: 'x' }, '1', '3', { deleted: true }),
      call('y', { type: 'delete', key: 'y' }, '2', '4', { deleted: false }),
    ];
    expect(checkLinearizable(history, { initial: new Map([['x', null]]) })).toMatchObject({
      status: 'PASS', witnesses: [{ key: 'x', order: ['x'] }, { key: 'y', order: ['y'] }],
    });
    expect(checkLinearizable(history, { initial })).toMatchObject({ status: 'FAIL', counterexample: { key: 'x' } });
  });

  it('reports incomplete records and bounded searches separately from failure', () => {
    expect(checkLinearizable([{ ...registerFixture(false)[0], responseNs: undefined }], { initial }))
      .toMatchObject({ status: 'INCONCLUSIVE', reason: 'Incomplete call: put-a' });
    expect(checkLinearizable(registerFixture(true), { initial, maxStates: 1 }))
      .toMatchObject({ status: 'INCONCLUSIVE', states: 1 });
  });
});

describe('transaction verification', () => {
  it('finds a concrete three-edge WW/WR/RW cycle including an initially absent version', () => {
    expect(buildDependencyGraph(mixedCycleFixture)).toMatchObject({
      status: 'FAIL', cycle: [
        { kind: 'WR', from: 't1', to: 't2', key: 'x', observedVersionId: 'x1' },
        { kind: 'WW', from: 't2', to: 't3', key: 'y', priorVersionId: 'y2', nextVersionId: 'y3' },
        { kind: 'RW', from: 't3', to: 't1', key: 'z', observedVersionId: null, nextVersionId: 'z1' },
      ],
    });
  });

  it('uses committed tombstones and final writes while ignoring private and aborted versions', () => {
    const t1 = committed('t1', 1, [
      write('x', 'intermediate', { tombstone: false, value: 1 }),
      read('x', 0, 'intermediate', { found: true, value: 1 }, 'own'),
      write('x', 'tombstone', { tombstone: true }),
    ]);
    const t2 = committed('t2', 2, [read('x', 1, 'tombstone', { found: false })]);
    const t3 = committed('t3', 3, [write('x', 'revived', { tombstone: false, value: null })]);
    const aborted = { ...committed('t4', 4, [write('x', 'aborted', { tombstone: false, value: 4 })]), status: 'aborted' } as const;
    expect(buildDependencyGraph([t3, t2, t1, aborted])).toMatchObject({
      status: 'PASS', nodes: ['t1', 't2', 't3'], edges: [
        { kind: 'WW', priorVersionId: 'tombstone', nextVersionId: 'revived' },
        { kind: 'WR', observedVersionId: 'tombstone', to: 't2' },
        { kind: 'RW', observedVersionId: 'tombstone', nextVersionId: 'revived', from: 't2' },
      ],
    });
    expect(buildDependencyGraph([t1, committed('t2', 2, [read('x', 1, 'aborted', { found: false })]), aborted]))
      .toMatchObject({ status: 'INCONCLUSIVE' });
  });

  it('returns inconclusive for an incomplete commit prefix or a conflicting read result', () => {
    expect(buildDependencyGraph(mixedCycleFixture.slice(1))).toMatchObject({ status: 'INCONCLUSIVE' });
    expect(buildDependencyGraph([
      mixedCycleFixture[0], committed('t2', 2, [read('x', 1, 'x1', { found: true, value: false })]),
    ])).toMatchObject({ status: 'INCONCLUSIVE' });
  });

  it('checks each atomic commit and reports the first violation even if a later commit repairs it', () => {
    const seed = committed('seed', 1, [write('a', 'a1', { tombstone: false, value: true })]);
    const swap = committed('swap', 2, [write('a', 'a2', { tombstone: false, value: false }), write('b', 'b2', { tombstone: false, value: true })]);
    const remove = committed('remove', 3, [read('b', 2, 'b2', { found: true, value: true }), write('b', 'b3', { tombstone: true })]);
    const restore = committed('restore', 4, [write('a', 'a4', { tombstone: false, value: true })]);
    const history = [seed, swap, remove, restore];
    expect(checkOnCall(history, ['a', 'b'], 1, 2)).toEqual({ status: 'PASS', checked: 2 });
    expect(checkOnCall(history, ['a', 'b'], 1)).toMatchObject({
      status: 'FAIL', checked: 3,
      violation: {
        txnId: 'remove', commitSeq: 3, actual: 0, required: 1,
        observed: [{ key: 'a', version: { id: 'a2' } }, { key: 'b', version: { id: 'b3' } }],
        related: [{ txnId: 'swap' }, { txnId: 'remove', reads: [{ observedVersionId: 'b2' }] }],
      },
    });
    expect(checkOnCall(history, ['a', 'b'], 4)).toEqual({ status: 'PASS', checked: 1 });
    expect(checkOnCall(history.slice(1), ['a', 'b'], 2)).toMatchObject({ status: 'INCONCLUSIVE' });
  });
});
