/** Projects recent RPC replies from Compose logs without retaining payloads. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RpcObservation } from '../contracts/observation.ts';

const exec = promisify(execFile);
const windowMs = 8000;

interface LogRecord {
  kind?: unknown;
  from?: unknown;
  to?: unknown;
  request?: { kind?: unknown; term?: unknown };
  reply?: { kind?: unknown; granted?: unknown; success?: unknown };
}

export function projectRpcReplies(logs: string, members: readonly string[], now: number): RpcObservation[] {
  const ids = new Set(members);
  const latest = new Map<string, RpcObservation>();

  for (const line of logs.split('\n')) {
    const match = /^(\S+)\s+(\{.*\})\s*$/.exec(line);
    if (!match) continue;
    const at = match[1];
    const timestamp = Date.parse(at);
    if (!(timestamp >= now - windowMs && timestamp <= now)) continue;

    let event: LogRecord;
    try {
      event = JSON.parse(match[2]);
    } catch {
      continue;
    }
    const { from, to, request, reply } = event;
    if (event.kind !== 'raft.rpc' || typeof from !== 'string' || typeof to !== 'string'
      || !ids.has(from) || !ids.has(to) || from === to
      || (request?.kind !== 'vote' && request?.kind !== 'append')
      || typeof request.term !== 'number' || !Number.isSafeInteger(request.term) || request.term < 0
      || reply?.kind !== request.kind) continue;

    const accepted = request.kind === 'vote' ? reply.granted : reply.success;
    if (typeof accepted !== 'boolean') continue;
    const key = `${from}/${to}`;
    const previous = latest.get(key);
    if (!previous || timestamp >= Date.parse(previous.at)) {
      latest.set(key, { at, from, to, kind: request.kind, term: request.term, accepted });
    }
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** 每轮最多读取最近八秒的有界日志，读取失败独立于节点状态。 */
export async function readRpcReplies(members: readonly string[]): Promise<RpcObservation[] | null> {
  try {
    const { stdout } = await exec('docker', [
      'compose', 'logs', '--timestamps', '--no-log-prefix', '--no-color', '--since', '8s', '--tail', '40', ...members,
    ], { encoding: 'utf8', timeout: 1000, maxBuffer: 512 * 1024, windowsHide: true });
    return projectRpcReplies(stdout, members, Date.now());
  } catch {
    return null;
  }
}
