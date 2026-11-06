import type { Operation, Scalar } from '../../contracts/history.ts';
import type {
  AppendRequest, ClientReply, Command, Entry, HardState, Role, RpcReply, RpcRequest,
  Storage, VoteRequest,
} from './types.ts';

type Pending = { deadline: number; resolve: (reply: ClientReply) => void };
type Progress = { nextIndex: number; matchIndex: number; readAck: number };
type Options = {
  id: string;
  peers: string[];
  storage: Storage;
  now: number;
  electionTimeout: () => number;
  heartbeatMs: number;
  requestMs: number;
};

const APPEND_BATCH = 64;

export class RaftNode {
  private readonly options: Options;
  private readonly quorum: number;
  private readonly log: Entry[];
  private readonly kv = new Map<string, Scalar>();
  private readonly outbox = new Map<string, RpcRequest>();
  private readonly progress = new Map<string, Progress>();
  private readonly votes = new Set<string>();
  private readonly writes = new Map<number, Pending>();
  private readonly reads = new Map<number, Pending & { key: string; readIndex: number }>();
  private hard: HardState;
  private role: Role = 'follower';
  private leader: string | null = null;
  private commitIndex = 0;
  private lastApplied = 0;
  private readId = 0;
  private leaderStartIndex = 0;
  private electionAt: number;
  private heartbeatAt = 0;

  constructor(options: Options) {
    this.options = options;
    const { term, votedFor, entries } = options.storage.load();
    this.hard = { term, votedFor };
    this.log = entries;
    this.quorum = Math.floor((options.peers.length + 1) / 2) + 1;
    this.electionAt = options.now + options.electionTimeout();
  }

  status() {
    return {
      nodeId: this.options.id,
      role: this.role,
      term: this.hard.term,
      leader: this.leader,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      logLength: this.log.length,
      ready: this.role === 'leader' && this.commitIndex >= this.leaderStartIndex,
    };
  }

  committedEntries(): Entry[] {
    return this.log.slice(0, this.commitIndex);
  }

  drain() {
    const messages = [...this.outbox.entries()];
    this.outbox.clear();
    return messages;
  }

  tick(now: number) {
    if (this.role !== 'leader') {
      if (now >= this.electionAt) this.startElection(now);
      return;
    }

    for (const [index, pending] of this.writes) {
      if (now < pending.deadline) continue;
      this.writes.delete(index);
      pending.resolve(this.error('UNKNOWN_OUTCOME'));
    }
    for (const [id, pending] of this.reads) {
      if (now < pending.deadline) continue;
      this.reads.delete(id);
      pending.resolve(this.error('NO_QUORUM'));
    }
    if (now >= this.heartbeatAt) this.replicate(now);
  }

  execute(operation: Operation, now: number): Promise<ClientReply> {
    if (this.role !== 'leader') return Promise.resolve(this.error('NOT_LEADER'));

    return new Promise(resolve => {
      const pending = { deadline: now + this.options.requestMs, resolve };
      if (operation.type === 'get') {
        this.reads.set(++this.readId, { ...pending, key: operation.key, readIndex: this.commitIndex });
        this.completeReads();
      } else {
        const index = this.append(operation);
        this.writes.set(index, pending);
        this.advanceCommit();
      }
      this.replicate(now);
    });
  }

  receiveRequest(from: string, request: RpcRequest, now: number): RpcReply {
    if (request.term > this.hard.term) this.follow(request.term, null, now);
    return request.kind === 'vote'
      ? this.requestVote(from, request, now)
      : this.appendEntries(from, request, now);
  }

