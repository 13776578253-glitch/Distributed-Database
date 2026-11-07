/** Runs membership changes and recovery against a provisioned six-node Compose lab. */
import { labNodeIds, nodeIds, nodeUrl, standbyId } from './docker.ts';
import type { openEvidence } from './evidence.ts';
import { setVoters } from './membership.ts';
import { proposeMembership } from './raft-client.ts';
import type { raftClient } from './raft-client.ts';

type Evidence = ReturnType<typeof openEvidence>;
type Client = ReturnType<typeof raftClient>;
type RunDocker = (args: string[]) => string;

function sameVoters(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every(id => right.includes(id));
}

export async function membershipExperiment(evidence: Evidence, client: Client, runDocker: RunDocker) {
  for (const [index, id] of labNodeIds.entries()) {
    const published = runDocker(['compose', 'port', id, '8080']);
    evidence.assert(`${id} belongs to the selected lab`, published === new URL(nodeUrl(index)).host, { published });
  }
  const initial = await client.converged();
  const standby = initial.find(node => node.nodeId === standbyId)!;
  const old = initial.find(node => node.ready)!;
  evidence.assert('standby is caught up and is not a voter',
    !standby.voter && standby.lastApplied === old.commitIndex
    && sameVoters(old.appliedMembership.configuration.voters, nodeIds), { standby, old });
  const key = `E4B/${evidence.runId}`;
  const saved = await client.call(old.nodeId, 'before-change', { type: 'put', key, value: 'committed' });
  evidence.assert('baseline write acknowledged', saved.outcome === 'ok', saved);
  await client.converged();

  const side = [old.nodeId, ...nodeIds.filter(id => id !== old.nodeId).slice(0, 2)];
  const other = labNodeIds.filter(id => !side.includes(id));
  let stopped: string | undefined;
  let partitioned = true;
  async function heal() {
    const results = await Promise.allSettled(labNodeIds.filter(id => id !== stopped).map(id => client.block(id, [])));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'restoring membership lab links failed');
    partitioned = false;
  }

  try {
    for (const id of labNodeIds) await client.block(id, side.includes(id) ? other : side);
    const join = await proposeMembership(old.nodeId, labNodeIds);
    evidence.assert('join proposal accepted', join.httpStatus === 202 && join.reply.ok, join);
    if (!join.reply.ok) throw new Error(join.reply.error);
    const jointIndex = join.reply.jointIndex;
    const replicated = await client.waitFor('old majority replicated the uncommitted joint entry', nodes =>
      side.every(id => nodes.some(node => node.nodeId === id && node.membership.index === jointIndex
        && node.membership.configuration.next?.includes(standbyId) && node.commitIndex < jointIndex)));
    evidence.event('fault.kill', { nodeId: old.nodeId, jointIndex, replicated });
    const container = runDocker(['compose', 'ps', '-q', old.nodeId]);
    runDocker(['compose', 'kill', '-s', 'SIGKILL', old.nodeId]);
    stopped = old.nodeId;
    const exit = runDocker(['inspect', container, '--format', '{{.State.ExitCode}}']);
    evidence.assert('leader killed before joint commit', exit === '137', { exit, jointIndex, side, other });
    await heal();

    const progress = await client.waitFor('new leader finalizes the inherited joint configuration', nodes => nodes.some(node =>
      node.ready && node.term > old.term && node.appliedMembership.index > jointIndex
      && !node.appliedMembership.configuration.next
      && sameVoters(node.appliedMembership.configuration.voters, labNodeIds)));
    const next = progress.find(node => node.ready)!;
    evidence.assert('join committed without restarting the killed leader', progress.every(node => node.nodeId !== stopped),
      { jointIndex, newLeader: next });
    const read = await client.call(next.nodeId, 'after-change-crash', { type: 'get', key });
    evidence.assert('new leader retains acknowledged value', read.outcome === 'ok' && read.result !== undefined
      && 'found' in read.result && read.result.found && read.result.value === 'committed', read);
  } finally {
    try {
      if (partitioned) await heal();
    } finally {
      if (stopped) {
        evidence.event('fault.restart', { nodeId: stopped });
        runDocker(['compose', 'start', stopped]);
      }
    }
  }

  const joined = await client.converged();
  evidence.assert('six voters agree after join and restart', joined.every(node =>
    node.voter && sameVoters(node.appliedMembership.configuration.voters, labNodeIds)), joined);
  const remove = joined.find(node => node.ready)!;
  const reduced = labNodeIds.filter(id => id !== remove.nodeId);
  // 复用 CLI 的成员变更入口，沿用本次实验已经持有的项目锁。
  const consoleReply = await setVoters(reduced, runDocker);
  evidence.assert('membership command accepted removal on the leader being removed',
    consoleReply.nodeId === remove.nodeId && consoleReply.httpStatus === 202, { consoleReply, removed: remove.nodeId });

  const removed = await client.waitFor('removed leader steps down and final config is applied', nodes =>
    nodes.length === labNodeIds.length && nodes.filter(node => node.ready).length === 1
    && nodes.every(node => !node.appliedMembership.configuration.next
      && sameVoters(node.appliedMembership.configuration.voters, reduced)
      && (node.nodeId !== remove.nodeId || (!node.voter && node.role === 'follower'))));
  const exLeader = removed.find(node => node.nodeId === remove.nodeId)!;
  const [write, read] = await Promise.all([
    client.call(exLeader.nodeId, 'removed-write', { type: 'put', key, value: 'forbidden' }),
    client.call(exLeader.nodeId, 'removed-read', { type: 'get', key }, 'safe-follower'),
  ]);
  evidence.assert('removed leader rejects consistent reads and writes', write.errorCode === 'NOT_LEADER'
    && read.errorCode === 'NOT_VOTER' && write.httpStatus === 409 && read.httpStatus === 409, { write, read });
  const snapshot = await client.compact(exLeader.nodeId);
  evidence.assert('removed node compacts through the final configuration',
    snapshot.compacted && snapshot.snapshotIndex >= exLeader.appliedMembership.index, snapshot);
  runDocker(['compose', 'restart', exLeader.nodeId]);
  const healed = await client.converged();
  const restored = healed.find(node => node.nodeId === exLeader.nodeId)!;
  evidence.assert('restart restores removed membership from snapshot', !restored.voter
    && restored.role === 'follower' && restored.snapshotIndex === snapshot.snapshotIndex
    && restored.appliedMembership.index === exLeader.appliedMembership.index, restored);
  const next = healed.find(node => node.ready)!;
  const after = await client.call(next.nodeId, 'after-removal', { type: 'put', key: `${key}/after`, value: 'healthy' });
  evidence.assert('remaining voters continue committing writes', after.outcome === 'ok', after);

  // 恢复初始投票集，保留六个数据卷，下一轮可从同一集群复跑。
  if (!sameVoters(reduced, nodeIds)) {
    await client.converged();
    const leader = await client.leader();
    const restore = await proposeMembership(leader.nodeId, nodeIds);
    evidence.assert('restore bootstrap voter set accepted', restore.httpStatus === 202 && restore.reply.ok, restore);
  }
  const final = await client.waitFor('bootstrap voter set restored', nodes => nodes.length === labNodeIds.length
    && nodes.every(node => !node.appliedMembership.configuration.next
      && sameVoters(node.appliedMembership.configuration.voters, nodeIds)));
  evidence.event('membership.restored', final);
}
