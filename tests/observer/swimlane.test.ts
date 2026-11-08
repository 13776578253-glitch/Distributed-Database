/** Checks the pure timeline projections used by the swimlane view. */
import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../src/contracts/console.ts';
import {
  applyFaultWindows, deriveLanes, faultWindows, groupReplication, isRpcEvent, liveExtent, roleSegments,
  rpcAccepted, timeExtent, timeTicks,
} from '../../web/src/swimlane.ts';

const event = (id: string, at: string, kind: string, nodes: string[], extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, at, kind, nodes, label: kind, raw: {}, ...extra,
});
const t0 = '2026-11-07T12:00:00.000Z';
const t1 = '2026-11-07T12:00:01.000Z';
const t2 = '2026-11-07T12:00:02.000Z';
const t3 = '2026-11-07T12:00:03.000Z';
const t4 = '2026-11-07T12:00:04.000Z';

describe('timeline swimlanes', () => {
  it('orders lanes naturally and deduplicates nodes', () => {
    expect(deriveLanes([
      event('1', t0, 'x', ['raft-10', 'raft-2']),
      event('2', t1, 'x', ['raft-2', 'raft-1']),
    ])).toEqual(['raft-1', 'raft-2', 'raft-10']);
  });

  it('builds role segments from live role events, status snapshots and seeded state', () => {
    const events = [
      event('1', t0, 'raft.role', ['raft-1'], { term: 1, raw: { role: 'leader' } }),
      event('2', t1, 'raft.status', ['raft-2'], {
        raw: { details: { nodes: [{ nodeId: 'raft-2', role: 'follower', term: 1 }] } },
      }),
      event('3', t2, 'raft.role', ['raft-1'], { term: 2, raw: { role: 'follower' } }),
    ];
    const segments = roleSegments(events, ['raft-1', 'raft-2', 'raft-3'],
      [Date.parse(t0), Date.parse(t3)],
      [{ nodeId: 'raft-3', role: 'follower', term: 5 }]);

    expect(segments.filter(segment => segment.nodeId === 'raft-1')).toMatchObject([
      { role: 'leader', term: 1, start: Date.parse(t0), end: Date.parse(t2) },
      { role: 'follower', term: 2, start: Date.parse(t2), end: Date.parse(t3) },
    ]);
    expect(segments.filter(segment => segment.nodeId === 'raft-2').map(segment => segment.role))
      .toEqual(['unknown', 'follower']);
    expect(segments.filter(segment => segment.nodeId === 'raft-3')).toMatchObject([
      { role: 'follower', term: 5, start: Date.parse(t0), end: Date.parse(t3) },
    ]);
  });

  it('merges repeated status samples with the same role and term', () => {
    const sample = (id: string, at: string) => event(id, at, 'raft.status', ['raft-1'], {
      raw: { details: { nodes: [{ nodeId: 'raft-1', role: 'follower', term: 2 }] } },
    });
    const segments = roleSegments([sample('1', t1), sample('2', t2)], ['raft-1'],
      [Date.parse(t0), Date.parse(t3)]);
    expect(segments.map(segment => segment.role)).toEqual(['unknown', 'follower']);
    expect(segments[1]).toMatchObject({ start: Date.parse(t1), end: Date.parse(t3) });
  });

  it('keeps kill and isolation windows open until recovery', () => {
    const events = [
      event('1', t1, 'fault.kill', ['raft-1']),
      event('2', t2, 'fault.links', ['raft-1', 'raft-2'], {
        raw: { details: { blockedPeers: ['raft-2'] } },
      }),
      event('3', t3, 'fault.links', ['raft-1'], { raw: { details: { blockedPeers: [] } } }),
    ];
    const windows = faultWindows(events, [Date.parse(t0), Date.parse(t4)]);
    expect(windows).toContainEqual({
      nodeId: 'raft-1', start: Date.parse(t1), end: Date.parse(t4), kind: 'down', label: '节点终止',
    });
    expect(windows).toContainEqual({
      nodeId: 'raft-1', start: Date.parse(t2), end: Date.parse(t3), kind: 'isolated', label: '隔离 raft-2',
    });
  });

  it('replaces role state inside and after a down window until a new sample', () => {
    const leader = [{
      nodeId: 'raft-1', start: Date.parse(t0), end: Date.parse(t4), role: 'leader' as const, term: 2,
      eventId: 'role-1',
    }];
    const windows = [
      { nodeId: 'raft-1', start: Date.parse(t1), end: Date.parse(t2), kind: 'down' as const, label: '节点终止' },
      { nodeId: 'raft-1', start: Date.parse(t3), end: Date.parse(t4), kind: 'isolated' as const, label: '隔离 raft-2' },
    ];
    expect(applyFaultWindows(leader, windows)).toEqual([
      {
        nodeId: 'raft-1', start: Date.parse(t0), end: Date.parse(t1), role: 'leader', term: 2,
        fault: undefined, eventId: 'role-1',
      },
      {
        nodeId: 'raft-1', start: Date.parse(t1), end: Date.parse(t2), role: 'unknown', term: 2,
        fault: 'down', eventId: undefined,
      },
      {
        nodeId: 'raft-1', start: Date.parse(t2), end: Date.parse(t3), role: 'unknown', term: 2,
        fault: undefined, eventId: undefined,
      },
      {
        nodeId: 'raft-1', start: Date.parse(t3), end: Date.parse(t4), role: 'unknown', term: 2,
        fault: 'isolated', eventId: undefined,
      },
    ]);
  });

  it('groups append events into one logical replication and keeps the latest reply per follower', () => {
    const append = (id: string, at: string, to: string, accepted: boolean) => event(id, at, 'append', ['raft-1', to], {
      term: 4,
      indexes: [9, 9],
      label: `AppendEntries · demo/s/k1 · ${accepted ? '接受' : '拒绝'}`,
      entries: [{ index: 9, key: 'demo/s/k1', value: 7 }],
    });
    const groups = groupReplication([
      append('1', t0, 'raft-2', true),
      append('2', t1, 'raft-3', false),
      append('3', t2, 'raft-2', true),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      from: 'raft-1', term: 4, indexes: [9, 9], accepted: ['raft-2'], rejected: ['raft-3'],
    });
    expect(groups[0].events).toHaveLength(3);
    expect(groups[0].replies).toEqual([
      { nodeId: 'raft-2', accepted: true, at: t2 },
      { nodeId: 'raft-3', accepted: false, at: t1 },
    ]);
  });

  it('classifies RPC direction and reply outcome', () => {
    const accepted = event('1', t0, 'append', ['raft-1', 'raft-2'], { label: 'AppendEntries · 接受' });
    const rejected = event('2', t1, 'vote', ['raft-2', 'raft-1'], {
      label: 'RequestVote', raw: { reply: { granted: false } },
    });
    expect(isRpcEvent(accepted)).toBe(true);
    expect(rpcAccepted(accepted)).toBe(true);
    expect(rpcAccepted(rejected)).toBe(false);
    expect(isRpcEvent(event('3', t2, 'append', ['raft-1']))).toBe(false);
  });

  it('scales a live window and emits aligned ticks', () => {
    const now = Date.parse('2026-11-07T12:00:10.000Z');
    expect(liveExtent([], 30000, now)).toEqual([now - 30000, now]);
    expect(liveExtent([event('1', t3, 'x', ['raft-1'])], 30000, now)).toEqual([now - 30000, now]);
    expect(timeTicks(0, 60000, 6)).toEqual([0, 10000, 20000, 30000, 40000, 50000, 60000]);
    expect(timeExtent([event('1', t0, 'x', ['raft-1'])])).toEqual([Date.parse(t0), Date.parse(t0) + 1000]);
  });
});
