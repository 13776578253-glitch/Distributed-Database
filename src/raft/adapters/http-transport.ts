/**
 * Outbound Raft RPC transport over HTTP with per-peer fault injection. Owns
 * the blocked-peer set and RPC deadlines; a dropped, blocked, or
 * timed-out request resolves to undefined so the core treats it as lost.
 */
import type { ReadBarrier, RpcReply, RpcRequest } from '../core/types.ts';

/** 内部 RPC 路径；入站 API 复用同一常量，避免两端拼写漂移。 */
export const rpcPath = {
  vote: '/internal/raft/request-vote',
  append: '/internal/raft/append-entries',
  snapshot: '/internal/raft/install-snapshot',
  readIndex: '/internal/raft/read-index',
};

function index(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function validReply(value: unknown, kind: RpcRequest['kind']): value is RpcReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.kind !== kind || !index(reply.term)) return false;
  if (kind === 'vote') return typeof reply.granted === 'boolean';
  if (kind === 'snapshot') return typeof reply.success === 'boolean';
  return reply.success === true || (reply.success === false && index(reply.nextIndex, 1));
}

export class HttpTransport {
  private readonly nodeId: string;
  /** 本进程主动丢弃出站消息的 peer 集合；故障实验通过 HTTP 端点替换。 */
  private blocked = new Set<string>();

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /** 替换出站阻断集合；入站方向由 HTTP 层依据同一集合拒绝。 */
  setBlocked(peers: string[]) {
    this.blocked = new Set(peers);
    console.log(JSON.stringify({ kind: 'fault.links', nodeId: this.nodeId, blockedPeers: peers }));
  }

  /** 查询 peer 是否在阻断集合中；出站发送与入站 RPC 共用该判断。 */
  isBlocked(peer: string): boolean {
    return this.blocked.has(peer);
  }

  /** 发送一次 RPC；链路阻断、连接失败、超时或 503 均视为丢包，返回 undefined。 */
  async send(peer: string, request: RpcRequest): Promise<RpcReply | undefined> {
    const body = await this.exchange(peer, request.kind, { request }, request.kind === 'snapshot' ? 2000 : 220);
    if (body === undefined) return;
    if (!validReply(body, request.kind)) {
      this.reportError(peer, request.kind, 'invalid reply');
      return;
    }

    // 心跳不记录，避免刷屏；投票、携带条目的追加和读屏障请求记录完整载荷。
    if (request.kind === 'snapshot') {
      const { lastIncludedIndex, lastIncludedTerm } = request.snapshot;
      console.log(JSON.stringify({
        kind: 'raft.rpc', from: this.nodeId, to: peer,
        request: { kind: request.kind, term: request.term, lastIncludedIndex, lastIncludedTerm }, reply: body,
      }));
    } else if (request.kind === 'vote' || request.entries.length > 0 || request.readId !== undefined) {
      console.log(JSON.stringify({ kind: 'raft.rpc', from: this.nodeId, to: peer, request, reply: body }));
    }
    return body;
  }

  /** 一次 Follower ReadIndex 走相同的链路阻断，等待 Leader 完成自己的多数派屏障。 */
  async requestReadIndex(peer: string): Promise<ReadBarrier | undefined> {
    const body = await this.exchange(peer, 'readIndex', {}, 2000);
    if (body === undefined) return;
    if (typeof body === 'object' && body !== null) {
      const reply = body as Record<string, unknown>;
      if (reply.ok === false && (reply.error === 'NOT_LEADER' || reply.error === 'NO_QUORUM')) return;
      if (reply.ok === true && index(reply.term, 1) && index(reply.readIndex, 1)) {
        console.log(JSON.stringify({ kind: 'raft.read-index', from: this.nodeId, to: peer, reply }));
        return { ok: true, term: reply.term, readIndex: reply.readIndex };
      }
    }
    this.reportError(peer, 'readIndex', 'invalid reply');
  }

  private async exchange(peer: string, rpc: keyof typeof rpcPath, payload: object, timeoutMs: number): Promise<unknown> {
    if (this.isBlocked(peer)) return;
    try {
      const response = await fetch(`http://${peer}:8080${rpcPath[rpc]}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.nodeId, ...payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 503 表示对端按链路阻断拒绝了本次 RPC，与网络丢包等价。
      if (!response.ok) {
        if (response.status !== 503) this.reportError(peer, rpc, `HTTP ${response.status}`);
        await response.body?.cancel();
        return;
      }
      const body: unknown = await response.json();
      // 等待应答期间链路可能被切断，此时丢弃已到达的应答。
      return this.isBlocked(peer) ? undefined : body;
    } catch (error) {
      // fetch 的网络失败和超时是可预期的分区表现。
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
        return;
      }
      if (error instanceof SyntaxError) {
        this.reportError(peer, rpc, 'invalid JSON');
        return;
      }
      throw error;
    }
  }

  private reportError(peer: string, rpc: string, reason: string) {
    console.warn(JSON.stringify({ kind: 'raft.rpc.error', from: this.nodeId, to: peer, rpc, reason }));
  }
}
