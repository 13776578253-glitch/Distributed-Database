/**
 * Deterministic Raft core. Owns term/vote, the replicated log, leader
 * progress, commit/apply state, and pending client operations. Performs no
 * asynchronous I/O: storage, time, and message delivery are supplied by the
 * caller, which keeps protocol timing reproducible in tests.
 */
import type { Operation, OperationResult, Scalar } from '../../contracts/history.ts';
import { RaftLog } from './log.ts';
import type {
  AppendRequest, ClientFailure, ClientReply, Command, Entry, HardState, ReadBarrierReply, Role, RpcReply, RpcRequest,
  Snapshot, SnapshotRequest, Storage, VoteRequest, WriteOperation,
} from './types.ts';

/** 等待应答的客户端请求；deadline 基于调用方注入的单调毫秒时钟。 */
type Pending<T> = { deadline: number; resolve: (reply: T) => void };
/** Leader 对单个 peer 的复制进度；readAck 是该 peer 已确认的最大读编号。 */
type Progress = { nextIndex: number; matchIndex: number; readAck: number };
/** 构造参数；electionTimeout 每次调用返回新的随机超时，now 使用 performance.now() 基准。 */
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

/**
 * 单节点 Raft 状态机。公开方法同步执行：持久化经由同步 Storage 适配器，
 * 出站消息进入 outbox，由调用方 drain() 后投递。
 */
export class RaftNode {
  private readonly options: Options;
  /** 多数派规模，包含自身。 */
  private readonly quorum: number;
  /** 已持久化日志，Core 只使用绝对索引。 */
  private log: RaftLog;
  /** 最近一次已持久化快照，供落后 Follower 安装。 */
  private snapshot?: Snapshot;
  /** 已应用状态机，由快照恢复和按序 apply() 更新。 */
  private readonly kv = new Map<string, Scalar>();
  /** 每个 peer 最多保留一条待发消息，drain() 取走后清空。 */
  private readonly outbox = new Map<string, RpcRequest>();
  /** 仅 Leader 有效；成为 Leader 时按本任期日志重建。 */
  private readonly progress = new Map<string, Progress>();
  /** 仅竞选期间用于计票；除自己的初始一票外，只统计当前任期且 granted 的应答。 */
  private readonly votes = new Set<string>();
  /** 等待提交的客户端写，键为本地日志索引；apply() 兑现。 */
  private readonly writes = new Map<number, Pending<ClientReply>>();
  /** 等待读屏障的客户端读，键为 Leader 本地 readId。 */
  private readonly reads = new Map<number, Pending<ReadBarrierReply> & { readIndex: number }>();
  /** 当前任期与投票；每次变更先持久化再更新内存。 */
  private hard: HardState;
  /** 当前角色；启动时固定为 follower。 */
  private role: Role = 'follower';
  /** 最近一次已知 Leader 的节点 ID；无 Leader 时为 null。 */
  private leader: string | null = null;
  /** 已知被多数派复制的最大索引，只增不减。 */
  private commitIndex = 0;
  /** 已应用到 kv 的最大索引；始终满足 commitIndex >= lastApplied。 */
  private lastApplied = 0;
  /** Leader 本地读编号，单调递增；不持久化，重启后从 0 重新计数。 */
  private readId = 0;
  /** 本任期 noop 的日志索引；未提交前 ready 为 false 且不提供读。 */
  private leaderStartIndex = 0;
  /** 本地时钟下的下次选举超时与心跳时间。 */
  private electionAt: number;
  private heartbeatAt = 0;

  constructor(options: Options) {
    this.options = options;
    const { term, votedFor, entries, snapshot } = options.storage.load();
    this.hard = { term, votedFor };
    this.snapshot = snapshot;
    this.log = new RaftLog(entries, snapshot?.lastIncludedIndex, snapshot?.lastIncludedTerm);
    // 快照已提交；保留后缀等 Leader 确认提交边界后才重放。
    if (snapshot) this.restoreSnapshotState(snapshot);
    this.quorum = Math.floor((options.peers.length + 1) / 2) + 1;
    this.electionAt = options.now + options.electionTimeout();
  }

