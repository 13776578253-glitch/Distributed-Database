/**
 * Deterministic Raft core. Owns term/vote, the replicated log, leader
 * progress, commit/apply state, and pending client operations. Performs no
 * asynchronous I/O: storage, time, and message delivery are supplied by the
 * caller, which keeps protocol timing reproducible in tests.
 */
import type { Operation, Scalar } from '../../contracts/history.ts';
import type {
  AppendRequest, ClientReply, Command, Entry, HardState, Role, RpcReply, RpcRequest,
  Storage, VoteRequest,
} from './types.ts';

/** 等待应答的客户端请求；deadline 基于调用方注入的单调毫秒时钟。 */
type Pending = { deadline: number; resolve: (reply: ClientReply) => void };
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
  /** 已持久化日志，索引 1 起；log[i] 对应日志索引 i+1。 */
  private readonly log: Entry[];
  /** 已应用状态机，只由 apply() 在 commitIndex 推进后按序更新。 */
  private readonly kv = new Map<string, Scalar>();
  /** 每个 peer 最多保留一条待发消息，drain() 取走后清空。 */
  private readonly outbox = new Map<string, RpcRequest>();
  /** 仅 Leader 有效；成为 Leader 时按本任期日志重建。 */
  private readonly progress = new Map<string, Progress>();
  /** 仅竞选期间用于计票；除自己的初始一票外，只统计当前任期且 granted 的应答。 */
  private readonly votes = new Set<string>();
  /** 等待提交的客户端写，键为本地日志索引；apply() 兑现。 */
  private readonly writes = new Map<number, Pending>();
  /** 等待读屏障的客户端读，键为 Leader 本地 readId。 */
  private readonly reads = new Map<number, Pending & { key: string; readIndex: number }>();
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
    // 只恢复持久化的任期、投票和日志；角色、定时器与 kv 都从本地初始状态重建。
    const { term, votedFor, entries } = options.storage.load();
    this.hard = { term, votedFor };
    this.log = entries;
    // kv 不持久化：重启后由日志按序重放，lastApplied 从 0 开始。
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
      logLength: this.log.length,
      // ready 要求本任期 noop 已提交；此前的旧任期前缀不能对外视为可读。
      ready: this.role === 'leader' && this.commitIndex >= this.leaderStartIndex,
    };
  }

  /** 已提交前缀的副本；未提交尾部不会出现在摘要中。 */
  committedEntries(): Entry[] {
    return this.log.slice(0, this.commitIndex);
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
    if (this.role !== 'leader') return Promise.resolve(this.error('NOT_LEADER'));

    return new Promise(resolve => {
      const pending = { deadline: now + this.options.requestMs, resolve };
      if (operation.type === 'get') {
        // 读不写日志：记录发起时的 commitIndex，等待本任期 noop、多数派 readAck 和本地应用进度。
        this.reads.set(++this.readId, { ...pending, key: operation.key, readIndex: this.commitIndex });
        this.completeReads();
      } else {
        // 写先持久化进本地日志，再登记到对应索引；只有 apply() 才应答成功。
        const index = this.append(operation);
        this.writes.set(index, pending);
        this.advanceCommit();
      }
      this.replicate(now);
    });
  }

  /** 处理入站 RPC；更高任期先降级并持久化，再按 kind 分派。 */
  receiveRequest(from: string, request: RpcRequest, now: number): RpcReply {
    // 先收敛任期，保证后续投票/追加判断都基于最新本地任期。
    if (request.term > this.hard.term) this.follow(request.term, null, now);
    return request.kind === 'vote'
      ? this.requestVote(from, request, now)
      : this.appendEntries(from, request, now);
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
    if (this.role !== 'leader' || request.kind !== 'append' || reply.kind !== 'append') return;

    const peer = this.progress.get(from)!;
    if (!reply.success) {
      // 迟到的失败不能撤销已确认成功的新进度：只回退仍对应最新请求、且高于 matchIndex 的 nextIndex。
      if (request.prevLogIndex === peer.nextIndex - 1 && request.prevLogIndex > peer.matchIndex) {
        peer.nextIndex = Math.max(peer.matchIndex + 1, Math.min(request.prevLogIndex, reply.nextIndex));
        this.sendAppend(from);
      }
      return;
    }

    // 成功应答确认到 prevLogIndex + entries.length；携带的 readId 同时代表该 peer 对本次读的确认。
    peer.matchIndex = Math.max(peer.matchIndex, request.prevLogIndex + request.entries.length);
    peer.nextIndex = peer.matchIndex + 1;
    if (request.readId !== undefined) peer.readAck = Math.max(peer.readAck, request.readId);
    const advanced = this.advanceCommit();
    this.completeReads();
    // 提交推进后继续复制剩余日志；否则补发同一 peer 的下一批。
    if (advanced) this.replicate(now);
    else if (peer.matchIndex < this.log.length) this.sendAppend(from);
  }

  private error(error: Extract<ClientReply, { ok: false }>['error']): ClientReply {
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
      lastLogIndex: this.log.length, lastLogTerm: this.termAt(this.log.length),
    };
    for (const peer of this.options.peers) this.outbox.set(peer, request);
  }

  /** 处理拉票：同一任期只支持一个候选者，且候选日志不得旧于本地日志。 */
  private requestVote(from: string, request: VoteRequest, now: number): RpcReply {
    const lastTerm = this.termAt(this.log.length);
    // 先比较最后日志任期，再比较长度；这是 Raft 的日志新旧判据。
    const upToDate = request.lastLogTerm > lastTerm
      || (request.lastLogTerm === lastTerm && request.lastLogIndex >= this.log.length);
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
      this.progress.set(peer, { nextIndex: this.log.length + 1, matchIndex: 0, readAck: 0 });
    }
    // 旧任期条目即使已复制到多数派也不能单独提交；noop 提交后它们随之提交。
    this.leaderStartIndex = this.append({ type: 'noop' });
    this.advanceCommit();
    this.replicate(now);
  }

  /** 日志索引对应的任期；索引 0 固定为 0，调用方保证 index <= log.length。 */
  private termAt(index: number): number {
    return index === 0 ? 0 : this.log[index - 1].term;
  }

  /** 追加一条本地日志并返回索引；先持久化再更新内存，保证内存日志不领先于磁盘。 */
  private append(command: Command): number {
    const index = this.log.length + 1;
    const entry = { term: this.hard.term, command };
    this.options.storage.replaceSuffix(index, [entry]);
    this.log.push(entry);
    return index;
  }

  /** 记录下次心跳时间，并向所有 peer 推送当前复制进度。 */
  private replicate(now: number) {
    this.heartbeatAt = now + this.options.heartbeatMs;
    for (const peer of this.options.peers) this.sendAppend(peer);
  }

  /** 按 peer 的 nextIndex 组装追加请求；仅在有等待读且本任期 noop 已提交时携带 readId。 */
  private sendAppend(peer: string) {
    // 单批最多 APPEND_BATCH 条，剩余日志由后续应答继续推动。
    const prevLogIndex = this.progress.get(peer)!.nextIndex - 1;
    this.outbox.set(peer, {
      kind: 'append', term: this.hard.term,
      prevLogIndex, prevLogTerm: this.termAt(prevLogIndex),
      entries: this.log.slice(prevLogIndex, prevLogIndex + APPEND_BATCH), leaderCommit: this.commitIndex,
      readId: this.reads.size > 0 && this.commitIndex >= this.leaderStartIndex ? this.readId : undefined,
    });
  }

  /** 处理追加/心跳：校验任期和前缀，替换冲突后缀，并按 leaderCommit 推进应用。 */
  private appendEntries(from: string, request: AppendRequest, now: number): RpcReply {
    const failure = (nextIndex: number): RpcReply => ({
      kind: 'append', term: this.hard.term, success: false, nextIndex,
    });
    // 任期落后直接拒绝；应答携带本地更高任期，促使旧 Leader 尽快降级。
    if (request.term < this.hard.term) return failure(this.log.length + 1);
    // 同任期或更高任期的追加都使 Candidate/Leader 降级；随后刷新 Leader 与选举计时。
    if (this.role !== 'follower') this.follow(request.term, from, now);
    this.leader = from;
    this.resetElection(now);

    const { prevLogIndex, prevLogTerm, entries } = request;
    // 本地日志太短，前缀不可能匹配；提示 Leader 从日志末尾之后重发。
    if (prevLogIndex > this.log.length) return failure(this.log.length + 1);
    if (this.termAt(prevLogIndex) !== prevLogTerm) {
      const conflictTerm = this.termAt(prevLogIndex);
      let first = prevLogIndex;
      while (first > 1 && this.termAt(first - 1) === conflictTerm) first--;
      // 返回冲突任期的首个索引，Leader 可一次跳过整个冲突任期。
      return failure(first);
    }
    // 找到首个任期不同的位置；从该位置起必须替换为 Leader 的后缀。
    const offset = entries.findIndex((entry, i) => this.log[prevLogIndex + i]?.term !== entry.term);
    if (offset !== -1) {
      const first = prevLogIndex + offset + 1;
      // 已提交前缀不允许被覆盖；触发说明协议或持久化已损坏。
      if (first <= this.commitIndex) throw new Error('Cannot overwrite committed Raft log');
      const suffix = entries.slice(offset);
      // 先原子替换持久化后缀，再同步内存日志，保持两者一致。
      this.options.storage.replaceSuffix(first, suffix);
      this.log.length = first - 1;
      for (const entry of suffix) this.log.push(entry);
    }
    // 只能提交 Leader 已告知、且本地实际拥有的前缀；随后按序应用。
    const commit = Math.min(request.leaderCommit, prevLogIndex + entries.length);
    if (commit > this.commitIndex) {
      this.commitIndex = commit;
      this.apply();
    }
    return { kind: 'append', term: this.hard.term, success: true };
  }

  /** 推进提交索引：只统计当前任期条目，且需多数派 matchIndex 覆盖目标索引。 */
  private advanceCommit(): boolean {
    for (let index = this.log.length; index > this.commitIndex; index--) {
      // 旧任期条目不能仅凭多数派复制提交（Raft 图 8）；它们随本任期条目间接提交。
      if (this.termAt(index) !== this.hard.term) continue;
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
      const command = this.log[this.lastApplied].command;
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
      const value = this.kv.get(pending.key);
      // 键缺失返回 found:false，与保存的 JSON null 区分。
      pending.resolve({ ok: true, result: value === undefined ? { found: false } : { found: true, value } });
      this.reads.delete(id);
    }
  }
}
