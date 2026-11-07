/**
 * HTTP boundary for one Raft member: client KV operations, internal RPCs,
 * status/digest for experiments, and the fault-injection link switch. Owns
 * input validation and HTTP status mapping; protocol decisions stay in
 * RaftNode.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isOperation } from '../../contracts/history.ts';
import type { Operation } from '../../contracts/history.ts';
import { rpcPath } from '../adapters/http-transport.ts';
import type { HttpTransport } from '../adapters/http-transport.ts';
import type { RaftNode } from '../core/node.ts';
import type { RpcRequest } from '../core/types.ts';
import { batchWrites } from './write-batch.ts';

/** 以 JSON 结束响应；状态码和错误体由调用方决定。 */
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** 判断非数组对象，作为请求体形状校验的入口。 */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Raft 任期和日志索引的合法值：非负安全整数。 */
function index(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 按 kind 校验 RPC 载荷；追加条目只接受 noop/put/delete，get 不得写入日志。 */
function isRpc(value: unknown, kind: RpcRequest['kind']): value is RpcRequest {
  if (!record(value) || value.kind !== kind || !index(value.term)) return false;
  if (kind === 'vote') return index(value.lastLogIndex) && index(value.lastLogTerm);
  return index(value.prevLogIndex) && index(value.prevLogTerm) && index(value.leaderCommit)
    && (value.readId === undefined || index(value.readId))
    && Array.isArray(value.entries) && value.entries.every(entry =>
      record(entry) && index(entry.term) && record(entry.command)
      && (entry.command.type === 'noop' || (isOperation(entry.command) && entry.command.type !== 'get')));
}

/** 读取完整请求体并解析 JSON；语法错误由调用方映射为 400。 */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

/** 构造请求处理器；peers 用于校验 RPC 来源，faultEnabled 控制故障端点是否开放。 */
export function raftHttp(
  node: RaftNode, peers: string[], transport: HttpTransport, flush: () => void,
  faultEnabled: boolean,
) {
  const write = batchWrites(node, flush);
  return async (request: IncomingMessage, response: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(request.url!, 'http://localhost');
    } catch {
      return send(response, 400, { error: 'INVALID_URL' });
    }
    const path = url.pathname;
    if (request.method === 'GET' && path === '/health') {
      // 健康检查只报告进程身份，不等待 Leader 或提交进度。
      return send(response, 200, { nodeId: node.status().nodeId, mode: 'raft' });
    }
    if (request.method === 'GET' && path === '/internal/raft/status') {
      // 摘要覆盖已提交前缀，实验用于比较各节点日志是否一致。
      const committedDigest = createHash('sha256').update(JSON.stringify(node.committedEntries())).digest('hex');
      return send(response, 200, { ...node.status(), committedDigest });
    }

    /** 读直接启动屏障，写进入短批次队列，HTTP 等待该请求自己的结果。 */
    async function execute(operation: Operation) {
      const result = operation.type === 'get'
        ? node.execute(operation, performance.now())
        : write(operation);
      if (operation.type === 'get') flush();
      const reply = await result;
      // 504 表示写结果未知，不是普通的网关超时；调用方必须保留历史。
      const status = reply.ok ? 200 : { NOT_LEADER: 409, NO_QUORUM: 503, UNKNOWN_OUTCOME: 504 }[reply.error];
      send(response, status, reply);
    }

    if (request.method === 'GET' && path === '/kv') {
      const key = url.searchParams.get('key');
      // 缺失或空 key 均拒绝；契约要求 key 非空。
      if (!key) return send(response, 400, { error: 'INVALID_OPERATION' });
      return execute({ type: 'get', key });
    }
    const kind = path === rpcPath.vote ? 'vote' : path === rpcPath.append ? 'append' : undefined;
    const fault = path === '/internal/fault/links' && faultEnabled;
    // 只接受 POST 的内部 RPC、故障端点和 KV 写路径；其余路径 404。
    if (request.method !== 'POST' || (!kind && !fault && path !== '/kv/put' && path !== '/kv/delete')) {
      return send(response, 404, { error: 'NOT_FOUND' });
    }

    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      // 客户端已断开时不再写响应；只有 JSON 语法错误映射为 400。
      if (request.destroyed && !(error instanceof SyntaxError)) return;
      if (!(error instanceof SyntaxError)) throw error;
      return send(response, 400, { error: 'INVALID_JSON' });
    }
    if (!record(body)) return send(response, 400, { error: 'INVALID_BODY' });

    if (kind) {
      const { from, request: rpc } = body;
      // 来源必须是配置中的其他成员，载荷形状必须与 kind 匹配，避免伪造 RPC 进入核心。
      if (typeof from !== 'string' || !peers.includes(from) || !isRpc(rpc, kind)) {
        return send(response, 400, { error: 'INVALID_RPC' });
      }
      // 入站阻断与出站共用同一集合；被阻断的 RPC 在进入协议核心前返回 503。
      if (transport.isBlocked(from)) return send(response, 503, { error: 'LINK_BLOCKED' });
      const reply = node.receiveRequest(from, rpc, performance.now());
      flush();
      return send(response, 200, reply);
    }
    if (fault) {
      const { blockedPeers } = body;
      // 故障端点仅在 FAULTS_ENABLED=1 时开放；阻断对象必须是已知 peer。
      if (!Array.isArray(blockedPeers) || !blockedPeers.every(peer => peers.includes(peer))) {
        return send(response, 400, { error: 'INVALID_LINKS' });
      }
      transport.setBlocked(blockedPeers);
      return send(response, 200, { blockedPeers });
    }
    // put/delete 在边界补齐 type 后复用契约校验；非法 key 或值返回 400。
    const operation = path === '/kv/put'
      ? { type: 'put', key: body.key, value: body.value }
      : { type: 'delete', key: body.key };
    if (!isOperation(operation)) return send(response, 400, { error: 'INVALID_OPERATION' });
    return execute(operation);
  };
}
