/** Drives isolated-cluster acceptance for group commit and follower reads. */
import { nodeIds } from './docker.ts';
import type { openEvidence } from './evidence.ts';
import type { raftClient } from './raft-client.ts';

type Evidence = ReturnType<typeof openEvidence>;
type Client = ReturnType<typeof raftClient>;
type RunDocker = (args: string[]) => string;
type CallHistory = Awaited<ReturnType<Client['call']>>;

async function cutLinks(client: Client, minority: string[]) {
  const majority = nodeIds.filter(id => !minority.includes(id));
  for (const id of nodeIds) await client.block(id, minority.includes(id) ? majority : minority);
}

async function healLinks(client: Client, stopped: string | undefined = undefined) {
  const results = await Promise.allSettled(nodeIds.filter(id => id !== stopped).map(id => client.block(id, [])));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, 'restoring RPC links failed');
}

export async function batchExperiment(evidence: Evidence, client: Client, runDocker: RunDocker) {
  const key = `E1/${evidence.runId}`;
  const concurrent = 16;
  const count = 128;
  const leader = await client.leader();
  const beganAt = new Date().toISOString();
  const start = performance.now();
  const latencies: number[] = [];

  for (let offset = 0; offset < count; offset += concurrent) {
    const replies = await Promise.all(Array.from({ length: concurrent }, (_, i) =>
      client.call(leader.nodeId, `load-${i}`, { type: 'put', key: `${key}/${offset + i}`, value: offset + i })));
    const failed = replies.filter(reply => reply.outcome !== 'ok');
    evidence.assert(`load group ${offset / concurrent + 1} confirmed`, failed.length === 0,
      { offset, count: replies.length, failed });
    for (const reply of replies) {
      latencies.push(Number(BigInt(reply.responseNs!) - BigInt(reply.invocationNs)) / 1e6);
    }
  }
  const elapsedMs = performance.now() - start;
  latencies.sort((left, right) => left - right);
  const logs = runDocker(['compose', 'logs', '--no-color', '--since', beganAt, leader.nodeId]);
  const batches = logs.split(/\r?\n/).flatMap(line => {
    const body = line.split(/\s+\|\s+/)[1];
    return body?.includes('"kind":"raft.write.batch"') ? [JSON.parse(body).size as number] : [];
  });
  const metrics = {
    count, concurrent, elapsedMs, operationsPerSecond: count * 1000 / elapsedMs,
    p50Ms: latencies[Math.ceil(count * 0.50) - 1], p95Ms: latencies[Math.ceil(count * 0.95) - 1],
    localTransactions: batches.length, maxBatch: Math.max(...batches), batchSizes: batches,
  };
  evidence.assert('concurrent requests used fewer local transactions than entries',
    batches.reduce((sum, size) => sum + size, 0) === count && batches.length < count, metrics);

  const settled = await client.converged();
  const old = settled.find(node => node.ready)!;
  const minority = [old.nodeId, nodeIds.find(id => id !== old.nodeId)!];
  const majority = nodeIds.filter(id => !minority.includes(id));
  const pendingCount = 12;
  let stopped: string | undefined;
  try {
    await cutLinks(client, minority);
    const pending = Promise.allSettled(Array.from({ length: pendingCount }, (_, value) =>
      client.call(old.nodeId, `pending-${value}`, { type: 'put', key: `${key}/pending/${value}`, value })));
    const copied = await client.waitFor('minority has durably appended the unconfirmed batch', nodes =>
      nodes.some(node => node.nodeId === old.nodeId && node.logLength >= old.logLength + pendingCount
        && node.commitIndex === old.commitIndex));
    evidence.event('fault.kill', { nodeId: old.nodeId, signal: 'SIGKILL', status: copied });
    const container = runDocker(['compose', 'ps', '-q', old.nodeId]);
    runDocker(['compose', 'kill', '-s', 'SIGKILL', old.nodeId]);
    stopped = old.nodeId;
    const exit = runDocker(['inspect', container, '--format', '{{.State.ExitCode}}']);
    evidence.assert('batch leader stopped by SIGKILL', exit === '137', { exit });
    const replies = await pending;
    evidence.assert('all unconfirmed writes report unknown outcome',
      replies.every(reply => reply.status === 'fulfilled' && reply.value.outcome === 'unknown'), replies);
    const next = await client.leader(majority);
    const barrier = await client.call(next.nodeId, 'new-leader', { type: 'put', key: `${key}/barrier`, value: 'majority' });
    evidence.assert('majority commits after the batch crash', barrier.outcome === 'ok', barrier);
  } finally {
    try {
      await healLinks(client, stopped);
    } finally {
      if (stopped) runDocker(['compose', 'start', stopped]);
    }
  }

  const healed = await client.converged();
  const recovered = healed.find(node => node.ready)!;
  const mismatched: unknown[] = [];
  for (let offset = 0; offset < count; offset += concurrent) {
    const reads = await Promise.all(Array.from({ length: concurrent }, (_, i) =>
      client.call(recovered.nodeId, `check-${i}`, { type: 'get', key: `${key}/${offset + i}` })));
    for (const [i, read] of reads.entries()) {
      if (read.outcome !== 'ok' || !read.result || !('found' in read.result)
          || !read.result.found || read.result.value !== offset + i) mismatched.push(read);
    }
  }
  evidence.assert('all confirmed batch entries survive', mismatched.length === 0, { count, mismatched });
  const absent = await Promise.all(Array.from({ length: pendingCount }, (_, i) =>
    client.call(recovered.nodeId, `check-pending-${i}`, { type: 'get', key: `${key}/pending/${i}` })));
  evidence.assert('minority-only suffix is removed after healing',
    absent.every(read => read.outcome === 'ok' && read.result && 'found' in read.result && !read.result.found), absent);
}

