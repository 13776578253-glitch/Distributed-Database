/**
 * Samples each configured Raft node over HTTP and returns independent
 * observations. A failed probe only marks that node; concurrent callers share
 * one in-flight batch, and the next caller always samples again.
 */
import type { ClusterObservation, NodeObservation, RaftStatus, RpcObservation } from '../contracts/observation.ts';

/** 节点身份与可选监听地址；缺少地址时该节点按 unconfigured 记录。 */
export interface NodeTarget {
  nodeId: string;
  address?: string;
}

/** 校验节点身份和关键协议字段；形状不符不能进入状态聚合。 */
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
  { timeoutMs = 1000, request = fetch, startupWarning, readRpc }: {
    timeoutMs?: number;
    request?: typeof fetch;
    startupWarning?: string;
    readRpc?: () => Promise<RpcObservation[] | null>;
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
      const { role, term, leader, commitIndex, lastApplied, logLength, ready, committedDigest,
        appliedDigest, committedTerm, snapshotIndex, snapshotTerm, retainedEntries, voter, membership, appliedMembership } = value;
      return {
        nodeId, ok: true, observedAt: new Date().toISOString(),
        status: { nodeId, role, term, leader, commitIndex, lastApplied, logLength, ready, committedDigest,
          appliedDigest, committedTerm, snapshotIndex, snapshotTerm, retainedEntries, voter, membership, appliedMembership },
      };
    } catch {
      return failed(signal.aborted ? 'timeout' : 'unreachable');
    }
  }

  let inFlight: Promise<ClusterObservation> | undefined;
  return () => {
    // 并发调用共享同一批探测；settle 后清空，下一轮始终重新采样。
    inFlight ??= Promise.all([Promise.all(targets.map(observe)), readRpc?.()])
      .then(([nodes, recentRpc]) => ({ nodes, recentRpc, sampledAt: new Date().toISOString(), startupWarning }))
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
