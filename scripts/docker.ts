import { spawnSync } from 'node:child_process';

export { nodeIds } from '../src/raft/config.ts';

export function docker(args: string[], log = (line: string) => console.log(line), timeout = 90000): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
  log(`> docker ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}
