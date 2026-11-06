import { describe, expect, it } from 'vitest';
import { RaftNode } from '../../src/raft/core/node.ts';
import type { Entry, HardState, RpcRequest, Storage } from '../../src/raft/core/types.ts';

class MemoryStorage implements Storage {
  hard: HardState = { term: 0, votedFor: null };
  entries: Entry[] = [];

  load() {
    return structuredClone({ ...this.hard, entries: this.entries });
  }

  saveHardState(state: HardState) {
    this.hard = { ...state };
  }

  replaceSuffix(fromIndex: number, entries: Entry[]) {
    this.entries.splice(fromIndex - 1, this.entries.length, ...structuredClone(entries));
  }
}

const ids = ['a', 'b', 'c', 'd', 'e'];
type Packet = { from: string; to: string; request: RpcRequest };
type Link = (packet: Packet) => boolean;

class Cluster {
  now = 0;
  readonly stores = new Map(ids.map(id => [id, new MemoryStorage()]));
  readonly nodes = new Map<string, RaftNode>();

  start(id: string) {
    const node = new RaftNode({
      id, peers: ids.filter(peer => peer !== id), storage: this.stores.get(id)!,
      now: this.now, electionTimeout: () => 100 + ids.indexOf(id) * 50,
      heartbeatMs: 20, requestMs: 300,
    });
    this.nodes.set(id, node);
    return node;
  }

  node(id: string) {
    return this.nodes.get(id)!;
  }

  step(ms: number, forward?: Link) {
    this.now += ms;
    for (const node of this.nodes.values()) node.tick(this.now);
    this.pump(forward);
  }

  drain(): Packet[] {
    return [...this.nodes].flatMap(([from, node]) =>
      node.drain().map(([to, request]) => ({ from, to, request })));
  }

  deliver({ from, to, request }: Packet) {
    const target = this.nodes.get(to);
    if (!target) return;
    const reply = target.receiveRequest(from, request, this.now);
    this.node(from).receiveReply(to, request, reply, this.now);
  }

  pump(forward: Link = () => true) {
    for (let turn = 0; turn < 50; turn++) {
      const packets = this.drain();
      if (packets.length === 0) return;
      for (const packet of packets) {
        if (forward(packet)) this.deliver(packet);
      }
    }
    throw new Error('network did not become idle');
  }
}

function startCluster() {
  const cluster = new Cluster();
  for (const id of ids) cluster.start(id);
  return cluster;
}

