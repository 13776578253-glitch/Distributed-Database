import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { RaftNode } from '/app/src/raft/core/node.ts';
import { sqliteStorage } from '/app/src/raft/adapters/sqlite.ts';

const ids = ['a', 'b', 'c', 'd', 'e'];
const nodes = new Map();
const stores = new Map();
let now = 0;

function start(id, storage = sqliteStorage(`/data/cross-term-${id}.sqlite`)) {
  stores.set(id, storage);
  const node = new RaftNode({
    id, peers: ids.filter(peer => peer !== id), storage, now,
    electionTimeout: () => 100 + ids.indexOf(id) * 50, heartbeatMs: 20, requestMs: 300,
  });
  nodes.set(id, node);
  return node;
}

function pump(allow = () => true) {
  for (let turn = 0; turn < 50; turn++) {
    const packets = [...nodes].flatMap(([from, node]) =>
      node.drain().map(([to, request]) => ({ from, to, request })));
    if (packets.length === 0) return;
    for (const { from, to, request } of packets) {
      if (!allow(request)) continue;
      const reply = nodes.get(to).receiveRequest(from, request, now);
      nodes.get(from).receiveReply(to, request, reply, now);
    }
  }
  throw new Error('transport did not become idle');
}

function tick(time, allow) {
  now = time;
  for (const node of nodes.values()) node.tick(now);
  pump(allow);
}

for (const id of ids) start(id);
const oldTermLeader = nodes.get('a');
tick(100, request => request.kind === 'vote');
assert.equal(oldTermLeader.status().role, 'leader');
for (let n = 0; n < 64; n++) {
  void oldTermLeader.execute({ type: 'put', key: 'cross-term', value: n }, now);
}
assert.equal(stores.get('a').load().entries.length, 65);
assert.equal(oldTermLeader.status().commitIndex, 0);

const newTermLeader = start('a');
tick(200, request => request.kind === 'vote' || request.prevLogIndex === 65
  || request.entries.every(entry => entry.term === 1));
const blocked = newTermLeader.status();
const copyCounts = Object.fromEntries(ids.map(id => [
  id, stores.get(id).load().entries.filter(entry => entry.term === 1).length,
]));
assert.deepEqual(copyCounts, { a: 65, b: 64, c: 64, d: 64, e: 64 });
assert.equal(blocked.term, 2);
assert.equal(blocked.commitIndex, 0);
assert.equal(blocked.lastApplied, 0);
console.log(JSON.stringify({
  experiment: 'cross-term', state: 'current-term-entry-blocked', oldTermEntries: copyCounts, ...blocked,
}));

tick(220);
assert.equal(newTermLeader.status().commitIndex, 66);
assert.equal(newTermLeader.status().lastApplied, 66);
for (const node of nodes.values()) assert.deepEqual(node.committedEntries(), newTermLeader.committedEntries());
const read = newTermLeader.execute({ type: 'get', key: 'cross-term' }, now);
pump();
assert.deepEqual(await read, { ok: true, result: { found: true, value: 63 } });
console.log(JSON.stringify({
  experiment: 'cross-term', state: 'current-term-entry-released', ...newTermLeader.status(), value: 63,
}));

const writerCode = `
  import { RaftNode } from '/app/src/raft/core/node.ts';
  import { sqliteStorage } from '/app/src/raft/adapters/sqlite.ts';
  const node = new RaftNode({
    id: 'b', peers: ['a', 'c', 'd', 'e'], storage: sqliteStorage('/data/sigkill.sqlite'),
    now: 0, electionTimeout: () => 100, heartbeatMs: 20, requestMs: 300,
  });
  const vote = node.receiveRequest('a', {kind:'vote', term:7, lastLogIndex:0, lastLogTerm:0}, 0);
  const append = node.receiveRequest('a', {
    kind:'append', term:7, prevLogIndex:0, prevLogTerm:0, leaderCommit:1,
    entries:[{term:7, command:{type:'put', key:'durable', value:'acknowledged'}}],
  }, 0);
  console.log(JSON.stringify({vote, append, status:node.status()}));
  setInterval(() => {}, 1000);
`;
const writer = spawn(process.execPath, ['--input-type=module', '-e', writerCode], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const output = createInterface({ input: writer.stdout });
const [ack] = await once(output, 'line');
const acknowledged = JSON.parse(ack);
assert.equal(acknowledged.vote.granted, true);
assert.equal(acknowledged.append.success, true);
const exited = once(writer, 'exit');
writer.kill('SIGKILL');
const [exitCode, signal] = await exited;
assert.equal(signal, 'SIGKILL');

const reopened = sqliteStorage('/data/sigkill.sqlite');
const hardState = reopened.load();
assert.deepEqual(hardState, {
  term: 7, votedFor: 'a', entries: [{ term: 7, command: { type: 'put', key: 'durable', value: 'acknowledged' } }],
});
const recoveredNode = new RaftNode({
  id: 'b', peers: ['a', 'c', 'd', 'e'], storage: reopened,
  now: 0, electionTimeout: () => 100, heartbeatMs: 20, requestMs: 300,
});
const voteAgain = recoveredNode.receiveRequest('c', {
  kind: 'vote', term: 7, lastLogIndex: 1, lastLogTerm: 7,
}, 0);
assert.equal(voteAgain.granted, false);
recoveredNode.receiveRequest('a', {
  kind: 'append', term: 7, prevLogIndex: 1, prevLogTerm: 7, leaderCommit: 1, entries: [],
}, 0);
assert.equal(recoveredNode.status().lastApplied, 1);
console.log(JSON.stringify({
  experiment: 'sqlite-sigkill', acknowledged, exitCode, signal, hardState,
  sameTermSecondVoteGranted: voteAgain.granted, recovered: recoveredNode.status(),
}));
