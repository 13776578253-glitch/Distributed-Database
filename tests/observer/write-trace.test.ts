/** Checks the evidence-backed PUT trace used by the write-focus panel. */
import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../src/contracts/console.ts';
import type { ClusterObservation } from '../../src/contracts/observation.ts';
import { deriveWriteTrace } from '../../web/src/write-trace.ts';

const t0 = '2026-11-07T12:00:00.000Z';
const t1 = '2026-11-07T12:00:00.010Z';
const t2 = '2026-11-07T12:00:00.020Z';
const t3 = '2026-11-07T12:00:00.030Z';
const t4 = '2026-11-07T12:00:03.000Z';

const event = (id: string, at: string, kind: string, nodes: string[],
  extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, at, kind, nodes, label: kind, raw: {}, ...extra,
});
const status = (nodeId: string, role: 'leader' | 'follower', commitIndex: number, lastApplied: number) => ({
  nodeId, role, term: 3, leader: 'raft-1', commitIndex, lastApplied,
  logLength: 10, ready: true, committedDigest: '0'.repeat(64),
});
const sample = (at: string, commitIndex: number, lastApplied: number): ClusterObservation => ({
  sampledAt: at,
  nodes: [
    { nodeId: 'raft-1', ok: true, observedAt: at, status: status('raft-1', 'leader', commitIndex, lastApplied) },
    { nodeId: 'raft-2', ok: true, observedAt: at, status: status('raft-2', 'follower', commitIndex, lastApplied) },
  ],
});

const request = event('1', t0, 'demo.request', ['raft-1'], {
  label: 'PUT demo/s/k1',
  raw: { session: 's', seq: 7, op: 'put', key: 'demo/s/k1' },
});
const append = (id: string, at: string, to: string, accepted: boolean) => event(id, at, 'append', ['raft-1', to], {
  term: 3,
  indexes: [9, 9],
  label: `AppendEntries · demo/s/k1 · ${accepted ? '接受' : '拒绝'}`,
  entries: [{ index: 9, key: 'demo/s/k1', value: 7 }],
});
const response = event('4', t3, 'demo.response', ['raft-1'], {
  label: 'PUT 200 · 12ms',
  raw: { session: 's', seq: 7, op: 'put', key: 'demo/s/k1', latencyMs: 12, status: 200, outcome: 'stored' },
});

describe('write trace', () => {
  it('separates request, replication, commit and apply facts', () => {
    const trace = deriveWriteTrace([
      request,
      append('2', t1, 'raft-2', true),
      append('3', t2, 'raft-3', false),
      response,
    ], response, [sample(t4, 10, 10)]);

    expect(trace).toMatchObject({
      key: 'demo/s/k1', seq: 7, outcome: 'stored', httpStatus: 200,
      index: 9, term: 3, leader: 'raft-1', accepted: ['raft-2'], rejected: ['raft-3'],
      commit: { at: t4, nodeId: 'raft-1', index: 9 },
      apply: { at: t4, nodeId: 'raft-1', index: 9 },
    });
    expect(trace?.request?.id).toBe('1');
    expect(trace?.response?.id).toBe('4');
    expect(trace?.nodes).toContainEqual({
      nodeId: 'raft-3', role: 'follower', replicated: 'rejected', applied: 'unobserved',
    });
  });

  it('keeps missing replication and status evidence explicit', () => {
    const trace = deriveWriteTrace([request, response], response, []);
    expect(trace).toMatchObject({ key: 'demo/s/k1', outcome: 'stored', index: undefined });
    expect(trace?.group).toBeUndefined();
    expect(trace?.commit).toBeUndefined();
    expect(trace?.apply).toBeUndefined();
    expect(trace?.notes.join(' ')).toContain('未找到该写入的 AppendEntries 证据');
  });

  it('resolves a trace from a selected AppendEntries row', () => {
    const selected = append('2', t1, 'raft-2', true);
    const trace = deriveWriteTrace([request, selected, response], selected, [sample(t4, 10, 10)]);
    expect(trace).toMatchObject({
      key: 'demo/s/k1', seq: 7, index: 9, groupKey: expect.any(String), outcome: 'stored',
    });
    expect(trace?.request?.id).toBe('1');
  });

  it('reports Evidence without entry-level replication as unknown', () => {
    const invoke = event('1', t0, 'client.invoke', ['raft-1'], {
      raw: { details: { operationId: '9', nodeId: 'raft-1', operation: { type: 'put', key: 'k', value: 1 } } },
    });
    const returned = event('2', t1, 'client.return', ['raft-1'], {
      raw: {
        details: {
          operationId: '9', nodeId: 'raft-1', operation: { type: 'put', key: 'k', value: 1 },
          outcome: 'ok', httpStatus: 200,
        },
      },
    });
    const trace = deriveWriteTrace([invoke, returned], returned, []);
    expect(trace).toMatchObject({
      key: 'k', outcome: 'ok', httpStatus: 200, isEvidence: true, index: undefined,
    });
    expect(trace?.request?.id).toBe('1');
    expect(trace?.response?.id).toBe('2');
    expect(trace?.notes.join(' ')).toContain('Evidence 未记录 RPC 条目');
  });
});
