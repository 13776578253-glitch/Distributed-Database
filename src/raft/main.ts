import { createServer } from 'node:http';
import { HttpTransport } from './adapters/http-transport.ts';
import { sqliteStorage } from './adapters/sqlite.ts';
import { raftHttp } from './api/http.ts';
import { nodeIds } from './config.ts';
import { RaftNode } from './core/node.ts';
import type { RpcRequest } from './core/types.ts';

const nodeId = process.env.NODE_ID;
if (!nodeId || !nodeIds.includes(nodeId)) throw new Error('NODE_ID must identify a Raft member');
const peers = nodeIds.filter(id => id !== nodeId);
const transport = new HttpTransport(nodeId);
const node = new RaftNode({
  id: nodeId, peers, storage: sqliteStorage('/data/raft.sqlite'),
  now: performance.now(), electionTimeout: () => 400 + Math.random() * 350,
  heartbeatMs: 75, requestMs: 1800,
});
const inFlight = new Set<string>();
const queued = new Map<string, RpcRequest>();

function flush() {
  for (const [peer, request] of node.drain()) queued.set(peer, request);
  const { term, role } = node.status();
  for (const [peer, request] of queued) {
    if (inFlight.has(peer)) continue;
    queued.delete(peer);
    const sendingRole = request.kind === 'vote' ? 'candidate' : 'leader';
    if (request.term !== term || role !== sendingRole) continue;

    inFlight.add(peer);
    void transport.send(peer, request).then(reply => {
      if (reply) node.receiveReply(peer, request, reply, performance.now());
    }).finally(() => {
      inFlight.delete(peer);
      flush();
    });
  }
}

createServer(raftHttp(node, peers, transport, flush, process.env.FAULTS_ENABLED === '1')).listen(8080);
let previous = '';
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
