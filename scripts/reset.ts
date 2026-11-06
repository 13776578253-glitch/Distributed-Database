import { acquireProjectLock } from './cluster-lock.ts';
import { configuredVolumes, readComposeConfig } from './console-cluster.ts';
import { docker } from './docker.ts';

if (!process.argv.includes('--confirm')) {
  console.error('This deletes all five Raft volumes. Run pnpm reset:destructive --confirm to proceed.');
  process.exit(1);
}

const config = readComposeConfig();
const volumes = configuredVolumes(config);
const lease = acquireProjectLock(config.name, 'reset');
try {
  docker(['compose', 'down']);
  const present = new Set(docker(['volume', 'ls', '--format', '{{.Name}}'], () => {}).split(/\r?\n/));
  for (const name of volumes) {
    if (present.has(name)) docker(['volume', 'rm', name]);
  }
} finally { lease.release(); }
