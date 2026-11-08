/** Derives fixed display slots from the member list, keyed by actual node ID. */
import type { RaftStatus } from '../../src/contracts/observation.ts';

const slots = [
  { x: 50, y: 15 },
  { x: 22, y: 47 },
  { x: 78, y: 47 },
  { x: 31, y: 79 },
  { x: 69, y: 79 },
];
const sixSlots = [
  { x: 50, y: 15 }, { x: 21, y: 43 }, { x: 79, y: 43 },
  { x: 21, y: 78 }, { x: 50, y: 78 }, { x: 79, y: 78 },
];

export function placeMembers(members: readonly string[], statuses: readonly RaftStatus[]) {
  const term = Math.max(...statuses.map(status => status.term));
  const leaders = statuses.filter(status => status.role === 'leader' && status.term === term);
  // 最高观测任期只有一个节点自报 Leader 时才确认，但槽位始终按成员顺序固定。
  const leader = leaders.length === 1 ? leaders[0] : undefined;
  const layout = members.length === 6 ? sixSlots : slots;
  return { leader, points: new Map(members.map((id, index) => [id, layout[index]])) };
}