  receiveReply(from: string, request: RpcRequest, reply: RpcReply, now: number) {
    if (reply.term > this.hard.term) this.follow(reply.term, null, now);
    if (request.term !== this.hard.term || reply.term !== this.hard.term) return;

    if (request.kind === 'vote' && reply.kind === 'vote') {
      if (this.role !== 'candidate' || !reply.granted) return;
      this.votes.add(from);
      if (this.votes.size >= this.quorum) this.startLeader(now);
      return;
    }
    if (this.role !== 'leader' || request.kind !== 'append' || reply.kind !== 'append') return;

    const peer = this.progress.get(from)!;
    if (!reply.success) {
      // A late failure must not undo a newer successful replication.
      if (request.prevLogIndex === peer.nextIndex - 1 && request.prevLogIndex > peer.matchIndex) {
        peer.nextIndex = Math.max(peer.matchIndex + 1, Math.min(request.prevLogIndex, reply.nextIndex));
        this.sendAppend(from);
      }
      return;
    }

    peer.matchIndex = Math.max(peer.matchIndex, request.prevLogIndex + request.entries.length);
    peer.nextIndex = peer.matchIndex + 1;
    if (request.readId !== undefined) peer.readAck = Math.max(peer.readAck, request.readId);
    const advanced = this.advanceCommit();
    this.completeReads();
    if (advanced) this.replicate(now);
    else if (peer.matchIndex < this.log.length) this.sendAppend(from);
  }

  private error(error: Extract<ClientReply, { ok: false }>['error']): ClientReply {
    return { ok: false, error, leader: this.leader };
  }

  private setHardState(term: number, votedFor: string | null) {
    this.options.storage.saveHardState({ term, votedFor });
    this.hard = { term, votedFor };
  }

  private resetElection(now: number) {
    this.electionAt = now + this.options.electionTimeout();
  }

  private follow(term: number, leader: string | null, now: number) {
    if (term > this.hard.term) this.setHardState(term, null);
    if (this.role !== 'follower') this.resetElection(now);
    this.role = 'follower';
    this.leader = leader;
    this.outbox.clear();
    for (const pending of this.writes.values()) pending.resolve(this.error('UNKNOWN_OUTCOME'));
    for (const pending of this.reads.values()) pending.resolve(this.error('NOT_LEADER'));
    this.writes.clear();
    this.reads.clear();
  }

  private startElection(now: number) {
    this.setHardState(this.hard.term + 1, this.options.id);
    this.role = 'candidate';
    this.leader = null;
    this.resetElection(now);
    this.votes.clear();
    this.votes.add(this.options.id);
    this.outbox.clear();
    if (this.votes.size >= this.quorum) {
      this.startLeader(now);
      return;
    }
    const request: VoteRequest = {
      kind: 'vote', term: this.hard.term,
      lastLogIndex: this.log.length, lastLogTerm: this.termAt(this.log.length),
    };
    for (const peer of this.options.peers) this.outbox.set(peer, request);
  }

  private requestVote(from: string, request: VoteRequest, now: number): RpcReply {
    const lastTerm = this.termAt(this.log.length);
    const upToDate = request.lastLogTerm > lastTerm
      || (request.lastLogTerm === lastTerm && request.lastLogIndex >= this.log.length);
    const canVote = this.hard.votedFor === null || this.hard.votedFor === from;
    const granted = request.term === this.hard.term && canVote && upToDate;
    if (granted) {
      if (this.hard.votedFor !== from) this.setHardState(request.term, from);
      this.resetElection(now);
    }
    return { kind: 'vote', term: this.hard.term, granted };
  }

  private startLeader(now: number) {
    this.role = 'leader';
    this.leader = this.options.id;
    this.outbox.clear();
    this.progress.clear();
    for (const peer of this.options.peers) {
      this.progress.set(peer, { nextIndex: this.log.length + 1, matchIndex: 0, readAck: 0 });
    }
    this.leaderStartIndex = this.append({ type: 'noop' });
    this.advanceCommit();
    this.replicate(now);
  }

  private termAt(index: number): number {
    return index === 0 ? 0 : this.log[index - 1].term;
  }

