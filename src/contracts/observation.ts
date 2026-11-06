/** Wire types for the console's read-only cluster observations. */

export interface RaftStatus {
  nodeId: string;
  role: 'leader' | 'candidate' | 'follower';
  term: number;
  leader: string | null;
  commitIndex: number;
  lastApplied: number;
  logLength: number;
  ready: boolean;
  committedDigest: string;
}

export type NodeFailure = 'unconfigured' | 'timeout' | 'unreachable' | 'http' | 'invalid-response';

/** 每项对应一次独立探测，失败项仅携带原因和该次探测时间。 */
export type NodeObservation = { nodeId: string; observedAt: string } & (
  | { ok: true; status: RaftStatus }
  | { ok: false; reason: NodeFailure; httpStatus?: number }
);

/** 从容器日志投影的近期 RPC 应答。at 为日志时间。 */
export interface RpcObservation {
  at: string;
  from: string;
  to: string;
  kind: 'vote' | 'append';
  term: number;
  accepted: boolean;
}

/** 同一批次的独立采样，成员顺序固定。 */
export interface ClusterObservation {
  sampledAt: string;
  nodes: NodeObservation[];
  startupWarning?: string;
  recentRpc?: RpcObservation[] | null;
}
