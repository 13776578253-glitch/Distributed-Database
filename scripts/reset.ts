import { docker, nodeIds, volumeName } from './docker.ts';

if (!process.argv.includes('--confirm')) {
  console.error('This deletes all five Raft volumes. Run pnpm reset:destructive --confirm to proceed.');
  process.exit(1);
}

docker(['compose', 'down']);
const present = new Set(docker(['volume', 'ls', '--format', '{{.Name}}']).split(/\r?\n/));
for (const name of nodeIds.map(volumeName)) {
  if (present.has(name)) docker(['volume', 'rm', name]);
}
