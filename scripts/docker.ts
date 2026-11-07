import { spawnSync } from 'node:child_process';

export { nodeIds } from '../src/raft/config.ts';
export const labName = process.env.RAFT_LAB_NAME || 'minidb-lab';
export const image = `${labName}:local`;
export const volumeName = (nodeId: string) => `${labName}-${nodeId}`;
export const nodePort = (index: number) => Number(`${process.env.RAFT_PORT_PREFIX || '1808'}${index + 1}`);
export const nodeUrl = (index: number) => `http://127.0.0.1:${nodePort(index)}`;

export function docker(args: string[], log = (line: string) => console.log(line)): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  log(`> docker ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}
