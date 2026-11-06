import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isOperation } from '../../contracts/history.ts';
import type { Operation } from '../../contracts/history.ts';
import { rpcPath } from '../adapters/http-transport.ts';
import type { HttpTransport } from '../adapters/http-transport.ts';
import type { RaftNode } from '../core/node.ts';
import type { RpcRequest } from '../core/types.ts';

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function index(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRpc(value: unknown, kind: RpcRequest['kind']): value is RpcRequest {
  if (!record(value) || value.kind !== kind || !index(value.term)) return false;
  if (kind === 'vote') return index(value.lastLogIndex) && index(value.lastLogTerm);
  return index(value.prevLogIndex) && index(value.prevLogTerm) && index(value.leaderCommit)
    && (value.readId === undefined || index(value.readId))
    && Array.isArray(value.entries) && value.entries.every(entry =>
      record(entry) && index(entry.term) && record(entry.command)
      && (entry.command.type === 'noop' || (isOperation(entry.command) && entry.command.type !== 'get')));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

export function raftHttp(
  node: RaftNode, peers: string[], transport: HttpTransport, flush: () => void,
  faultEnabled: boolean,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, 'http://localhost');
    const path = url.pathname;
    if (request.method === 'GET' && path === '/health') {
      return send(response, 200, { nodeId: node.status().nodeId, mode: 'raft' });
    }
    if (request.method === 'GET' && path === '/internal/raft/status') {
      const committedDigest = createHash('sha256').update(JSON.stringify(node.committedEntries())).digest('hex');
      return send(response, 200, { ...node.status(), committedDigest });
    }

    async function execute(operation: Operation) {
      const result = node.execute(operation, performance.now());
      flush();
      const reply = await result;
      const status = reply.ok ? 200 : { NOT_LEADER: 409, NO_QUORUM: 503, UNKNOWN_OUTCOME: 504 }[reply.error];
      send(response, status, reply);
    }

    if (request.method === 'GET' && path === '/kv') {
      const key = url.searchParams.get('key');
      if (!key) return send(response, 400, { error: 'INVALID_OPERATION' });
      return execute({ type: 'get', key });
    }
    const kind = path === rpcPath.vote ? 'vote' : path === rpcPath.append ? 'append' : undefined;
    const fault = path === '/internal/fault/links' && faultEnabled;
    if (request.method !== 'POST' || (!kind && !fault && path !== '/kv/put' && path !== '/kv/delete')) {
      return send(response, 404, { error: 'NOT_FOUND' });
    }

    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      if (request.destroyed && !(error instanceof SyntaxError)) return;
      if (!(error instanceof SyntaxError)) throw error;
      return send(response, 400, { error: 'INVALID_JSON' });
    }
    if (!record(body)) return send(response, 400, { error: 'INVALID_BODY' });

    if (kind) {
      const { from, request: rpc } = body;
      if (typeof from !== 'string' || !peers.includes(from) || !isRpc(rpc, kind)) {
        return send(response, 400, { error: 'INVALID_RPC' });
      }
      if (transport.isBlocked(from)) return send(response, 503, { error: 'LINK_BLOCKED' });
      const reply = node.receiveRequest(from, rpc, performance.now());
      flush();
      return send(response, 200, reply);
    }
    if (fault) {
      const { blockedPeers } = body;
      if (!Array.isArray(blockedPeers) || !blockedPeers.every(peer => peers.includes(peer))) {
        return send(response, 400, { error: 'INVALID_LINKS' });
      }
      transport.setBlocked(blockedPeers);
      return send(response, 200, { blockedPeers });
    }
    const operation = path === '/kv/put'
      ? { type: 'put', key: body.key, value: body.value }
      : { type: 'delete', key: body.key };
    if (!isOperation(operation)) return send(response, 400, { error: 'INVALID_OPERATION' });
    return execute(operation);
  };
}
