import { describe, expect, it, vi } from 'vitest';
import { RaftNode } from '../../src/raft/core/node.ts';
import type { Entry, HardState, RpcRequest, Snapshot, Storage } from '../../src/raft/core/types.ts';

class MemoryStorage implements Storage {
  hard: HardState = { term: 0, votedFor: null };
  entries: Entry[] = [];
  snapshot?: Snapshot;

  load() {
    return structuredClone({ ...this.hard, entries: this.entries, snapshot: this.snapshot });
  }

  saveHardState(state: HardState) {
    this.hard = { ...state };
  }

  replaceSuffix(fromIndex: number, entries: Entry[]) {
    const base = this.snapshot?.lastIncludedIndex ?? 0;
    this.entries.splice(fromIndex - base - 1, this.entries.length, ...structuredClone(entries));
  }

  saveSnapshot(snapshot: Snapshot, retainSuffix: boolean) {
    const base = this.snapshot?.lastIncludedIndex ?? 0;
    this.entries = retainSuffix ? this.entries.slice(snapshot.lastIncludedIndex - base) : [];
    this.snapshot = structuredClone(snapshot);
  }
}

const ids = ['a', 'b', 'c', 'd', 'e'];
type Packet = { from: string; to: string; request: RpcRequest };
type Link = (packet: Packet) => boolean;

class Cluster {
  now = 0;
  readonly stores = new Map(ids.map(id => [id, new MemoryStorage()]));
  readonly nodes = new Map<string, RaftNode>();
  readonly initialVoters?: readonly string[];

  constructor(initialVoters?: readonly string[]) {
    this.initialVoters = initialVoters;
  }

