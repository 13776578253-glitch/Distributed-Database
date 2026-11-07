/** Verifies compaction, snapshot catch-up, and SIGKILL recovery on Compose volumes. */
import { nodeIds, nodeUrl } from './docker.ts';
import type { openEvidence } from './evidence.ts';
import type { raftClient } from './raft-client.ts';

type Evidence = ReturnType<typeof openEvidence>;
type Client = ReturnType<typeof raftClient>;
type RunDocker = (args: string[]) => string;
type NodeStatus = Awaited<ReturnType<Client['leader']>>;

export async function snapshotExperiment(evidence: Evidence, client: Client, runDocker: RunDocker) {
  for (const [index, id] of nodeIds.entries()) {
    const published = runDocker(['compose', 'port', id, '8080']);
    evidence.assert(`${id} is bound to the selected lab`, published === new URL(nodeUrl(index)).host, { published });
  }
  const key = `E3B/${evidence.runId}`;
  const initial = await client.converged();
  const leader = initial.find(node => node.ready)!;
  const laggard = initial.find(node => node.role === 'follower')!;
  const online = nodeIds.filter(id => id !== laggard.nodeId);
  const disk = (nodeId: string) => JSON.parse(runDocker(['compose', 'exec', '-T', nodeId, 'node', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/raft.sqlite', { readOnly: true });
    const log = db.prepare('SELECT COUNT(*) AS count, MIN(log_index) AS firstIndex FROM raft_log').get();
    const snapshot = db.prepare('SELECT last_included_index AS snapshotIndex, last_included_term AS snapshotTerm FROM raft_snapshot').get();
    console.log(JSON.stringify({ ...log, ...snapshot }));
  `])) as { count: number; firstIndex: number | null; snapshotIndex?: number; snapshotTerm?: number };

  async function assertValue(node: NodeStatus, suffix: string, expected: string | null | undefined, name: string) {
    const mode = node.role === 'follower' ? 'safe-follower' : undefined;
    const read = await client.call(node.nodeId, 'snapshot-reader', { type: 'get', key: `${key}/${suffix}` }, mode);
    const value = read.result;
    evidence.assert(name, read.outcome === 'ok' && value !== undefined && 'found' in value
      && (expected === undefined ? !value.found : value.found && value.value === expected)
      && (!mode || (read.readIndex !== undefined && read.appliedIndex !== undefined && read.appliedIndex >= read.readIndex)), read);
  }

  let laggardStopped = false;
  let snapshotIndex = 0;
  try {
    evidence.event('fault.stop', { nodeId: laggard.nodeId });
    runDocker(['compose', 'stop', laggard.nodeId]);
    laggardStopped = true;
    for (const operation of [
      { type: 'put', key: `${key}/base`, value: null },
      { type: 'put', key: `${key}/gone`, value: 'deleted before snapshot' },
      { type: 'delete', key: `${key}/gone` },
    ] as const) {
      const write = await client.call(leader.nodeId, 'snapshot-writer', operation);
      evidence.assert('pre-snapshot operation confirmed', write.outcome === 'ok', write);
    }
    await assertValue(leader, 'base', null, 'value readable before compaction');
    const ready = await client.waitFor('online nodes share the applied boundary', nodes =>
      online.every(id => nodes.some(node => node.nodeId === id && node.lastApplied === nodes[0].lastApplied))
        && nodes[0].lastApplied > laggard.logLength);
    snapshotIndex = ready[0].lastApplied;
    const before = disk(leader.nodeId);
    // 四个在线节点使用同一边界，重选也必须经快照接回落后节点。
    for (const id of online) {
      const snapshot = await client.compact(id);
      evidence.assert(`${id} compacted at the shared boundary`,
        snapshot.compacted && snapshot.snapshotIndex === snapshotIndex && snapshot.retainedEntries === 0, snapshot);
    }
    const after = disk(leader.nodeId);
    evidence.assert('SQLite log rows removed and snapshot persisted',
      before.count > 0 && after.count === 0 && after.snapshotIndex === snapshotIndex, { before, after });
    await assertValue(leader, 'base', null, 'snapshot preserves value after compaction');

    const tail = await client.call(leader.nodeId, 'snapshot-writer', {
      type: 'put', key: `${key}/tail`, value: 'after snapshot',
    });
    evidence.assert('post-snapshot tail confirmed', tail.outcome === 'ok', tail);
  } finally {
    if (laggardStopped) {
      evidence.event('fault.restart', { nodeId: laggard.nodeId });
      runDocker(['compose', 'start', laggard.nodeId]);
    }
  }

  const caughtUp = await client.converged();
  const installed = caughtUp.find(node => node.nodeId === laggard.nodeId)!;
  const logs = runDocker(['compose', 'logs', '--no-color', '--no-log-prefix', '--since', evidence.startedAt, ...online]);
  const installs = logs.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .filter(event => event.kind === 'raft.rpc' && event.to === laggard.nodeId
      && event.request.kind === 'snapshot' && event.request.lastIncludedIndex === snapshotIndex
      && event.reply.success === true);
  evidence.assert('lagging follower installed a snapshot over HTTP and applied its suffix',
    installed.snapshotIndex === snapshotIndex && installed.lastApplied > snapshotIndex && installs.length > 0,
    { laggard, installed, installs });
  await assertValue(installed, 'base', null, 'caught-up node reads the snapshot value');
  await assertValue(installed, 'tail', 'after snapshot', 'caught-up node reads the retained suffix');

  const old = await client.leader();
  const beforeKill = disk(old.nodeId);
  evidence.assert('compacted leader has a durable snapshot and suffix',
    beforeKill.snapshotIndex === snapshotIndex && beforeKill.count > 0
    && beforeKill.firstIndex === snapshotIndex + 1, beforeKill);
  const container = runDocker(['compose', 'ps', '-q', old.nodeId]);
  evidence.event('fault.kill', { nodeId: old.nodeId, signal: 'SIGKILL' });
  runDocker(['compose', 'kill', '-s', 'SIGKILL', old.nodeId]);
  try {
    const exitCode = runDocker(['inspect', container, '--format', '{{.State.ExitCode}}']);
    evidence.assert('compacted leader killed by SIGKILL', exitCode === '137', { exitCode });
    const next = await client.leader(nodeIds.filter(id => id !== old.nodeId));
    await assertValue(next, 'base', null, 'new leader reads the compacted prefix');
    await assertValue(next, 'tail', 'after snapshot', 'new leader reads the acknowledged suffix');
  } finally {
    evidence.event('fault.restart', { nodeId: old.nodeId });
    runDocker(['compose', 'start', old.nodeId]);
  }
  const healed = await client.converged();
  const restarted = healed.find(node => node.nodeId === old.nodeId)!;
  const afterRestart = disk(old.nodeId);
  evidence.assert('restarted volume recovers its snapshot and absolute suffix',
    restarted.snapshotIndex === snapshotIndex && afterRestart.snapshotIndex === snapshotIndex
    && afterRestart.firstIndex === snapshotIndex + 1 && restarted.lastApplied > snapshotIndex,
    { restarted, afterRestart });
  await assertValue(restarted, 'base', null, 'restarted node reads the recovered snapshot');
  await assertValue(restarted, 'tail', 'after snapshot', 'restarted node reads the replayed suffix');
  await assertValue(restarted, 'gone', undefined, 'deleted key stays absent');

  const follower = healed.find(node => node.role === 'follower')!;
  const newer = await client.compact(follower.nodeId);
  const mixed = await client.converged();
  evidence.assert('different snapshot boundaries converge on the same applied state',
    newer.compacted && newer.snapshotIndex > snapshotIndex && new Set(mixed.map(node => node.snapshotIndex)).size > 1,
    mixed);
}
