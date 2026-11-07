/** Drives isolated-cluster acceptance for group commit and follower reads. */
import { nodeIds } from './docker.ts';
import type { openEvidence } from './evidence.ts';
import type { raftClient } from './raft-client.ts';

type Evidence = ReturnType<typeof openEvidence>;
type Client = ReturnType<typeof raftClient>;
type RunDocker = (args: string[]) => string;

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
    const pending = Promise.all(Array.from({ length: pendingCount }, (_, value) =>
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
      replies.every(reply => reply.outcome === 'unknown'), replies);
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
