/** Checks the demo workload's plan, leader resolution and request loop. */
import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../src/contracts/console.ts';
import type { ClusterObservation, NodeObservation } from '../../src/contracts/observation.ts';
import {
  classifyReply, createWorkload, latencyPercentile, parseWorkloadAction, pickLeader, planOperation,
} from '../../src/observer/workload.ts';
import type { DemoPlan } from '../../src/observer/workload.ts';
import type { WorkloadRequest } from '../../src/observer/workload.ts';

const observedAt = '2026-11-07T12:00:00.000Z';
const leaderStatus = {
  nodeId: 'raft-1', role: 'leader' as const, term: 3, leader: 'raft-1',
  commitIndex: 10, lastApplied: 10, logLength: 10, ready: true,
  committedDigest: '0'.repeat(64),
};
const leaderObservation: ClusterObservation = {
  sampledAt: observedAt,
  nodes: [{ nodeId: 'raft-1', ok: true, observedAt, status: leaderStatus }],
};
const node = (nodeId: string, role: 'leader' | 'follower', term: number): NodeObservation => ({
  nodeId,
  ok: true,
  observedAt,
  status: { ...leaderStatus, nodeId, role, term, leader: role === 'leader' ? nodeId : 'raft-1' },
});

describe('demo workload', () => {
  it('accepts only the supported rates and actions', () => {
    expect(parseWorkloadAction({ action: 'start', rate: 2 })).toEqual({ action: 'start', rate: 2 });
    expect(parseWorkloadAction({ action: 'stop' })).toEqual({ action: 'stop' });
    expect(parseWorkloadAction({ action: 'start', rate: 3 })).toBeUndefined();
    expect(parseWorkloadAction({ action: 'start', rate: '2' })).toBeUndefined();
    expect(parseWorkloadAction(null)).toBeUndefined();
  });

  it('plans puts, reads and deletes over a bounded demo key set', () => {
    expect(planOperation('s', 0)).toEqual({ seq: 0, op: 'put', key: 'demo/s/k0' });
    expect(planOperation('s', 4)).toEqual({ seq: 4, op: 'get', key: 'demo/s/k4' });
    expect(planOperation('s', 11)).toEqual({ seq: 11, op: 'delete', key: 'demo/s/k11' });
    expect(planOperation('s', 12)).toEqual({ seq: 12, op: 'put', key: 'demo/s/k0' });
  });

  it('computes latency percentiles from a bounded sample', () => {
    expect(latencyPercentile([], 50)).toBeUndefined();
    expect(latencyPercentile([30, 10, 20], 50)).toBe(20);
    expect(latencyPercentile([10, 20, 30], 95)).toBe(30);
  });

  it('requires a unique leader at the highest observed term across all valid nodes', () => {
    expect(pickLeader([node('raft-1', 'follower', 3), node('raft-2', 'leader', 4)])).toBe('raft-2');
    expect(pickLeader([node('raft-1', 'leader', 3), node('raft-2', 'follower', 4)])).toBeUndefined();
    expect(pickLeader([node('raft-1', 'leader', 3), node('raft-2', 'follower', 4), node('raft-3', 'leader', 4)]))
      .toBe('raft-3');
    expect(pickLeader([node('raft-1', 'leader', 3), node('raft-2', 'leader', 3)])).toBeUndefined();
    expect(pickLeader([node('raft-1', 'follower', 3)])).toBeUndefined();
  });

  it('classifies nested Raft ClientReply results for get, put and delete', () => {
    const reply = (ok: boolean, status: number, body: unknown) => ({
      ok, status, json: async () => body,
    });
    const plan = (op: DemoPlan['op']): DemoPlan => ({ seq: 0, op, key: 'demo/s/k1' });
    const classify = (op: DemoPlan['op'], ok: boolean, status: number, body: unknown) =>
      classifyReply(plan(op), reply(ok, status, body), body);

    expect(classify('get', true, 200, { ok: true, result: { found: true, value: 1 } }))
      .toMatchObject({ ok: true, outcome: 'found' });
    expect(classify('get', true, 200, { ok: true, result: { found: false } }))
      .toMatchObject({ ok: true, outcome: 'absent' });
    expect(classify('put', true, 200, { ok: true, result: { stored: true } }))
      .toMatchObject({ ok: true, outcome: 'stored' });
    expect(classify('delete', true, 200, { ok: true, result: { deleted: true } }))
      .toMatchObject({ ok: true, outcome: 'deleted' });
    expect(classify('delete', true, 200, { ok: true, result: { deleted: false } }))
      .toMatchObject({ ok: true, outcome: 'absent' });
    expect(classify('put', true, 200, { ok: true }))
      .toMatchObject({ ok: false, outcome: 'INVALID_RESULT' });
    expect(classify('put', false, 409, { ok: false, error: 'NOT_LEADER' }))
      .toMatchObject({ ok: false, outcome: 'NOT_LEADER', retry: true });
    expect(classify('put', false, 504, { ok: false, error: 'UNKNOWN_OUTCOME' }))
      .toMatchObject({ ok: false, outcome: 'UNKNOWN_OUTCOME', retry: false, uncertain: true });
  });

  it('runs one operation and publishes request and response events', async () => {
    let clock = Date.parse('2026-11-07T12:00:00.000Z');
    const calls: string[] = [];
    const bodies: string[] = [];
    const events: Omit<TimelineEvent, 'id'>[] = [];
    const request: WorkloadRequest = async (url, init) => {
      calls.push(url);
      if (init.body) bodies.push(init.body);
      clock += 7;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { stored: true } }) };
    };
    const workload = createWorkload({
      targets: [{ nodeId: 'raft-1', address: 'http://leader' }],
      readStatuses: async () => leaderObservation,
      publish: event => events.push(event),
      shouldPause: () => false,
      request,
      now: () => clock,
      timer: () => 0,
      clearTimer: () => {},
    });

    workload.start(2);
    await workload.runOnce();

    expect(workload.status()).toMatchObject({
      running: true, paused: false, rate: 2, leader: 'raft-1',
      operations: 1, successes: 1, failures: 0,
      lastOutcome: 'stored', lastLatencyMs: 7, p50LatencyMs: 7,
    });
    expect(calls).toEqual(['http://leader/kv/put']);
    const put = JSON.parse(bodies[0]) as { key: string; value: number };
    expect(put.value).toBe(0);
    expect(put.key).toMatch(/^demo\/demo-[^/]+\/k0$/);
    expect(events.map(event => event.kind)).toEqual(['demo.start', 'demo.request', 'demo.response']);
    expect(events[2].label).toContain('PUT 200 · 7ms');
    workload.close();
  });

  it('does not issue requests while an experiment holds the console', async () => {
    const calls: string[] = [];
    const workload = createWorkload({
      targets: [{ nodeId: 'raft-1', address: 'http://leader' }],
      readStatuses: async () => leaderObservation,
      publish: () => {},
      shouldPause: () => true,
      request: async url => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({}) };
      },
      now: () => Date.parse('2026-11-07T12:00:00.000Z'),
      timer: () => 0,
      clearTimer: () => {},
    });

    workload.start(1);
    await workload.runOnce();

    expect(workload.status()).toMatchObject({
      running: true, paused: true, pausedReason: 'experiment', operations: 0,
    });
    expect(calls).toEqual([]);
    workload.close();
  });

  it('refreshes the leader and retries once after NOT_LEADER', async () => {
    let attempt = 0;
    const calls: string[] = [];
    const request: WorkloadRequest = async url => {
      calls.push(url);
      attempt++;
      if (attempt === 1) {
        return { ok: false, status: 409, json: async () => ({ ok: false, error: 'NOT_LEADER' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { stored: true } }) };
    };
    const workload = createWorkload({
      targets: [{ nodeId: 'raft-1', address: 'http://leader' }],
      readStatuses: async () => leaderObservation,
      publish: () => {},
      shouldPause: () => false,
      request,
      now: () => Date.parse('2026-11-07T12:00:00.000Z'),
      timer: () => 0,
      clearTimer: () => {},
    });

    workload.start(2);
    await workload.runOnce();

    expect(calls).toEqual(['http://leader/kv/put', 'http://leader/kv/put']);
    expect(workload.status()).toMatchObject({
      operations: 1, successes: 1, failures: 0, lastOutcome: 'stored',
    });
    workload.close();
  });

  it('publishes an explicit error event when no Leader can be selected', async () => {
    const events: Omit<TimelineEvent, 'id'>[] = [];
    const workload = createWorkload({
      targets: [{ nodeId: 'raft-1', address: 'http://leader' }],
      readStatuses: async () => ({ sampledAt: observedAt, nodes: [node('raft-1', 'follower', 4)] }),
      publish: event => events.push(event),
      shouldPause: () => false,
      request: async () => { throw new Error('should not request without a leader'); },
      now: () => Date.parse('2026-11-07T12:00:00.000Z'),
      timer: () => 0,
      clearTimer: () => {},
    });

    workload.start(2);
    await workload.runOnce();

    expect(workload.status()).toMatchObject({ operations: 1, failures: 1, unknown: 0, lastOutcome: 'NO_LEADER' });
    expect(events.map(event => event.kind)).toEqual(['demo.start', 'demo.error']);
    expect(events[1]).toMatchObject({ nodes: [], raw: { error: 'NO_LEADER' } });
    workload.close();
  });

  it('keeps UNKNOWN_OUTCOME distinct from confirmed failure', async () => {
    const events: Omit<TimelineEvent, 'id'>[] = [];
    const workload = createWorkload({
      targets: [{ nodeId: 'raft-1', address: 'http://leader' }],
      readStatuses: async () => leaderObservation,
      publish: event => events.push(event),
      shouldPause: () => false,
      request: async () => ({
        ok: false, status: 504, json: async () => ({ ok: false, error: 'UNKNOWN_OUTCOME' }),
      }),
      now: () => Date.parse('2026-11-07T12:00:00.000Z'),
      timer: () => 0,
      clearTimer: () => {},
    });

    workload.start(2);
    await workload.runOnce();

    expect(workload.status()).toMatchObject({ operations: 1, successes: 0, failures: 0, unknown: 1, lastOutcome: 'UNKNOWN_OUTCOME' });
    expect(events.at(-1)).toMatchObject({ kind: 'demo.response', raw: { outcome: 'UNKNOWN_OUTCOME', status: 504 } });
    workload.close();
  });

  it('publishes connection errors, invalidates the cached leader and counts a confirmed failed attempt', async () => {
    const events: Omit<TimelineEvent, 'id'>[] = [];
    const workload = createWorkload({
      targets: [{ nodeId: 'raft-1', address: 'http://leader' }],
      readStatuses: async () => leaderObservation,
      publish: event => events.push(event),
      shouldPause: () => false,
      request: async () => { throw new Error('socket closed'); },
      now: () => Date.parse('2026-11-07T12:00:00.000Z'),
      timer: () => 0,
      clearTimer: () => {},
    });

    workload.start(2);
    await workload.runOnce();

    expect(workload.status()).toMatchObject({ operations: 1, failures: 1, unknown: 0, lastOutcome: 'socket closed', leader: undefined });
    expect(events.map(event => event.kind)).toEqual(['demo.start', 'demo.request', 'demo.error']);
    expect(events.at(-1)).toMatchObject({ kind: 'demo.error', raw: { error: 'socket closed' } });
    workload.close();
  });

  it('emits stop and cleanup events and cleans only the stopped session', async () => {
    const events: Omit<TimelineEvent, 'id'>[] = [];
    const deleted: string[] = [];
    const workload = createWorkload({
      targets: [{ nodeId: 'raft-1', address: 'http://leader' }],
      readStatuses: async () => leaderObservation,
      publish: event => events.push(event),
      shouldPause: () => false,
      request: async (url, init) => {
        if (url.endsWith('/kv/delete') && init.body) {
          deleted.push((JSON.parse(init.body) as { key: string }).key);
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { deleted: true } }) };
      },
      now: () => Date.parse('2026-11-07T12:00:00.000Z'),
      timer: () => 0,
      clearTimer: () => {},
    });

    workload.start(2);
    const stopped = workload.stop();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(stopped.running).toBe(false);
    expect(events.map(event => event.kind)).toEqual(['demo.start', 'demo.stop', 'demo.cleanup']);
    expect(events.at(-1)).toMatchObject({ kind: 'demo.cleanup', raw: { session: expect.any(String), cleaned: 12, failed: 0 } });
    expect(deleted).toHaveLength(12);
    expect(new Set(deleted.map(key => key.split('/')[1])).size).toBe(1);
    workload.close();
  });
});