  private append(command: Command): number {
    const index = this.log.length + 1;
    const entry = { term: this.hard.term, command };
    this.options.storage.replaceSuffix(index, [entry]);
    this.log.push(entry);
    return index;
  }

  private replicate(now: number) {
    this.heartbeatAt = now + this.options.heartbeatMs;
    for (const peer of this.options.peers) this.sendAppend(peer);
  }

  private sendAppend(peer: string) {
    const prevLogIndex = this.progress.get(peer)!.nextIndex - 1;
    this.outbox.set(peer, {
      kind: 'append', term: this.hard.term,
      prevLogIndex, prevLogTerm: this.termAt(prevLogIndex),
      entries: this.log.slice(prevLogIndex, prevLogIndex + APPEND_BATCH), leaderCommit: this.commitIndex,
      readId: this.reads.size > 0 && this.commitIndex >= this.leaderStartIndex ? this.readId : undefined,
    });
  }

  private appendEntries(from: string, request: AppendRequest, now: number): RpcReply {
    const failure = (nextIndex: number): RpcReply => ({
      kind: 'append', term: this.hard.term, success: false, nextIndex,
    });
    if (request.term < this.hard.term) return failure(this.log.length + 1);
    if (this.role !== 'follower') this.follow(request.term, from, now);
    this.leader = from;
    this.resetElection(now);

    const { prevLogIndex, prevLogTerm, entries } = request;
    if (prevLogIndex > this.log.length) return failure(this.log.length + 1);
    if (this.termAt(prevLogIndex) !== prevLogTerm) {
      const conflictTerm = this.termAt(prevLogIndex);
      let first = prevLogIndex;
      while (first > 1 && this.termAt(first - 1) === conflictTerm) first--;
      return failure(first);
    }
    const offset = entries.findIndex((entry, i) => this.log[prevLogIndex + i]?.term !== entry.term);
    if (offset !== -1) {
      const first = prevLogIndex + offset + 1;
      if (first <= this.commitIndex) throw new Error('Cannot overwrite committed Raft log');
      const suffix = entries.slice(offset);
      this.options.storage.replaceSuffix(first, suffix);
      this.log.length = first - 1;
      for (const entry of suffix) this.log.push(entry);
    }
    const commit = Math.min(request.leaderCommit, prevLogIndex + entries.length);
    if (commit > this.commitIndex) {
      this.commitIndex = commit;
      this.apply();
    }
    return { kind: 'append', term: this.hard.term, success: true };
  }

  private advanceCommit(): boolean {
    for (let index = this.log.length; index > this.commitIndex; index--) {
      if (this.termAt(index) !== this.hard.term) continue;
      const copies = 1 + [...this.progress.values()].filter(peer => peer.matchIndex >= index).length;
      if (copies < this.quorum) continue;
      this.commitIndex = index;
      this.apply();
      return true;
    }
    return false;
  }

  private apply() {
    while (this.lastApplied < this.commitIndex) {
      const command = this.log[this.lastApplied].command;
      this.lastApplied++;
      if (command.type === 'noop') continue;

      let result: { stored: true } | { deleted: boolean };
      if (command.type === 'put') {
        this.kv.set(command.key, command.value);
        result = { stored: true };
      } else {
        result = { deleted: this.kv.delete(command.key) };
      }
      this.writes.get(this.lastApplied)?.resolve({ ok: true, result });
      this.writes.delete(this.lastApplied);
    }
  }

  private completeReads() {
    if (this.lastApplied < this.leaderStartIndex) return;
    for (const [id, pending] of this.reads) {
      const acknowledgements = 1 + [...this.progress.values()].filter(peer => peer.readAck >= id).length;
      if (acknowledgements < this.quorum || this.lastApplied < pending.readIndex) continue;
      const value = this.kv.get(pending.key);
      pending.resolve({ ok: true, result: value === undefined ? { found: false } : { found: true, value } });
      this.reads.delete(id);
    }
  }
}
