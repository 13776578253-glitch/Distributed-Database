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

describe('membership protocol boundaries', () => {
  const old = ['a', 'b', 'c'];
  const target = ['c', 'd', 'e'];

  async function mixedViews() {
    const cluster = startCluster(old);
    cluster.step(100);
    const leader = cluster.node('a');
    const write = leader.execute({ type: 'put', key: 'stable', value: 'confirmed' }, cluster.now);
    cluster.pump();
    expect(await write).toMatchObject({ ok: true });
    expect(leader.changeMembership(target, cluster.now)).toEqual({ ok: true, jointIndex: 3 });
    cluster.pump(({ to, request }) => {
      if (request.kind !== 'append') return false;
      const hasFinal = request.entries.some(({ command }) =>
        command.type === 'configure' && !command.configuration.next);
      return hasFinal ? to === 'd' : ['b', 'd', 'e'].includes(to);
    });
    const joint = { index: 3, configuration: { voters: old, next: target } };
    const final = { index: 4, configuration: { voters: target } };
    expect(ids.map(id => cluster.node(id).status().membership)).toEqual([
      final, joint, { index: 0, configuration: { voters: old } }, final, joint,
    ]);
    expect(leader.status()).toMatchObject({ role: 'leader', commitIndex: 3, appliedMembership: joint });
    return { cluster, leader, joint, final };
  }

  it.each(['late', 'early'])('preserves committed prefixes with %s final-view votes and mixed-view elections', async order => {
    const { cluster, leader, joint, final } = await mixedViews();
    const committed = leader.committedEntries();
    const elected = new Map([[1, 'a']]);
    const observe = () => {
      for (const [id, node] of cluster.nodes) {
        const { role, term } = node.status();
        if (role === 'leader') {
          const prior = elected.get(term);
          if (prior !== undefined) expect(id).toBe(prior);
          elected.set(term, id);
        }
        for (const [offset, entry] of node.committedEntries().entries()) {
          const prior = committed[offset];
          if (prior === undefined) committed[offset] = entry;
          else expect(entry).toEqual(prior);
        }
      }
    };
    const deliver = (packet: Packet) => {
      cluster.deliver(packet);
      observe();
    };
    cluster.nodes.delete('a');
    const b = cluster.node('b');
    const c = cluster.node('c');
    const d = cluster.node('d');
    const e = cluster.node('e');

    cluster.now = 250;
    b.tick(cluster.now);
    expect(b.status()).toMatchObject({ role: 'candidate', term: 2 });
    cluster.drain();
    cluster.now = 300;
    c.tick(cluster.now);
    const oldVote = cluster.drain().find(packet => packet.from === 'c' && packet.to === 'b')!;
    expect(oldVote.request).toMatchObject({ kind: 'vote', term: 2 });
    cluster.now = 350;
    d.tick(cluster.now);
    const finalVotes = cluster.drain();
    deliver(finalVotes.find(packet => packet.to === 'c')!);
    expect(d.status().role).toBe('candidate');
    const finalVote = finalVotes.find(packet => packet.to === 'e')!;
    expect(finalVote.request).toMatchObject({ kind: 'vote', term: 2, configurationIndex: final.index });
    const finalReply = e.receiveRequest('d', finalVote.request, cluster.now);
    expect(finalReply).toEqual({ kind: 'vote', term: 2, granted: true });
    const electFinal = () => {
      d.receiveReply('e', finalVote.request, finalReply, cluster.now);
      observe();
      expect(d.status()).toMatchObject({ role: 'leader', term: 2 });
    };
    if (order === 'early') {
      electFinal();
      cluster.pump(({ from, to }) => from === 'd' && to === 'e');
      observe();
      expect(d.status()).toMatchObject({ ready: true, commitIndex: 5, appliedMembership: final });
    }

    cluster.now = 400;
    b.tick(cluster.now);
    const jointVotes = cluster.drain();
    expect(jointVotes.filter(packet => packet.from === 'b').map(packet => packet.to)).toEqual(['a', 'c', 'd', 'e']);
    const voteTo = (id: string) => jointVotes.find(packet => packet.from === 'b' && packet.to === id)!;
    expect(voteTo('c').request).toMatchObject({ kind: 'vote', term: 3, configurationIndex: joint.index });
    deliver(voteTo('c'));
    expect(b.status()).toMatchObject({ role: 'candidate', term: 3 });
    deliver(oldVote);
    expect(cluster.stores.get('b')!.hard).toEqual({ term: 3, votedFor: 'b' });
    deliver(voteTo('d'));
    expect(b.status().role).toBe('candidate');
    deliver(voteTo('e'));

    if (order === 'late') {
      expect(b.status()).toMatchObject({ role: 'leader', term: 3, ready: false });
      electFinal();
      // 旧票可使尚未得知新任期的 d 自认当选，但 e 的新任期阻止其提交。
      deliver(cluster.drain().find(packet => packet.from === 'd' && packet.to === 'e')!);
      expect(d.status()).toMatchObject({ role: 'follower', term: 3, commitIndex: 3, appliedMembership: joint });
      cluster.step(20);
      observe();
      expect(committed[3]).toEqual({ term: 3, command: { type: 'noop' } });
    } else {
      expect(b.status()).toMatchObject({ role: 'candidate', term: 3, ready: false });
      expect(committed[3]).toEqual({ term: 1, command: { type: 'configure', configuration: final.configuration } });
      // d 得知更高任期后，携带已提交的最终配置重新竞选。
      cluster.now = 750;
      d.tick(cluster.now);
      cluster.pump(({ from, to }) => from === 'd' && to === 'c');
      expect(d.status()).toMatchObject({ role: 'follower', term: 3, commitIndex: 5 });
      cluster.now += 250;
      d.tick(cluster.now);
      cluster.pump();
      expect(d.status()).toMatchObject({ role: 'leader', term: 4, ready: true });
    }
    observe();
    expect([...elected]).toEqual(order === 'late' ? [[1, 'a'], [3, 'b'], [2, 'd']] : [[1, 'a'], [2, 'd'], [4, 'd']]);
    for (const node of cluster.nodes.values()) {
      expect(node.readLocal('stable').result).toEqual({ found: true, value: 'confirmed' });
    }
  });

  it('elects a joint candidate with votes from added nodes that still hold the old view', () => {
    const cluster = startCluster(old);
    cluster.step(100);
    expect(cluster.node('a').changeMembership(['a', 'd', 'e'], cluster.now)).toEqual({ ok: true, jointIndex: 2 });
    cluster.pump(({ to }) => to === 'b');
    expect(cluster.node('a').status().commitIndex).toBe(1);
    for (const id of ['d', 'e']) {
      expect(cluster.node(id).status()).toMatchObject({ voter: false, membership: { index: 0 } });
    }
    cluster.nodes.delete('a');
    const b = cluster.node('b');
    cluster.now = 250;
    b.tick(cluster.now);
    const votes = cluster.drain();
    for (const id of ['c', 'd', 'e']) {
      expect(b.status().role).toBe('candidate');
      const packet = votes.find(({ to }) => to === id)!;
      expect(packet.request).toMatchObject({ kind: 'vote', term: 2, configurationIndex: 2 });
      cluster.deliver(packet);
      expect(cluster.stores.get(id)!.hard).toEqual({ term: 2, votedFor: 'b' });
    }
    expect(b.status()).toMatchObject({ role: 'leader', term: 2, ready: false, commitIndex: 1 });
  });

  it('derives voters from the snapshot after a real leader overwrites an uncommitted final suffix', async () => {
    const { cluster, leader, joint, final } = await mixedViews();
    const oldStorage = cluster.stores.get('a')!;
    expect(leader.compact()).toBe(true);
    expect(oldStorage.snapshot).toMatchObject({ lastIncludedIndex: joint.index, membership: joint });
    expect(oldStorage.entries).toEqual([{ term: 1, command: { type: 'configure', configuration: final.configuration } }]);
    cluster.nodes.delete('a');

    const held: Packet[] = [];
    cluster.step(150, packet => {
      if (packet.request.kind === 'vote') return true;
      if (packet.from === 'b' && packet.to === 'a') held.push(packet);
      return false;
    });
    expect(cluster.node('b').status()).toMatchObject({ role: 'leader', term: 2, membership: joint });
    expect(held).toHaveLength(1);
    expect(held[0].request).toMatchObject({
      kind: 'append', term: 2, prevLogIndex: joint.index, entries: [{ term: 2, command: { type: 'noop' } }],
    });
    const restarted = cluster.start('a');
    expect(restarted.status()).toMatchObject({ membership: final, appliedMembership: joint, voter: false });
    cluster.deliver(held[0]);
    expect(restarted.status()).toMatchObject({ membership: joint, appliedMembership: joint, voter: true });
    expect(oldStorage.entries).toEqual([{ term: 2, command: { type: 'noop' } }]);
    expect(cluster.start('a').status()).toMatchObject({
      term: 2, snapshotIndex: joint.index, membership: joint, appliedMembership: joint, voter: true,
    });

    cluster.step(20);
    const completed = { index: 5, configuration: final.configuration };
    expect(cluster.node('b').status()).toMatchObject({ role: 'follower', appliedMembership: completed });
    for (const id of ids) {
      expect(cluster.start(id).status()).toMatchObject({ membership: completed, voter: target.includes(id) });
    }
    // 原 Leader 退出后，由最终配置下的下一任 Leader 广播已提交边界。
    cluster.now += 200;
    cluster.node('c').tick(cluster.now);
    cluster.pump();
    expect(cluster.node('c').status()).toMatchObject({ role: 'leader', term: 3, ready: true, commitIndex: 6 });
    for (const id of ids) {
      const state = cluster.node(id).status();
      expect(state).toMatchObject({ membership: completed, appliedMembership: completed, voter: target.includes(id) });
      expect(cluster.node(id).readLocal('stable').result).toEqual({ found: true, value: 'confirmed' });
    }
  });

  it.each([['b', 'd'], ['d', 'b']])('keeps delayed confirmations out of new read barriers when only %s responds', async (one, other) => {
    const cluster = startCluster(old);
    cluster.step(100);
    const leader = cluster.node('a');
    const delay = ({ to, request }: Packet) => {
      expect(request).toMatchObject({ kind: 'append', term: 1, readId: expect.any(Number) });
      const reply = cluster.node(to).receiveRequest('a', request, cluster.now);
      expect(reply).toEqual({ kind: 'append', term: 1, success: true });
      return () => leader.receiveReply(to, request, reply, cluster.now);
    };

    const oldRead = leader.readBarrier(cluster.now);
    const lateOldReplies = cluster.drain().map(delay);
    expect(leader.changeMembership(['a', 'd', 'e'], cluster.now)).toEqual({ ok: true, jointIndex: 2 });
    await expect(oldRead).resolves.toMatchObject({ ok: false, error: 'NO_QUORUM' });

    const jointSettled = vi.fn();
    const jointRead = leader.readBarrier(cluster.now).then(reply => {
      jointSettled(reply);
      return reply;
    });
    const jointPackets = cluster.drain();
    const lateJointReply = delay(jointPackets.find(packet => packet.to === 'e')!);
    for (const reply of lateOldReplies) reply();
    cluster.deliver(jointPackets.find(packet => packet.to === one)!);
    await Promise.resolve();
    expect(jointSettled).not.toHaveBeenCalled();
    expect(leader.status().commitIndex).toBe(1);
    cluster.deliver(jointPackets.find(packet => packet.to === other)!);
    await expect(jointRead).resolves.toMatchObject({ ok: false, error: 'NO_QUORUM' });
    cluster.pump();
    expect(leader.status()).toMatchObject({ commitIndex: 3, membership: { index: 3, configuration: { voters: ['a', 'd', 'e'] } } });

    const finalSettled = vi.fn();
    const finalRead = leader.readBarrier(cluster.now).then(finalSettled);
    const finalPackets = cluster.drain();
    lateJointReply();
    cluster.deliver(finalPackets.find(packet => packet.to === 'b')!);
    await Promise.resolve();
    expect(finalSettled).not.toHaveBeenCalled();
    cluster.deliver(finalPackets.find(packet => packet.to === 'd')!);
    await finalRead;
    expect(finalSettled).toHaveBeenCalledExactlyOnceWith({ ok: true, term: 1, readIndex: 3 });
  });
});