  /** 只读状态快照，供 HTTP 层和实验脚本观测，不改变协议状态。 */
  status() {
    return {
      nodeId: this.options.id,
      role: this.role,
      term: this.hard.term,
      leader: this.leader,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      logLength: this.log.lastIndex,
      snapshotIndex: this.log.baseIndex,
      snapshotTerm: this.log.baseTerm,
      retainedEntries: this.log.lastIndex - this.log.baseIndex,
      committedTerm: this.log.termAt(this.commitIndex)!,
      // ready 要求本任期 noop 已提交；此前的旧任期前缀不能对外视为可读。
      ready: this.role === 'leader' && this.commitIndex >= this.leaderStartIndex,
    };
  }

  /** 仍保留在日志中的已提交条目。 */
  committedEntries(): Entry[] {
    return this.log.entriesFrom(this.log.baseIndex + 1, this.commitIndex - this.log.baseIndex);
  }

  /** 用键的二进制顺序输出已应用状态，便于跨不同快照边界比较。 */
  appliedState(): Snapshot['state'] {
    return [...this.kv].sort(([left], [right]) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
  }

  /** 快照覆盖已应用边界，并保留尚未应用的日志后缀。 */
  compact(): boolean {
    if (this.lastApplied <= this.log.baseIndex) return false;
    this.persistSnapshot({
      lastIncludedIndex: this.lastApplied,
      lastIncludedTerm: this.log.termAt(this.lastApplied)!,
      state: this.appliedState(),
    }, true);
    return true;
  }

  /** 只读取本地已应用状态；调用方决定是否需要新鲜的多数派读屏障。 */
  readLocal(key: string): { appliedIndex: number; result: Extract<OperationResult, { found: boolean }> } {
    const value = this.kv.get(key);
    return {
      appliedIndex: this.lastApplied,
      result: value === undefined ? { found: false } : { found: true, value },
    };
  }

  /** 取走并清空出站消息；同一 peer 的旧消息已被最新消息覆盖。 */
  drain() {
    const messages = [...this.outbox.entries()];
    this.outbox.clear();
    return messages;
  }

  /** 推进本地定时器：非 Leader 检查选举超时，Leader 处理请求超时并周期性复制。 */
  tick(now: number) {
    if (this.role !== 'leader') {
      // 只有收到有效 Leader 消息或授予投票才会重置选举超时。
      if (now >= this.electionAt) this.startElection(now);
      return;
    }

    // 写可能已复制到多数派，超时只能报告结果未知；读未完成，可安全重试。
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

  /** 提交客户端操作；非 Leader 立即返回 NOT_LEADER，否则在提交应用、读屏障完成、超时或降级后兑现。 */
  execute(operation: Operation, now: number): Promise<ClientReply> {
    if (operation.type !== 'get') return this.executeWrites([operation], now)[0];
    return this.readBarrier(now).then(barrier => barrier.ok
      ? { ok: true, result: this.readLocal(operation.key).result }
      : barrier);
  }

  /** Leader 读和 Follower ReadIndex 共用屏障。每次请求登记一个新的读编号。 */
  readBarrier(now: number): Promise<ReadBarrierReply> {
    if (this.role !== 'leader') return Promise.resolve(this.error('NOT_LEADER'));

    return new Promise(resolve => {
      const pending = { deadline: now + this.options.requestMs, resolve };
      // 读不写日志：记录发起时的 commitIndex，等待本任期 noop、多数派 readAck 和本地应用进度。
      this.reads.set(++this.readId, { ...pending, readIndex: this.commitIndex });
      this.completeReads();
      this.replicate(now);
    });
  }

  /** 持久化一组非空写入，并按各自的日志索引完成应答。任期变化时拒绝尚未入日志的整批。 */
  executeWrites(commands: readonly WriteOperation[], now: number, term = this.hard.term): Promise<ClientReply>[] {
    if (this.role !== 'leader' || this.hard.term !== term) {
      return commands.map(() => Promise.resolve(this.error('NOT_LEADER')));
    }
    const first = this.append(commands);
    const replies = commands.map((_, offset) => new Promise<ClientReply>(resolve => {
      this.writes.set(first + offset, { deadline: now + this.options.requestMs, resolve });
    }));
    this.advanceCommit();
    this.replicate(now);
    return replies;
  }

  /** 处理入站 RPC；更高任期先降级并持久化，再按 kind 分派。 */
  receiveRequest(from: string, request: RpcRequest, now: number): RpcReply {
    // 先收敛任期，保证后续投票/追加判断都基于最新本地任期。
    if (request.term > this.hard.term) this.follow(request.term, null, now);
    if (request.kind === 'vote') return this.requestVote(from, request, now);
    if (request.kind === 'snapshot') return this.installSnapshot(from, request, now);
    return this.appendEntries(from, request, now);
  }

  /** 处理 RPC 应答；先按更高任期降级，再忽略与当前任期不一致的消息。 */
  receiveReply(from: string, request: RpcRequest, reply: RpcReply, now: number) {
    if (reply.term > this.hard.term) this.follow(reply.term, null, now);
    // 请求或应答任一任期与当前不一致，都不能用于推进状态。
    if (request.term !== this.hard.term || reply.term !== this.hard.term) return;

    if (request.kind === 'vote' && reply.kind === 'vote') {
      if (this.role !== 'candidate' || !reply.granted) return;
      // 只统计当前任期且明确授予的票；本节点的一票已在竞选时计入。
      this.votes.add(from);
      if (this.votes.size >= this.quorum) this.startLeader(now);
      return;
    }
    if (this.role !== 'leader') return;
    if (request.kind === 'snapshot' && reply.kind === 'snapshot') {
      // 快照 ACK 只确认日志覆盖范围，不计入客户端读屏障。
      if (reply.success) this.acknowledge(from, request.snapshot.lastIncludedIndex, now);
      return;
    }
    if (request.kind !== 'append' || reply.kind !== 'append') return;

    const peer = this.progress.get(from)!;
    if (!reply.success) {
      // 只处理当前探针的失败。对端已压缩时可以向前试探，但尚未确认 matchIndex。
      if (request.prevLogIndex === peer.nextIndex - 1) {
        const next = Math.min(this.log.lastIndex + 1, Math.max(peer.matchIndex + 1, reply.nextIndex));
        if (next !== peer.nextIndex) {
          peer.nextIndex = next;
          this.sendReplication(from);
        }
      }
      return;
    }

    // 成功应答确认到 prevLogIndex + entries.length；携带的 readId 同时代表该 peer 对本次读的确认。
    if (request.readId !== undefined) peer.readAck = Math.max(peer.readAck, request.readId);
    this.acknowledge(from, request.prevLogIndex + request.entries.length, now);
  }

  private acknowledge(from: string, index: number, now: number) {
    const peer = this.progress.get(from)!;
    peer.matchIndex = Math.max(peer.matchIndex, index);
    peer.nextIndex = peer.matchIndex + 1;
    const advanced = this.advanceCommit();
    this.completeReads();
    // 提交推进后继续复制剩余日志；否则补发同一 peer 的下一批。
    if (advanced) this.replicate(now);
    else if (peer.matchIndex < this.log.lastIndex) this.sendReplication(from);
  }

  private error(error: ClientFailure['error']): ClientFailure {
    return { ok: false, error, leader: this.leader };
  }

  /** 先写存储再更新内存；返回后任期和投票对重启可见。 */
  private setHardState(term: number, votedFor: string | null) {
    this.options.storage.saveHardState({ term, votedFor });
    this.hard = { term, votedFor };
  }

  /** 重新随机化选举超时；收到有效 Leader 消息或授予投票时调用。 */
  private resetElection(now: number) {
    this.electionAt = now + this.options.electionTimeout();
  }

  /** 降级为 follower；更高任期先持久化，并清空出站消息、兑现待应答请求。 */
  private follow(term: number, leader: string | null, now: number) {
    if (term > this.hard.term) this.setHardState(term, null);
    if (this.role !== 'follower') this.resetElection(now);
    this.role = 'follower';
    this.leader = leader;
    this.outbox.clear();
    // 写可能已被复制，降级时只能报结果未知；读肯定未完成，报未执行。
    for (const pending of this.writes.values()) pending.resolve(this.error('UNKNOWN_OUTCOME'));
    for (const pending of this.reads.values()) pending.resolve(this.error('NOT_LEADER'));
    this.writes.clear();
    this.reads.clear();
  }

  /** 自增任期并投自己一票，然后向所有 peer 拉票。 */
  private startElection(now: number) {
    // 任期和投票先落盘，再改变内存与发送消息；重启后不能在同一任期重复投票。
    this.setHardState(this.hard.term + 1, this.options.id);
    this.role = 'candidate';
    this.leader = null;
    this.resetElection(now);
    this.votes.clear();
    this.votes.add(this.options.id);
    this.outbox.clear();
    // 单节点集群在计入自己的一票后立即满足多数派。
    if (this.votes.size >= this.quorum) {
      this.startLeader(now);
      return;
    }
    const request: VoteRequest = {
      kind: 'vote', term: this.hard.term,
      lastLogIndex: this.log.lastIndex, lastLogTerm: this.log.termAt(this.log.lastIndex)!,
    };
    for (const peer of this.options.peers) this.outbox.set(peer, request);
  }

  /** 处理拉票：同一任期只支持一个候选者，且候选日志不得旧于本地日志。 */
  private requestVote(from: string, request: VoteRequest, now: number): RpcReply {
    const lastTerm = this.log.termAt(this.log.lastIndex)!;
    // 先比较最后日志任期，再比较长度；这是 Raft 的日志新旧判据。
    const upToDate = request.lastLogTerm > lastTerm
      || (request.lastLogTerm === lastTerm && request.lastLogIndex >= this.log.lastIndex);
    const canVote = this.hard.votedFor === null || this.hard.votedFor === from;
    const granted = request.term === this.hard.term && canVote && upToDate;
    if (granted) {
      // 授予时先持久化 votedFor 再返回；响应携带处理后的本地任期。
      if (this.hard.votedFor !== from) this.setHardState(request.term, from);
      this.resetElection(now);
    }
    return { kind: 'vote', term: this.hard.term, granted };
  }

  /** 转为 Leader：重置 peer 进度，追加本任期 noop，作为提交与读屏障的起点。 */
  private startLeader(now: number) {
    this.role = 'leader';
    this.leader = this.options.id;
    this.outbox.clear();
    this.progress.clear();
    // 进度从日志末尾之后开始；matchIndex 尚不知情，先按 0 处理。
    for (const peer of this.options.peers) {
      this.progress.set(peer, { nextIndex: this.log.lastIndex + 1, matchIndex: 0, readAck: 0 });
    }
    // 旧任期条目即使已复制到多数派也不能单独提交；noop 提交后它们随之提交。
    this.leaderStartIndex = this.append([{ type: 'noop' }]);
    this.advanceCommit();
    this.replicate(now);
  }

  /** 在一个存储事务中追加连续日志并返回首索引，内存日志只在持久化后推进。 */
  private append(commands: readonly Command[]): number {
    const first = this.log.lastIndex + 1;
    const entries = commands.map(command => ({ term: this.hard.term, command }));
    this.options.storage.replaceSuffix(first, entries);
    this.log.replaceSuffix(first, entries);
    return first;
  }

  /** 记录下次心跳时间，并向所有 peer 推送当前复制进度。 */
  private replicate(now: number) {
    this.heartbeatAt = now + this.options.heartbeatMs;
    for (const peer of this.options.peers) this.sendReplication(peer);
  }

  /** nextIndex 落在已压缩前缀时先发快照，否则从保留日志中取一批。 */
  private sendReplication(peer: string) {
    const nextIndex = this.progress.get(peer)!.nextIndex;
    if (this.snapshot && nextIndex <= this.log.baseIndex) {
      this.outbox.set(peer, { kind: 'snapshot', term: this.hard.term, snapshot: this.snapshot });
      return;
    }
    // 单批最多 APPEND_BATCH 条，剩余日志由后续应答继续推动。
    const prevLogIndex = nextIndex - 1;
    this.outbox.set(peer, {
      kind: 'append', term: this.hard.term,
      prevLogIndex, prevLogTerm: this.log.termAt(prevLogIndex)!,
      entries: this.log.entriesFrom(prevLogIndex + 1, APPEND_BATCH), leaderCommit: this.commitIndex,
      readId: this.reads.size > 0 && this.commitIndex >= this.leaderStartIndex ? this.readId : undefined,
    });
  }

  private followLeader(from: string, term: number, now: number) {
    if (this.role !== 'follower') this.follow(term, from, now);
    this.leader = from;
    this.resetElection(now);
  }

  /** 处理追加/心跳：校验任期和前缀，替换冲突后缀，并按 leaderCommit 推进应用。 */
  private appendEntries(from: string, request: AppendRequest, now: number): RpcReply {
    const failure = (nextIndex: number): RpcReply => ({
      kind: 'append', term: this.hard.term, success: false, nextIndex,
    });
    // 任期落后直接拒绝；应答携带本地更高任期，促使旧 Leader 尽快降级。
    if (request.term < this.hard.term) return failure(this.log.lastIndex + 1);
    // 同任期或更高任期的追加都使 Candidate/Leader 降级；随后刷新 Leader 与选举计时。
    this.followLeader(from, request.term, now);

    const { prevLogIndex, prevLogTerm, entries } = request;
    // 已压缩的索引无法逐条比对，提示从快照边界之后试探。
    if (prevLogIndex < this.log.baseIndex) return failure(this.log.baseIndex + 1);
    // 本地日志太短，前缀不可能匹配；提示 Leader 从日志末尾之后重发。
    if (prevLogIndex > this.log.lastIndex) return failure(this.log.lastIndex + 1);
    if (this.log.termAt(prevLogIndex) !== prevLogTerm) {
      // 返回冲突任期的首个索引，Leader 可一次跳过整个冲突任期。
      return failure(this.log.firstIndexOfTerm(prevLogIndex));
    }
    // 找到首个任期不同的位置；从该位置起必须替换为 Leader 的后缀。
    const offset = entries.findIndex((entry, i) => this.log.termAt(prevLogIndex + i + 1) !== entry.term);
    if (offset !== -1) {
      const first = prevLogIndex + offset + 1;
      // 已提交前缀不允许被覆盖；触发说明协议或持久化已损坏。
      if (first <= this.commitIndex) throw new Error('Cannot overwrite committed Raft log');
      const suffix = entries.slice(offset);
      // 先原子替换持久化后缀，再同步内存日志，保持两者一致。
      this.options.storage.replaceSuffix(first, suffix);
      this.log.replaceSuffix(first, suffix);
    }
    // 只能提交 Leader 已告知、且本地实际拥有的前缀；随后按序应用。
    const commit = Math.min(request.leaderCommit, prevLogIndex + entries.length);
    if (commit > this.commitIndex) {
      this.commitIndex = commit;
      this.apply();
    }
    return { kind: 'append', term: this.hard.term, success: true };
  }

  /** 旧快照不会倒退状态；新快照只有边界任期匹配时才保留后缀。 */
  private installSnapshot(from: string, request: SnapshotRequest, now: number): RpcReply {
    const reply = { kind: 'snapshot', term: this.hard.term } as const;
    if (request.term < this.hard.term) return { ...reply, success: false };
    this.followLeader(from, request.term, now);
    const { snapshot } = request;
    if (snapshot.lastIncludedIndex > this.commitIndex) {
      const retain = this.log.termAt(snapshot.lastIncludedIndex) === snapshot.lastIncludedTerm;
      this.persistSnapshot(snapshot, retain);
      this.restoreSnapshotState(snapshot);
    }
    return { ...reply, success: true };
  }

  private persistSnapshot(snapshot: Snapshot, retainSuffix: boolean) {
    this.options.storage.saveSnapshot(snapshot, retainSuffix);
    const entries = retainSuffix ? this.log.entriesFrom(snapshot.lastIncludedIndex + 1) : [];
    this.log = new RaftLog(entries, snapshot.lastIncludedIndex, snapshot.lastIncludedTerm);
    this.snapshot = snapshot;
  }

  private restoreSnapshotState(snapshot: Snapshot) {
    this.kv.clear();
    for (const [key, value] of snapshot.state) this.kv.set(key, value);
    this.commitIndex = snapshot.lastIncludedIndex;
    this.lastApplied = snapshot.lastIncludedIndex;
  }

  /** 推进提交索引：只统计当前任期条目，且需多数派 matchIndex 覆盖目标索引。 */
  private advanceCommit(): boolean {
    for (let index = this.log.lastIndex; index > this.commitIndex; index--) {
      // 旧任期条目不能仅凭多数派复制提交（Raft 图 8）；它们随本任期条目间接提交。
      if (this.log.termAt(index) !== this.hard.term) continue;
      // 自身算一份，其余按 matchIndex 统计。
      const copies = 1 + [...this.progress.values()].filter(peer => peer.matchIndex >= index).length;
      if (copies < this.quorum) continue;
      this.commitIndex = index;
      this.apply();
      return true;
    }
    return false;
  }

  /** 按日志顺序把已提交命令应用到 kv；客户端写在此处才收到成功应答。 */
  private apply() {
    while (this.lastApplied < this.commitIndex) {
      const command = this.log.entryAt(this.lastApplied + 1)!.command;
      // 先推进 lastApplied 再执行命令，保证 kv 与日志索引严格对齐。
      this.lastApplied++;
      // noop 只推进提交前缀和读屏障，不改变 kv。
      if (command.type === 'noop') continue;

      let result: { stored: true } | { deleted: boolean };
      if (command.type === 'put') {
        this.kv.set(command.key, command.value);
        result = { stored: true };
      } else {
        result = { deleted: this.kv.delete(command.key) };
      }
      // 同一日志索引至多兑现一次；重启后没有等待者时忽略。
      this.writes.get(this.lastApplied)?.resolve({ ok: true, result });
      this.writes.delete(this.lastApplied);
    }
  }

  /** 完成满足读屏障的读请求；三个条件见函数内注释。 */
  private completeReads() {
    // 本任期 noop 尚未应用时，Leader 的提交前缀仍不完整，不能提供读。
    if (this.lastApplied < this.leaderStartIndex) return;
    for (const [id, pending] of this.reads) {
      const acknowledgements = 1 + [...this.progress.values()].filter(peer => peer.readAck >= id).length;
      // 三个条件缺一不可：noop 已应用；多数派确认本次 readId；状态已应用到发起时的 readIndex。
      if (acknowledgements < this.quorum || this.lastApplied < pending.readIndex) continue;
      pending.resolve({
        ok: true, term: this.hard.term, readIndex: Math.max(pending.readIndex, this.leaderStartIndex),
      });
      this.reads.delete(id);
    }
  }
}
