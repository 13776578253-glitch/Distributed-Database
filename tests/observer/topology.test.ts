/** Checks topology promotion using sampled Raft roles and terms. */
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

it('moves the observed replacement to the top while retaining every member', () => {
  const initial = placeMembers(nodeIds, [status('raft-5', 1, 'leader')]);
  const replacement = placeMembers(nodeIds, [status('raft-2', 2, 'leader')]);

  expect(initial.leader?.nodeId).toBe('raft-5');
  expect(replacement.leader?.nodeId).toBe('raft-2');
  expect(replacement.points.get('raft-2')).toEqual(initial.points.get('raft-5'));
  expect(replacement.points.get('raft-5')).not.toEqual(replacement.points.get('raft-2'));
  expect([...replacement.points.keys()].sort()).toEqual(nodeIds);
});

it('does not choose a Leader from stale or ambiguous claims', () => {
  const pending = placeMembers(nodeIds, [status('raft-5', 1, 'leader'), status('raft-2', 2, 'candidate')]);
  expect(pending.leader).toBeUndefined();
  expect([...pending.points.values()].every(point => point.y > 15)).toBe(true);
  expect(placeMembers(nodeIds, [status('raft-5', 2, 'leader'), status('raft-2', 2, 'leader')]).leader)
    .toBeUndefined();
});
