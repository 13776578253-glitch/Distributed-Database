/** Command-line console for the isolated Raft membership lab. */
import { docker, labName, labNodeIds, membershipLab, nodeUrl } from './docker.ts';
import { acquireProjectLock } from './cluster-lock.ts';
import { readComposeConfig } from './console-cluster.ts';
import { proposeMembership, statuses } from './raft-client.ts';

/** 在调用方持有项目锁期间，向当前唯一就绪的 Leader 提交成员提案。 */
export async function setVoters(voters: string[], runDocker = (args: string[]) => docker(args, () => {})) {
  const nodes = await statuses();
  const leaders = nodes.filter(node => node.ready);
  if (leaders.length !== 1) throw new Error('Wait for a unique ready leader');
  const { nodeId } = leaders[0];
  const published = runDocker(['compose', 'port', nodeId, '8080']);
  if (published !== new URL(nodeUrl(labNodeIds.indexOf(nodeId))).host) {
    throw new Error('The ready leader is not on the selected Compose port');
  }
  return { nodeId, ...await proposeMembership(nodeId, voters) };
}

if (import.meta.main) {
  const [command, ...voters] = process.argv.slice(2);
  const project = readComposeConfig().name;
  if (!membershipLab || labName === 'minidb-lab' || project === 'minidb-lab') {
    throw new Error('Select an isolated membership lab first');
  }
  if (command === 'status') {
    const nodes = await statuses();
    console.log(JSON.stringify(nodes.map(({ nodeId, role, term, voter, membership, appliedMembership }) =>
      ({ nodeId, role, term, voter, membership, appliedMembership })), null, 2));
  } else if (command === 'set' && voters.length) {
    const lease = acquireProjectLock(project, 'experiment');
    try {
      const proposal = await setVoters(voters);
      console.log(JSON.stringify(proposal));
      if (proposal.httpStatus !== 202) process.exitCode = 1;
    } finally {
      lease.release();
    }
  } else {
    throw new Error('Usage: pnpm membership status | pnpm membership set <voter>...');
  }
}
