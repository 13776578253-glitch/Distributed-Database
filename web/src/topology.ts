/** Derives display slots from the current sample, keyed by actual node ID. */
import type { RaftStatus } from '../../src/contracts/observation.ts';

const slots = [
  { x: 50, y: 15 },
  { x: 22, y: 47 },
  { x: 78, y: 47 },
  { x: 31, y: 79 },
  { x: 69, y: 79 },
];
const waitingSlots = [{ x: 50, y: 47 }, { x: 17, y: 47 }, { x: 83, y: 47 }, slots[3], slots[4]];

export function placeMembers(members: readonly string[], statuses: readonly RaftStatus[]) {
  const term = Math.max(...statuses.map(status => status.term));
  const leaders = statuses.filter(status => status.role === 'leader' && status.term === term);
  // 最高观测任期只有一个节点自报 Leader 时才占据顶部。
  const leader = leaders.length === 1 ? leaders[0] : undefined;
  const order = leader ? [leader.nodeId, ...members.filter(id => id !== leader.nodeId)] : members;
  const layout = members.length === 6
    ? [leader ? slots[0] : { x: 50, y: 43 }, { x: 21, y: 43 }, { x: 79, y: 43 },
      { x: 21, y: 78 }, { x: 50, y: 78 }, { x: 79, y: 78 }]
    : leader ? slots : waitingSlots;
  return { leader, points: new Map(order.map((id, index) => [id, layout[index]])) };
}
