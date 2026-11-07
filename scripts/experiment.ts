/** CLI entry for leased Raft experiments. */
import { docker, image, labName, labNodeIds, membershipLab } from './docker.ts';
import { performOperation } from './operation-worker.ts';
import { acquireProjectLock } from './cluster-lock.ts';
import { configuredTargets, readComposeConfig } from './console-cluster.ts';
import { openEvidence } from './evidence.ts';
import { raftClient } from './raft-client.ts';
import { batchExperiment, followerReadExperiment } from './raft-extension-experiments.ts';
import { snapshotExperiment } from './raft-snapshot-experiment.ts';
import { membershipExperiment } from './raft-membership-experiment.ts';

const id = process.argv[2];
if (id !== 'R01' && id !== 'R02' && id !== 'R03' && id !== 'E1' && id !== 'E2' && id !== 'E3B' && id !== 'E4B') {
  console.error('Usage: pnpm experiment R01|R02|R03|E1|E2|E3B|E4B');
  process.exit(1);
}
if ((id === 'E4B') !== membershipLab || (membershipLab && labName === 'minidb-lab')) {
  console.error('E4B requires an isolated membership lab. Other experiments use the five-node profile.');
  process.exit(1);
}
if (id === 'E3B' && labName === 'minidb-lab') {
  console.error('E3B compacts the selected volumes. Set RAFT_LAB_NAME and RAFT_PORT_PREFIX for an isolated cluster.');
  process.exit(1);
}

if (id === 'R01' || id === 'R02' || id === 'R03') {
  const result = await performOperation({ kind: 'experiment', experimentId: id });
  if (result.status === 'FAIL') process.exitCode = 1;
} else {
  const config = readComposeConfig();
  if ((id === 'E3B' || id === 'E4B') && config.name === 'minidb-lab') throw new Error('Select an isolated Compose project');
  const targets = configuredTargets(config, labNodeIds);
  const lease = acquireProjectLock(config.name, 'experiment');
  try {
    const evidence = openEvidence(id, 'pnpm experiment ' + id, { project: config.name, targets });
    lease.setRun(evidence.runId);
    const client = raftClient(evidence, nodeId => targets.find(target => target.nodeId === nodeId)!.address);
    const runDocker = (args: string[]) => docker(args, evidence.log);
    let imageId: string | undefined;

    try {
      imageId = runDocker(['image', 'inspect', image, '--format', '{{.Id}}']);
      if (id === 'E1') await batchExperiment(evidence, client, runDocker);
      if (id === 'E2') await followerReadExperiment(evidence, client);
      if (id === 'E3B') await snapshotExperiment(evidence, client, runDocker);
      if (id === 'E4B') await membershipExperiment(evidence, client, runDocker);
      runDocker(['compose', 'logs', '--no-color', '--since', evidence.startedAt]);
      evidence.finish('PASS', { imageId, node: process.version });
    } catch (error) {
      evidence.log(error instanceof Error ? error.stack ?? error.message : String(error));
      try {
        runDocker(['compose', 'logs', '--no-color', '--since', evidence.startedAt]);
      } finally {
        evidence.finish('FAIL', { imageId, node: process.version });
        process.exitCode = 1;
      }
    }
  } finally {
    lease.release();
  }
}
