/**
 * Process entrypoint for one Raft member. Owns environment validation,
 * dependency assembly, the 15 ms protocol timer, and the single-flight
 * outbound queue. All protocol state lives in RaftNode.
 */
import { createServer } from 'node:http';
import { HttpTransport } from './adapters/http-transport.ts';
import { sqliteStorage } from './adapters/sqlite.ts';
import { raftHttp } from './api/http.ts';
import { labNodeIds, membershipLab, nodeIds } from './config.ts';
import { RaftNode } from './core/node.ts';
import type { RpcRequest } from './core/types.ts';

// 节点身份必须来自固定成员表；缺失或拼写错误直接拒绝启动。
const nodeId = process.env.NODE_ID;
if (!nodeId || !labNodeIds.includes(nodeId)) throw new Error('NODE_ID must identify a provisioned Raft node');
const peers = labNodeIds.filter(id => id !== nodeId);
const transport = new HttpTransport(nodeId);
// 选举超时 400–750ms、心跳 75ms、客户端请求 1800ms；统一使用 performance.now() 的毫秒时钟。
const node = new RaftNode({
  id: nodeId, peers, initialVoters: nodeIds, storage: sqliteStorage('/data/raft.sqlite'),
  now: performance.now(), electionTimeout: () => 400 + Math.random() * 350,
  heartbeatMs: 75, requestMs: 1800,
});
/** 每个 peer 的在途标记，保证同一时刻最多一个 RPC。 */
const inFlight = new Set<string>();
/** 每个 peer 待发的最新消息；新消息覆盖旧消息，不排队重放历史进度。 */
const queued = new Map<string, RpcRequest>();

/** 把核心 outbox 合并进待发队列，并在任期和角色仍匹配时逐 peer 发送。 */
function flush() {
  // 同一 peer 只保留最新消息；被覆盖的旧消息无需补发。
  for (const [peer, request] of node.drain()) queued.set(peer, request);
  const { term, role } = node.status();
  for (const [peer, request] of queued) {
    if (inFlight.has(peer)) continue;
    queued.delete(peer);
    const sendingRole = request.kind === 'vote' ? 'candidate' : 'leader';
    // 发送前重新核对任期与角色，避免把旧任期或降级前的消息发出去。
    if (request.term !== term || role !== sendingRole) continue;

    inFlight.add(peer);
    void transport.send(peer, request).then(reply => {
      if (reply) node.receiveReply(peer, request, reply, performance.now());
    }).finally(() => {
      inFlight.delete(peer);
      // 应答处理完立即继续冲刷，避免下一批日志等待 15ms 轮询。
      flush();
    });
  }
}

// 进程监听 8080；故障注入端点仅在实验 Compose 中启用。
createServer(raftHttp(node, peers, transport, flush, process.env.FAULTS_ENABLED === '1', membershipLab)).listen(8080);
let previous = '';
// 15ms 推进协议定时器；状态元组变化时输出一行角色事件。
setInterval(() => {
  node.tick(performance.now());
  flush();
  const { role, term, leader } = node.status();
  const state = `${term}/${role}/${leader}`;
  if (state !== previous) {
    console.log(JSON.stringify({ kind: 'raft.role', nodeId, role, term, leader }));
    previous = state;
  }
}, 15);