describe('Raft core', () => {
  it('persists a vote before responding and denies another candidate after restart', () => {
    const cluster = startCluster();
    const request = { kind: 'vote', term: 1, lastLogIndex: 0, lastLogTerm: 0 } as const;
    expect(cluster.node('b').receiveRequest('a', request, 0)).toEqual({
      kind: 'vote', term: 1, granted: true,
    });
    expect(cluster.stores.get('b')!.hard).toEqual({ term: 1, votedFor: 'a' });
    expect(cluster.start('b').receiveRequest('c', request, 0)).toEqual({
      kind: 'vote', term: 1, granted: false,
    });
  });

  it('compares log terms before lengths when voting', () => {
    const cluster = startCluster();
    const storage = cluster.stores.get('b')!;
    storage.hard = { term: 3, votedFor: null };
    storage.entries = [{ term: 3, command: { type: 'noop' } }];
    const node = cluster.start('b');
    expect(node.receiveRequest('a', {
      kind: 'vote', term: 4, lastLogIndex: 10, lastLogTerm: 2,
    }, 0)).toMatchObject({ term: 4, granted: false });
    expect(node.receiveRequest('c', {
      kind: 'vote', term: 4, lastLogIndex: 1, lastLogTerm: 3,
    }, 0)).toMatchObject({ term: 4, granted: true });
  });

  it('confirms writes only after durable replication and ordered application', async () => {
    const cluster = startCluster();
    cluster.step(100);
    const leader = cluster.node('a');
    expect(leader.status()).toMatchObject({ role: 'leader', term: 1, ready: true });
    const operation = { type: 'put', key: 'k', value: null } as const;
    const write = leader.execute(operation, cluster.now);
    cluster.pump(({ to }) => to === 'b');
    expect(leader.status().commitIndex).toBe(1);
    cluster.step(20);
    expect(await write).toEqual({ ok: true, result: { stored: true } });
    for (const storage of cluster.stores.values()) {
      expect(storage.entries[1]).toEqual({ term: 1, command: operation });
    }
    const read = leader.execute({ type: 'get', key: 'k' }, cluster.now);
    cluster.pump();
    expect(await read).toEqual({ ok: true, result: { found: true, value: null } });
    const deletion = leader.execute({ type: 'delete', key: 'k' }, cluster.now);
    cluster.pump();
    expect(await deletion).toEqual({ ok: true, result: { deleted: true } });
    const missing = leader.execute({ type: 'get', key: 'k' }, cluster.now);
    cluster.pump();
    expect(await missing).toEqual({ ok: true, result: { found: false } });
  });

  it('does not commit an old-term batch stored by a quorum before its current-term no-op', () => {
    const cluster = new Cluster();
    const store = cluster.stores.get('a')!;
    store.hard = { term: 1, votedFor: 'a' };
    store.entries = Array.from({ length: 65 }, () => ({ term: 1, command: { type: 'noop' } }));
    for (const id of ids) cluster.start(id);

    cluster.step(100, ({ request }) => request.kind === 'vote' || request.prevLogIndex === 65
      || request.entries.every(entry => entry.term === 1));
    for (const id of ids.slice(1)) expect(cluster.stores.get(id)!.entries).toHaveLength(64);
    expect(cluster.node('a').status()).toMatchObject({ term: 2, commitIndex: 0, ready: false });

    cluster.step(20);
    for (const node of cluster.nodes.values()) {
      expect(node.status()).toMatchObject({ commitIndex: 66, lastApplied: 66 });
    }
  });

  it('waits for the new-term no-op and a quorum for this read', async () => {
    const cluster = startCluster();
    cluster.step(100, ({ request }) => request.kind === 'vote');
    const leader = cluster.node('a');
    expect(leader.status().ready).toBe(false);
    let finished = false;
    const read = leader.execute({ type: 'get', key: 'missing' }, cluster.now);
    void read.then(() => { finished = true; });
    const noOpPackets = cluster.drain();
    for (const packet of noOpPackets) cluster.deliver(packet);
    expect(leader.status().ready).toBe(true);
    await Promise.resolve();
    expect(finished).toBe(false);
    cluster.pump();
    expect(await read).toEqual({ ok: true, result: { found: false } });
  });

  it('times out minority operations and replaces the conflicting suffix after healing', async () => {
    const cluster = startCluster();
    cluster.step(100);
    const oldLeader = cluster.node('a');
    const minority = new Set(['a', 'e']);
    const partition: Link = ({ from, to }) => minority.has(from) === minority.has(to);
    const lost = oldLeader.execute({ type: 'put', key: 'k', value: 'minority' }, cluster.now);
    const staleRead = oldLeader.execute({ type: 'get', key: 'k' }, cluster.now);
    cluster.pump(partition);
    cluster.step(150, partition);

    const newLeader = cluster.node('b');
    expect(newLeader.status()).toMatchObject({ term: 2, role: 'leader', ready: true });
    const kept = newLeader.execute({ type: 'put', key: 'k', value: 'majority' }, cluster.now);
    cluster.pump(partition);
    expect(await kept).toEqual({ ok: true, result: { stored: true } });

    cluster.step(150, partition);
    expect(await lost).toMatchObject({ ok: false, error: 'UNKNOWN_OUTCOME' });
    expect(await staleRead).toMatchObject({ ok: false, error: 'NO_QUORUM' });

    cluster.step(20);
    expect(oldLeader.status()).toMatchObject({ role: 'follower', term: 2, leader: 'b' });
    for (const node of cluster.nodes.values()) {
      expect(node.committedEntries()).toEqual(newLeader.committedEntries());
    }
  });

  it('replays a confirmed write from storage after all nodes restart', async () => {
    const cluster = startCluster();
    cluster.step(100);
    const write = cluster.node('a').execute({ type: 'put', key: 'saved', value: true }, cluster.now);
    cluster.pump();
    expect(await write).toMatchObject({ ok: true });
    for (const id of ids) cluster.start(id);

    cluster.step(100);
    const read = cluster.node('a').execute({ type: 'get', key: 'saved' }, cluster.now);
    cluster.pump();
    expect(await read).toEqual({ ok: true, result: { found: true, value: true } });
  });
});
