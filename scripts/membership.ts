/** Command-line console for the isolated Raft membership lab. */
import { docker, labName, labNodeIds, membershipLab, nodeUrl } from './docker.ts';
import { proposeMembership, statuses } from './raft-client.ts';

const [command, ...voters] = process.argv.slice(2);
if (!membershipLab || labName === 'minidb-lab') throw new Error('Select an isolated membership lab first');
if (command !== 'status' && (command !== 'set' || voters.length === 0)) {
  throw new Error('Usage: pnpm membership status | pnpm membership set <voter>...');
}

const nodes = await statuses();
if (command === 'status') {
  console.log(JSON.stringify(nodes.map(({ nodeId, role, term, voter, membership, appliedMembership }) =>
    ({ nodeId, role, term, voter, membership, appliedMembership })), null, 2));
} else {
  const leaders = nodes.filter(node => node.ready);
  if (leaders.length !== 1) throw new Error('Wait for a unique ready leader');
  const { nodeId } = leaders[0];
  const published = docker(['compose', 'port', nodeId, '8080'], () => {});
  if (published !== new URL(nodeUrl(labNodeIds.indexOf(nodeId))).host) {
    throw new Error('The ready leader is not on the selected Compose port');
  }
  const proposal = await proposeMembership(nodeId, voters);
  console.log(JSON.stringify({ nodeId, ...proposal }));
  if (proposal.httpStatus !== 202) process.exitCode = 1;
}
