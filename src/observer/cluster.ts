/** Samples Raft over HTTP and shares one in-flight read across clients. */
import type { ClusterObservation, NodeObservation, RaftStatus } from '../contracts/observation.ts';

export interface NodeTarget {
  nodeId: string;
  address?: string;
}

function isStatus(value: unknown, nodeId: string): value is RaftStatus {
  if (value === null || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  return status.nodeId === nodeId
    && (status.role === 'leader' || status.role === 'candidate' || status.role === 'follower')
    && (typeof status.leader === 'string' || status.leader === null)
    && [status.term, status.logLength, status.commitIndex, status.lastApplied].every(
      index => typeof index === 'number' && Number.isSafeInteger(index) && index >= 0)
    && typeof status.ready === 'boolean'
    && typeof status.committedDigest === 'string' && /^[0-9a-f]{64}$/.test(status.committedDigest);
}

export function clusterReader(
  targets: readonly NodeTarget[],
  { timeoutMs = 1000, request = fetch, startupWarning }: {
    timeoutMs?: number;
    request?: typeof fetch;
    startupWarning?: string;
  } = {},
) {
  async function observe({ nodeId, address }: NodeTarget): Promise<NodeObservation> {
    const failed = (reason: Extract<NodeObservation, { ok: false }>['reason'], httpStatus?: number): NodeObservation =>
      ({ nodeId, ok: false, reason, httpStatus, observedAt: new Date().toISOString() });
    if (!address) return failed('unconfigured');

    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await request(`${address}/internal/raft/status`, { signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        return failed('http', response.status);
      }
      // 同一个超时覆盖响应头和正文，慢节点不会拖住整轮轮询。
      const value: unknown = await response.json().catch(error => {
        if (signal.aborted) throw error;
        return null;
      });
      if (!isStatus(value, nodeId)) return failed('invalid-response');
      const { role, term, leader, commitIndex, lastApplied, logLength, ready, committedDigest } = value;
      return {
        nodeId, ok: true, observedAt: new Date().toISOString(),
        status: { nodeId, role, term, leader, commitIndex, lastApplied, logLength, ready, committedDigest },
      };
    } catch {
      return failed(signal.aborted ? 'timeout' : 'unreachable');
    }
  }

  let inFlight: Promise<ClusterObservation> | undefined;
  return () => {
    // 仅合并并发请求。下一轮始终重新采样节点。
    inFlight ??= Promise.all(targets.map(observe))
      .then(nodes => ({ nodes, sampledAt: new Date().toISOString(), startupWarning }))
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
