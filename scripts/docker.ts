import { spawnSync } from 'node:child_process';
import { membershipLab } from '../src/raft/config.ts';

export { labNodeIds, membershipLab, nodeIds, standbyId } from '../src/raft/config.ts';
export const labName = process.env.RAFT_LAB_NAME || 'minidb-lab';
export const image = `${labName}:local`;
export const volumeName = (nodeId: string) => `${labName}-${nodeId}`;
export const nodePort = (index: number) => Number(`${process.env.RAFT_PORT_PREFIX || '1808'}${index + 1}`);
export const nodeUrl = (index: number) => `http://127.0.0.1:${nodePort(index)}`;

export function docker(args: string[], log = (line: string) => console.log(line), timeout = 90000): string {
  const command = membershipLab && args[0] === 'compose' ? ['compose', '--profile', 'membership', ...args.slice(1)] : args;
  const result = spawnSync('docker', command, { encoding: 'utf8', timeout, windowsHide: true });
  log(`> docker ${command.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${command.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}
