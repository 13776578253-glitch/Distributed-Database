/**
 * Outbound Raft RPC transport over HTTP with per-peer fault injection. Owns
 * the blocked-peer set and the 220 ms deadline; a dropped, blocked, or
 * timed-out request resolves to undefined so the core treats it as lost.
 */
import type { RpcReply, RpcRequest } from '../core/types.ts';

/** 内部 RPC 路径；入站 API 复用同一常量，避免两端拼写漂移。 */
export const rpcPath = {
  vote: '/internal/raft/request-vote',
  append: '/internal/raft/append-entries',
};

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
    if (this.isBlocked(peer)) return;
    let reply: RpcReply;
    try {
      // 单次 RPC 超时 220ms，短于 main.ts 的客户端请求超时；丢包由上层重试。
      const response = await fetch(`http://${peer}:8080${rpcPath[request.kind]}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.nodeId, request }),
        signal: AbortSignal.timeout(220),
      });
      // 503 表示对端按链路阻断拒绝了本次 RPC，与网络丢包等价。
      if (response.status === 503) return;
      // 其余非 2xx 是协议或校验错误，直接抛出。
      if (!response.ok) throw new Error(`${peer} rejected ${request.kind} RPC: ${response.status}`);
      reply = await response.json() as RpcReply;
    } catch (error) {
      // fetch 的网络失败和超时是可预期的分区表现；其他异常继续抛出。
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
        return;
      }
      throw error;
    }
    // 等待应答期间链路可能被切断，此时丢弃已到达的应答，保持阻断语义。
    if (this.isBlocked(peer)) return;

    // 心跳不记录，避免刷屏；投票、携带条目的追加和读屏障请求记录完整载荷。
    if (request.kind === 'vote' || request.entries.length > 0 || request.readId !== undefined) {
      console.log(JSON.stringify({ kind: 'raft.rpc', from: this.nodeId, to: peer, request, reply }));
    }
    return reply;
  }
}
