import { acquireProjectLock } from './cluster-lock.ts';
import { configuredVolumes, readComposeConfig } from './console-cluster.ts';
import { docker, labName, labNodeIds, membershipLab } from './docker.ts';

if (membershipLab && labName === 'minidb-lab') throw new Error('Use an isolated RAFT_LAB_NAME for membership experiments');
if (!process.argv.includes('--confirm')) {
  console.error(`This deletes all ${labNodeIds.length} Raft volumes. Run pnpm reset:destructive --confirm to proceed.`);
  process.exit(1);
}

const config = readComposeConfig();
const volumes = configuredVolumes(config, labNodeIds);
const lease = acquireProjectLock(config.name, 'reset');
try {
  docker(['compose', 'down']);
  const present = new Set(docker(['volume', 'ls', '--format', '{{.Name}}'], () => {}).split(/\r?\n/));
  for (const name of volumes) {
    if (present.has(name)) docker(['volume', 'rm', name]);
  }
} finally { lease.release(); }
