/** Reproducible V01 and V02 input histories with known outcomes. */
import type { ClientHistory } from '../src/contracts/history.ts';
import type { CommittedTransaction, TransactionRead, TransactionWrite } from '../src/contracts/transaction.ts';

export function call(
  operationId: string, operation: ClientHistory['operation'], invocationNs: string,
  responseNs: string | undefined, result?: ClientHistory['result'],
): ClientHistory {
  return {
    runId: 'fixture', engine: 'raft', clientId: operationId, operationId,
    operation, invocationNs, responseNs, result, outcome: result ? 'ok' : 'unknown',
  };
}

export function registerFixture(negative: boolean): ClientHistory[] {
  return [
    call('put-a', { type: 'put', key: 'x', value: 'a' }, '1', '5', { stored: true }),
    call('put-b', { type: 'put', key: 'x', value: 'b' }, '2', '6', { stored: true }),
    call('read-first', { type: 'get', key: 'x' }, '7', '8', { found: true, value: 'a' }),
    call('read-second', { type: 'get', key: 'x' }, '9', '10', { found: true, value: negative ? 'b' : 'a' }),
  ];
}

export function write(key: string, createdVersionId: string, data: TransactionWrite['data']): TransactionWrite {
  return { kind: 'write', key, createdVersionId, data };
}

export function read(
  key: string, viewSeq: number, observedVersionId: string | null, result: TransactionRead['result'],
  source: TransactionRead['source'] = observedVersionId === null ? 'absent' : 'committed',
): TransactionRead {
  return { kind: 'read', key, viewSeq, source, observedVersionId, result };
}

export function committed(txnId: string, commitSeq: number, accesses: CommittedTransaction['accesses']): CommittedTransaction {
  return { txnId, status: 'committed', isolation: 'RC', snapshotSeq: null, commitSeq, accesses };
}

export const mixedCycleFixture = [
  committed('t1', 1, [write('x', 'x1', { tombstone: false, value: true }), write('z', 'z1', { tombstone: false, value: true })]),
  committed('t2', 2, [read('x', 1, 'x1', { found: true, value: true }), write('y', 'y2', { tombstone: false, value: true })]),
  committed('t3', 3, [read('z', 0, null, { found: false }), write('y', 'y3', { tombstone: false, value: false })]),
];
