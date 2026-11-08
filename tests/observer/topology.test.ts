/** Checks fixed topology slots and Leader promotion from sampled Raft roles. */
import { expect, it } from 'vitest';
import type { RaftStatus } from '../../src/contracts/observation.ts';
import { nodeIds } from '../../src/raft/config.ts';
import { placeMembers } from '../../web/src/topology.ts';

function status(nodeId: string, term: number, role: RaftStatus['role']): RaftStatus {
  return {
    nodeId, term, role, leader: role === 'leader' ? nodeId : null,
    commitIndex: 0, lastApplied: 0, logLength: 0, ready: false, committedDigest: 'a'.repeat(64),
  };
}

it('keeps every member in a fixed slot when the observed Leader changes', () => {
  const initial = placeMembers(nodeIds, [status('raft-5', 1, 'leader')]);
  const replacement = placeMembers(nodeIds, [status('raft-2', 2, 'leader')]);

  expect(initial.leader?.nodeId).toBe('raft-5');
  expect(replacement.leader?.nodeId).toBe('raft-2');
  for (const id of nodeIds) expect(replacement.points.get(id)).toEqual(initial.points.get(id));
  expect([...replacement.points.keys()].sort()).toEqual([...nodeIds].sort());
});

it('does not choose a Leader from stale or ambiguous claims', () => {
  const fixed = placeMembers(nodeIds, []);
  const pending = placeMembers(nodeIds, [status('raft-5', 1, 'leader'), status('raft-2', 2, 'candidate')]);
  expect(pending.leader).toBeUndefined();
  for (const id of nodeIds) expect(pending.points.get(id)).toEqual(fixed.points.get(id));
  expect(placeMembers(nodeIds, [status('raft-5', 2, 'leader'), status('raft-2', 2, 'leader')]).leader)
    .toBeUndefined();
});

it('allocates fixed distinct slots to all six membership lab nodes', () => {
  const members = [...nodeIds, 'raft-6'];
  const waiting = placeMembers(members, []);
  const elected = placeMembers(members, [status('raft-6', 3, 'leader')]);
  for (const layout of [waiting, elected]) {
    const points = [...layout.points.values()];
    expect(points).toHaveLength(6);
    expect(new Set(points.map(point => `${point.x}/${point.y}`)).size).toBe(6);
  }
  for (const id of members) expect(elected.points.get(id)).toEqual(waiting.points.get(id));
});
