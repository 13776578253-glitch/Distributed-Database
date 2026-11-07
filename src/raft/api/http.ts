/**
 * HTTP boundary for one Raft member: client KV operations, internal RPCs,
 * status/digest for experiments, and the fault-injection link switch. Owns
 * input validation and HTTP status mapping; protocol decisions stay in
 * RaftNode.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { isOperation } from '../../contracts/history.ts';
import type { Operation } from '../../contracts/history.ts';
import { rpcPath } from '../adapters/http-transport.ts';
import type { HttpTransport } from '../adapters/http-transport.ts';
import type { RaftNode } from '../core/node.ts';
import type { Configuration, RpcRequest } from '../core/types.ts';
import { batchWrites } from './write-batch.ts';

const rpcKinds = ['vote', 'append', 'snapshot'] as const;

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
function index(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 按 kind 校验 RPC 载荷；追加条目只接受 noop/put/delete，get 不得写入日志。 */
function voterList(value: unknown, roster: string[]): value is string[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every(id => typeof id === 'string' && roster.includes(id));
}

function configuration(value: unknown, roster: string[]): value is Configuration {
  return record(value) && voterList(value.voters, roster)
    && (value.next === undefined || voterList(value.next, roster));
}

function isRpc(value: unknown, kind: RpcRequest['kind'], roster: string[]): value is RpcRequest {
  if (!record(value) || value.kind !== kind || !index(value.term)) return false;
  if (kind === 'vote') return index(value.lastLogIndex) && index(value.lastLogTerm)
    && (value.configurationIndex === undefined
      || (index(value.configurationIndex) && value.configurationIndex <= value.lastLogIndex));
  if (kind === 'snapshot') {
    const snapshot = value.snapshot;
    return record(snapshot) && index(snapshot.lastIncludedIndex) && snapshot.lastIncludedIndex > 0
      && index(snapshot.lastIncludedTerm) && snapshot.lastIncludedTerm > 0
      && snapshot.lastIncludedTerm <= value.term
      && (snapshot.membership === undefined || (record(snapshot.membership) && index(snapshot.membership.index)
        && snapshot.membership.index > 0 && snapshot.membership.index <= snapshot.lastIncludedIndex
        && configuration(snapshot.membership.configuration, roster)))
      && Array.isArray(snapshot.state) && snapshot.state.every(pair => Array.isArray(pair) && pair.length === 2
        && isOperation({ type: 'put', key: pair[0], value: pair[1] }));
  }
  return index(value.prevLogIndex) && index(value.prevLogTerm) && index(value.leaderCommit)
    && (value.readId === undefined || index(value.readId))
    && Array.isArray(value.entries) && value.entries.every(entry =>
      record(entry) && index(entry.term) && record(entry.command)
      && (entry.command.type === 'noop'
        || (entry.command.type === 'configure' && configuration(entry.command.configuration, roster))
        || (isOperation(entry.command) && entry.command.type !== 'get')));
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
  faultEnabled: boolean, membershipEnabled = false,
) {
  const write = batchWrites(node, flush);
  const roster = [node.status().nodeId, ...peers];

  /** Follower 只返回自己的已应用状态。Safe 模式必须先拿到本次请求的新鲜读索引。 */
  async function followerRead(response: ServerResponse, key: string, consistency: 'stale' | 'safe-follower') {
    const { nodeId, role, leader, voter } = node.status();
    if (role !== 'follower') return send(response, 409, { ok: false, error: 'NOT_FOLLOWER', leader });
    if (consistency === 'stale') {
      return send(response, 200, { ok: true, consistency, nodeId, ...node.readLocal(key) });
    }
    if (!voter) return send(response, 409, { ok: false, error: 'NOT_VOTER', leader });

    const deadline = performance.now() + 2200;
    const barrier = leader === null ? undefined : await transport.requestReadIndex(leader);
    while (barrier && performance.now() < deadline) {
      const state = node.status();
      if (state.role !== 'follower') {
        return send(response, 409, { ok: false, error: 'NOT_FOLLOWER', leader: state.leader });
      }
      if (!state.voter) return send(response, 409, { ok: false, error: 'NOT_VOTER', leader: state.leader });
      if (state.lastApplied >= barrier.readIndex) {
        return send(response, 200, {
          ok: true, consistency, nodeId, term: barrier.term, readIndex: barrier.readIndex, ...node.readLocal(key),
        });
      }
      await sleep(10);
    }
    return send(response, 503, { ok: false, error: 'NO_QUORUM', leader: node.status().leader });
  }

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
      // 压缩后只对保留日志算日志摘要，应用摘要可跨不同快照边界比较。
      const committedDigest = createHash('sha256').update(JSON.stringify(node.committedEntries())).digest('hex');
      const appliedDigest = createHash('sha256').update(JSON.stringify(node.appliedState())).digest('hex');
      return send(response, 200, { ...node.status(), committedDigest, appliedDigest });
    }
    if (request.method === 'POST' && path === '/internal/raft/snapshot' && faultEnabled) {
      const compacted = node.compact();
      const { nodeId, snapshotIndex, snapshotTerm, retainedEntries } = node.status();
      const details = { nodeId, compacted, snapshotIndex, snapshotTerm, retainedEntries };
      if (compacted) console.log(JSON.stringify({ kind: 'raft.snapshot.compacted', ...details }));
      return send(response, 200, details);
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
      const consistency = url.searchParams.get('consistency');
      if (consistency === 'stale' || consistency === 'safe-follower') return followerRead(response, key, consistency);
      if (consistency !== null) return send(response, 400, { error: 'INVALID_CONSISTENCY' });
      return execute({ type: 'get', key });
    }
    const kind = rpcKinds.find(candidate => path === rpcPath[candidate]);
    const readIndex = path === rpcPath.readIndex;
    const fault = path === '/internal/fault/links' && faultEnabled;
    const change = path === '/internal/raft/membership' && membershipEnabled;
    // 只接受 POST 的内部 RPC、故障端点和 KV 写路径；其余路径 404。
    if (request.method !== 'POST'
        || (!kind && !readIndex && !fault && !change && path !== '/kv/put' && path !== '/kv/delete')) {
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

    if (kind || readIndex) {
      const { from } = body;
      // RPC 来源必须是配置中的其他成员。
      if (typeof from !== 'string' || !peers.includes(from)) {
        return send(response, 400, { error: 'INVALID_RPC' });
      }
      // 入站阻断与出站共用同一集合；被阻断的 RPC 在进入协议核心前返回 503。
      if (transport.isBlocked(from)) return send(response, 503, { error: 'LINK_BLOCKED' });
      if (kind) {
        const rpc = body.request;
        if (!isRpc(rpc, kind, roster)) return send(response, 400, { error: 'INVALID_RPC' });
        const reply = node.receiveRequest(from, rpc, performance.now());
        flush();
        return send(response, 200, reply);
      }
      const barrier = node.readBarrier(performance.now());
      flush();
      return send(response, 200, await barrier);
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
    if (change) {
      if (!voterList(body.voters, roster)) return send(response, 400, { ok: false, error: 'INVALID_VOTERS' });
      const result = node.changeMembership(body.voters, performance.now());
      flush();
      return send(response, result.ok ? 202 : result.error === 'INVALID_VOTERS' ? 400 : 409, result);
    }
    // put/delete 在边界补齐 type 后复用契约校验；非法 key 或值返回 400。
    const operation = path === '/kv/put'
      ? { type: 'put', key: body.key, value: body.value }
      : { type: 'delete', key: body.key };
    if (!isOperation(operation)) return send(response, 400, { error: 'INVALID_OPERATION' });
    return execute(operation);
  };
}
