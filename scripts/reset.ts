import { docker, labName, labNodeIds, membershipLab, volumeName } from './docker.ts';

if (membershipLab && labName === 'minidb-lab') throw new Error('Use an isolated RAFT_LAB_NAME for membership experiments');
if (!process.argv.includes('--confirm')) {
  console.error(`This deletes all ${labNodeIds.length} Raft volumes. Run pnpm reset:destructive --confirm to proceed.`);
  process.exit(1);
}

docker(['compose', 'down']);
const present = new Set(docker(['volume', 'ls', '--format', '{{.Name}}']).split(/\r?\n/));
for (const name of labNodeIds.map(volumeName)) {
  if (present.has(name)) docker(['volume', 'rm', name]);
}
