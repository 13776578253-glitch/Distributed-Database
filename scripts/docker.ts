import { spawnSync } from 'node:child_process';

export { nodeIds } from '../src/raft/config.ts';
export const volumeName = (nodeId: string) => `minidb-lab-${nodeId}`;
export const nodeUrl = (index: number) => `http://127.0.0.1:${18081 + index}`;

export function docker(args: string[], log = (line: string) => console.log(line)): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  log(`> docker ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}
