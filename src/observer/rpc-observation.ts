/** Keeps the latest observed reply for each directed edge in the cluster view. */
import type { RpcObservation } from '../contracts/observation.ts';
import { containerEvent } from './timeline.ts';

export function projectRpcReplies(logs: string, members: readonly string[], now: number): RpcObservation[] {
  const ids = new Set(members);
  const latest = new Map<string, RpcObservation>();
  for (const line of logs.split(/\r?\n/)) {
    const rpc = containerEvent(line)?.rpc;
    if (!rpc || !ids.has(rpc.from) || !ids.has(rpc.to)) continue;
    const timestamp = Date.parse(rpc.at);
    if (timestamp < now - 8000 || timestamp > now) continue;
    const key = `${rpc.from}/${rpc.to}`;
    const previous = latest.get(key);
    if (!previous || timestamp >= Date.parse(previous.at)) latest.set(key, rpc);
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