  start(id: string) {
    const node = new RaftNode({
      id, peers: ids.filter(peer => peer !== id), storage: this.stores.get(id)!, initialVoters: this.initialVoters,
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

function startCluster(initialVoters?: readonly string[]) {
  const cluster = new Cluster(initialVoters);
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

  it('persists a write batch once and confirms only its committed prefix', async () => {
    const cluster = startCluster();
    cluster.step(100);
    const leader = cluster.node('a');
    const persist = vi.spyOn(cluster.stores.get('a')!, 'replaceSuffix');
    const commands = Array.from({ length: 65 }, (_, value) => ({ type: 'put', key: 'batch', value } as const));
    const writes = leader.executeWrites(commands, cluster.now);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][1]).toHaveLength(65);
    let lastConfirmed = false;
    void writes[64].then(() => { lastConfirmed = true; });

    cluster.pump(({ request }) => request.kind !== 'append' || request.entries.length === 0
      || request.prevLogIndex === 1);
    expect(await Promise.all(writes.slice(0, 64))).toEqual(Array(64).fill({ ok: true, result: { stored: true } }));
    expect(leader.status()).toMatchObject({ commitIndex: 65, lastApplied: 65 });
    expect(lastConfirmed).toBe(false);
    cluster.step(20);
    expect(await writes[64]).toEqual({ ok: true, result: { stored: true } });
  });

  it('rejects a queued batch from an earlier term without appending it', async () => {
    const cluster = startCluster();
    cluster.step(100);
    const leader = cluster.node('a');
    const store = cluster.stores.get('a')!;
    const pending = leader.executeWrites([{ type: 'delete', key: 'k' }], cluster.now, 0);
    expect(await pending[0]).toMatchObject({ ok: false, error: 'NOT_LEADER' });
    expect(store.entries).toHaveLength(1);
  });

  it('does not commit an old-term batch stored by a quorum before its current-term no-op', () => {
    const cluster = new Cluster();
    const store = cluster.stores.get('a')!;
    store.hard = { term: 1, votedFor: 'a' };
    store.entries = Array.from({ length: 65 }, () => ({ term: 1, command: { type: 'noop' } }));
    for (const id of ids) cluster.start(id);

    cluster.step(100, ({ request }) => request.kind !== 'append' || request.prevLogIndex === 65
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

  it('issues a fresh barrier for every follower read index request', async () => {
    const cluster = startCluster();
    cluster.step(100);
    const leader = cluster.node('a');
    const first = leader.readBarrier(cluster.now);
    cluster.pump();
    expect(await first).toEqual({ ok: true, term: 1, readIndex: 1 });
    const next = leader.readBarrier(cluster.now);
    cluster.step(300, () => false);
    expect(await next).toMatchObject({ ok: false, error: 'NO_QUORUM' });
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

  it('restores the applied snapshot while holding an unconfirmed suffix for later application', async () => {
    const cluster = startCluster();
    cluster.step(100);
    const leader = cluster.node('a');
    const committed = leader.execute({ type: 'put', key: 'base', value: null }, cluster.now);
    cluster.pump();
    await committed;
    void leader.execute({ type: 'put', key: 'tail', value: 'later' }, cluster.now);
    expect(leader.compact()).toBe(true);
    expect(leader.compact()).toBe(false);
    expect(leader.status()).toMatchObject({ snapshotIndex: 2, logLength: 3, retainedEntries: 1 });

    const restarted = cluster.start('a');
    expect(restarted.status()).toMatchObject({ commitIndex: 2, lastApplied: 2, logLength: 3 });
    expect(restarted.readLocal('base').result).toEqual({ found: true, value: null });
    expect(restarted.readLocal('tail').result).toEqual({ found: false });
    restarted.receiveRequest('b', {
      kind: 'append', term: 2, prevLogIndex: 3, prevLogTerm: 1, entries: [], leaderCommit: 3,
    }, cluster.now);
    expect(restarted.readLocal('tail')).toEqual({ appliedIndex: 3, result: { found: true, value: 'later' } });
  });

  it.each([true, false])('installs a snapshot with retainSuffix=%s and ignores an older snapshot', retainSuffix => {
    const cluster = new Cluster();
    const store = cluster.stores.get('b')!;
    store.hard = { term: 2, votedFor: null };
    store.entries = [
      { term: 1, command: { type: 'noop' } },
      { term: retainSuffix ? 2 : 1, command: { type: 'noop' } },
      { term: 2, command: { type: 'put', key: 'tail', value: 3 } },
    ];
    const follower = cluster.start('b');
    const snapshot: Snapshot = { lastIncludedIndex: 2, lastIncludedTerm: 2, state: [['base', 'fresh']] };
    expect(follower.receiveRequest('a', { kind: 'snapshot', term: 3, snapshot }, 0))
      .toEqual({ kind: 'snapshot', term: 3, success: true });
    expect(store.snapshot).toEqual(snapshot);
    expect(store.entries).toHaveLength(retainSuffix ? 1 : 0);
    expect(follower.status()).toMatchObject({ snapshotIndex: 2, commitIndex: 2, lastApplied: 2 });
    expect(follower.readLocal('tail').result).toEqual({ found: false });

    const stale = { ...snapshot, lastIncludedIndex: 1, state: [] };
    expect(follower.receiveRequest('a', { kind: 'snapshot', term: 2, snapshot: stale }, 0))
      .toEqual({ kind: 'snapshot', term: 3, success: false });
    follower.receiveRequest('a', { kind: 'snapshot', term: 3, snapshot: stale }, 0);
    expect(store.snapshot).toEqual(snapshot);
    expect(follower.readLocal('base').result).toEqual({ found: true, value: 'fresh' });
  });

  it('sends the installed snapshot before the retained log to a lagging follower', async () => {
    const cluster = startCluster();
    const hold = ({ to }: Packet) => to !== 'e';
    cluster.step(100, hold);
    const leader = cluster.node('a');
    const before = leader.execute({ type: 'put', key: 'base', value: true }, cluster.now);
    cluster.pump(hold);
    await before;
    leader.compact();
    const tail = leader.execute({ type: 'put', key: 'tail', value: true }, cluster.now);
    cluster.pump(hold);
    await tail;

    const sent: RpcRequest[] = [];
    cluster.step(20, ({ to, request }) => {
      if (to === 'e') sent.push(request);
      return true;
    });
    expect(sent[0]).toMatchObject({ kind: 'snapshot', snapshot: { lastIncludedIndex: 2 } });
    expect(sent.some(request => request.kind === 'append' && request.prevLogIndex === 2)).toBe(true);
    expect(cluster.node('e').status()).toMatchObject({ snapshotIndex: 2, logLength: 3, lastApplied: 3 });
    expect(cluster.node('e').appliedState()).toEqual(leader.appliedState());
  });

  it('uses a compacted follower hint to probe forward from an unconfirmed index', async () => {
    const cluster = startCluster();
    const hold = ({ to }: Packet) => to !== 'e';
    cluster.step(100, hold);
    const leader = cluster.node('a');
    const committed = leader.execute({ type: 'put', key: 'base', value: true }, cluster.now);
    cluster.pump(hold);
    await committed;
    const follower = cluster.node('e');
    follower.receiveRequest('a', {
      kind: 'append', term: 1, prevLogIndex: 0, prevLogTerm: 0,
      entries: cluster.stores.get('a')!.entries, leaderCommit: 2,
    }, cluster.now);
    // e 的 ACK 未送达，Leader 仍从索引 1 开始试探。
    follower.compact();
    const attempted: number[] = [];
    cluster.step(20, ({ to, request }) => {
      if (to === 'e' && request.kind === 'append') attempted.push(request.prevLogIndex);
      return true;
    });
    expect(attempted).toEqual([0, 2]);
    expect(follower.appliedState()).toEqual(leader.appliedState());
  });
});

describe('joint membership', () => {
  const old = ['a', 'b', 'c'];
  const target = ['a', 'd', 'e'];

  it.each(['b', 'd'])('does not commit or certify a read with only %s on one side', async peer => {
    const cluster = startCluster(old);
    cluster.step(100);
    const leader = cluster.node('a');
    const change = leader.changeMembership(target, cluster.now);
    expect(change).toEqual({ ok: true, jointIndex: 2 });
    const allow = ({ to }: Packet) => to === peer;
    cluster.pump(allow);
    expect(leader.status()).toMatchObject({ commitIndex: 1, logLength: 2 });
    expect(leader.changeMembership(['a', 'b'], cluster.now)).toEqual({ ok: false, error: 'CONFIG_IN_PROGRESS' });
    const read = leader.readBarrier(cluster.now);
    cluster.pump(allow);
    leader.tick(cluster.now + 300);
    expect(await read).toMatchObject({ ok: false, error: 'NO_QUORUM' });
  });

  it.each(['b', 'd'])('does not elect a joint candidate with only the %s-side majority', peer => {
    const cluster = new Cluster(old);
    const joint = { voters: old, next: target };
    for (const id of ['a', peer]) {
      cluster.stores.get(id)!.entries = [{ term: 0, command: { type: 'configure', configuration: joint } }];
    }
    for (const id of ids) cluster.start(id);
    cluster.step(100, ({ to }) => to === peer);
    expect(cluster.node('a').status().role).toBe('candidate');
  });

  it('requires a new voter to have caught up and keeps a standby out of elections', () => {
    const cluster = startCluster(old);
    cluster.step(100, ({ to }) => to !== 'd');
    const leader = cluster.node('a');
    expect(leader.changeMembership([...old, 'd'], cluster.now)).toEqual({ ok: false, error: 'MEMBER_NOT_CAUGHT_UP' });
    cluster.node('d').tick(2000);
    expect(cluster.node('d').status()).toMatchObject({ role: 'follower', term: 0, voter: false });
  });

  it('recovers a replicated, uncommitted joint entry after leader loss', () => {
    const cluster = startCluster(old);
    cluster.step(100);
    const leader = cluster.node('a');
    const joined = ['a', 'b', 'c', 'd', 'e'];
    expect(leader.changeMembership(joined, cluster.now)).toEqual({ ok: true, jointIndex: 2 });
    cluster.pump(({ to }) => to === 'b');
    expect(leader.status().commitIndex).toBe(1);
    expect(cluster.node('b').status().membership.index).toBe(2);
    cluster.nodes.delete('a');

    cluster.step(150);
    const next = cluster.node('b');
    expect(next.status()).toMatchObject({
      role: 'leader', term: 2, commitIndex: 4,
      appliedMembership: { index: 4, configuration: { voters: joined } },
    });
    expect(next.committedEntries().filter(entry => entry.command.type === 'configure')).toHaveLength(2);
  });

  it('restores membership after conflict rollback, final removal, and compaction', async () => {
    const cluster = startCluster(old);
    cluster.step(100);
    const follower = cluster.node('b');
    follower.receiveRequest('a', {
      kind: 'append', term: 1, prevLogIndex: 1, prevLogTerm: 1, leaderCommit: 1,
      entries: [{ term: 1, command: { type: 'configure', configuration: { voters: old, next: target } } }],
    }, 100);
    expect(follower.status().membership.configuration.next).toEqual(target);
    follower.receiveRequest('c', {
      kind: 'append', term: 2, prevLogIndex: 1, prevLogTerm: 1, leaderCommit: 1,
      entries: [{ term: 2, command: { type: 'noop' } }],
    }, 100);
    expect(cluster.start('b').status().membership).toEqual({ index: 0, configuration: { voters: old } });

    const fresh = startCluster(old);
    fresh.step(100);
    const leader = fresh.node('a');
    expect(leader.changeMembership(['b', 'c'], fresh.now)).toEqual({ ok: true, jointIndex: 2 });
    fresh.pump();
    expect(leader.status()).toMatchObject({ role: 'follower', voter: false, commitIndex: 3 });
    expect(await leader.readBarrier(fresh.now)).toMatchObject({ ok: false, error: 'NOT_LEADER' });
    leader.compact();
    const restarted = fresh.start('a');
    restarted.tick(2000);
    expect(restarted.status()).toMatchObject({
      role: 'follower', voter: false, term: 1, snapshotIndex: 3,
      appliedMembership: { index: 3, configuration: { voters: ['b', 'c'] } },
    });
  });
});