function foundValue(read: CallHistory, expected: string) {
  return read.outcome === 'ok' && read.result !== undefined && 'found' in read.result
    && read.result.found && read.result.value === expected;
}

function safeValue(read: CallHistory, expected: string) {
  return foundValue(read, expected) && read.consistency === 'safe-follower'
    && read.readIndex !== undefined && read.appliedIndex !== undefined && read.appliedIndex >= read.readIndex;
}

export async function followerReadExperiment(evidence: Evidence, client: Client) {
  const key = `E2/${evidence.runId}`;
  const initial = await client.leader();
  const put = await client.call(initial.nodeId, 'before', { type: 'put', key, value: 'before' });
  evidence.assert('initial value confirmed', put.outcome === 'ok', put);
  const settled = await client.converged();
  const old = settled.find(node => node.ready)!;
  const follower = settled.find(node => node.role === 'follower')!;
  const minority = [old.nodeId, follower.nodeId];
  const majority = nodeIds.filter(id => !minority.includes(id));
  const operation = { type: 'get', key } as const;
  const defaultRead = await client.call(follower.nodeId, 'default-follower', operation);
  evidence.assert('default read still requires the leader', defaultRead.httpStatus === 409
    && defaultRead.errorCode === 'NOT_LEADER', defaultRead);
  const healthySafe = await client.call(follower.nodeId, 'safe-before', operation, 'safe-follower');
  evidence.assert('healthy follower serves a safe read', safeValue(healthySafe, 'before'), healthySafe);

  try {
    evidence.event('fault.partition', { minority, majority, layer: 'application-rpc' });
    await cutLinks(client, minority);
    const next = await client.leader(majority);
    const changed = await client.call(next.nodeId, 'after', { type: 'put', key, value: 'after' });
    evidence.assert('majority confirms the newer value', changed.outcome === 'ok', changed);

    const leaderRead = await client.call(next.nodeId, 'majority-leader', operation);
    evidence.assert('majority leader reads the newer value', foundValue(leaderRead, 'after'), leaderRead);
    const majorityFollower = majority.find(id => id !== next.nodeId)!;
    await client.waitFor('majority follower knows the current leader', nodes => nodes.some(node =>
      node.nodeId === majorityFollower && node.role === 'follower' && node.leader === next.nodeId));
    const safe = await client.call(majorityFollower, 'majority-follower', operation, 'safe-follower');
    evidence.assert('majority follower safely reads the newer value', safeValue(safe, 'after'), safe);

    // 三个读都在多数派写入已确认之后发起，避免把并发重叠误作过期读。
    const [stale, isolatedSafe, oldLeader] = await Promise.all([
      client.call(follower.nodeId, 'minority-stale', operation, 'stale'),
      client.call(follower.nodeId, 'minority-safe', operation, 'safe-follower'),
      client.call(old.nodeId, 'minority-old-leader', operation),
    ]);
    evidence.assert('isolated stale read exposes the previous value and applied index',
      foundValue(stale, 'before') && stale.consistency === 'stale' && stale.appliedIndex !== undefined
      && safe.readIndex !== undefined && stale.appliedIndex < safe.readIndex, stale);
    evidence.assert('isolated safe read returns NO_QUORUM', isolatedSafe.httpStatus === 503
      && isolatedSafe.errorCode === 'NO_QUORUM', isolatedSafe);
    evidence.assert('old leader refuses the fresh read', oldLeader.httpStatus === 503
      && oldLeader.errorCode === 'NO_QUORUM', oldLeader);
  } finally {
    await healLinks(client);
  }

  const healed = await client.converged();
  const recovered = healed.find(node => minority.includes(node.nodeId) && node.role === 'follower')!;
  const read = await client.call(recovered.nodeId, 'healed-safe', operation, 'safe-follower');
  evidence.assert('healed follower safely reads the newer value', safeValue(read, 'after'), read);
}
