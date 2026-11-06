import type { RpcReply, RpcRequest } from '../core/types.ts';

export const rpcPath = {
  vote: '/internal/raft/request-vote',
  append: '/internal/raft/append-entries',
};

export class HttpTransport {
  private readonly nodeId: string;
  private blocked = new Set<string>();

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  setBlocked(peers: string[]) {
    this.blocked = new Set(peers);
    console.log(JSON.stringify({ kind: 'fault.links', nodeId: this.nodeId, blockedPeers: peers }));
  }

  isBlocked(peer: string): boolean {
    return this.blocked.has(peer);
  }

  async send(peer: string, request: RpcRequest): Promise<RpcReply | undefined> {
    if (this.isBlocked(peer)) return;
    let reply: RpcReply;
    try {
      const response = await fetch(`http://${peer}:8080${rpcPath[request.kind]}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.nodeId, request }),
        signal: AbortSignal.timeout(220),
      });
      if (response.status === 503) return;
      if (!response.ok) throw new Error(`${peer} rejected ${request.kind} RPC: ${response.status}`);
      reply = await response.json() as RpcReply;
    } catch (error) {
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
        return;
      }
      throw error;
    }
    if (this.isBlocked(peer)) return;

    if (request.kind === 'vote' || request.entries.length > 0 || request.readId !== undefined) {
      console.log(JSON.stringify({ kind: 'raft.rpc', from: this.nodeId, to: peer, request, reply }));
    }
    return reply;
  }
}
