/**
 * Raft wire and persistence types. Defines the shapes shared by the core,
 * transport, and storage adapters; holds no runtime state or behavior.
 */
import type { Operation, OperationResult, Scalar } from '../../contracts/history.ts';

export type Role = 'follower' | 'candidate' | 'leader';
/** 可写入日志的命令：get 不写日志而走读屏障，noop 由新 Leader 追加用于提交本任期前缀。 */
export type WriteOperation = Exclude<Operation, { type: 'get' }>;
/** next 存在时为联合配置，两个集合独立计算多数。 */
export type Configuration = { voters: readonly string[]; next?: readonly string[] };
export type Membership = { index: number; configuration: Configuration };
export type Command = WriteOperation | { type: 'noop' } | { type: 'configure'; configuration: Configuration };
/** 日志项；term 同时用于选举新旧比较和冲突后缀截断。 */
export type Entry = { term: number; command: Command };
/** 必须同步持久化的选举状态；term 单调不减，votedFor 仅表示当前任期投出的票（null 为未投）。 */
export type HardState = { term: number; votedFor: string | null };

/** 已应用状态及其绝对日志边界；覆盖该索引及之前的前缀。 */
export type Snapshot = {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  state: [string, Scalar][];
  membership?: Membership;
};

/**
 * 持久化边界。实现必须保证 saveHardState 和 replaceSuffix 在返回前已落盘，
 * 使重启后的任期、投票和日志与内存状态一致。
 */
export interface Storage {
  /** 读取硬状态、可选快照与保留日志；entries 紧接快照边界，缺省从索引 1 起。 */
  load(): HardState & { entries: Entry[]; snapshot?: Snapshot };
  /** 持久化任期与投票；必须在回复拉票或更新内存前完成。 */
  saveHardState(state: HardState): void;
  /** 从 fromIndex（1 起）起原子替换日志后缀；entries 为空时截断该位置之后的内容。 */
  replaceSuffix(fromIndex: number, entries: Entry[]): void;
  /** 原子保存快照并裁剪日志；只在边界匹配时保留后缀。 */
  saveSnapshot(snapshot: Snapshot, retainSuffix: boolean): void;
}

/** 拉票请求；最后日志索引和任期用于判断候选日志是否至少与本地一样新。 */
export type VoteRequest = {
  kind: 'vote';
  term: number;
  lastLogIndex: number;
  lastLogTerm: number;
  configurationIndex?: number;
};

/** 追加/心跳请求；readId 仅在 Leader 完成本任期 noop 提交且存在等待读时携带。 */
export type AppendRequest = {
  kind: 'append';
  term: number;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: Entry[];
  leaderCommit: number;
  readId?: number;
};

export type SnapshotRequest = { kind: 'snapshot'; term: number; snapshot: Snapshot };
export type RpcRequest = VoteRequest | AppendRequest | SnapshotRequest;
/** RPC 应答；append 失败时的 nextIndex 提示接收方期望的下一个日志索引。 */
export type RpcReply =
  | { kind: 'vote'; term: number; granted: boolean }
  | { kind: 'snapshot'; term: number; success: boolean }
  | { kind: 'append'; term: number; success: true }
  | { kind: 'append'; term: number; success: false; nextIndex: number };

/**
 * 客户端应答。NOT_LEADER 表示操作未执行；NO_QUORUM 表示读未获多数派确认；
 * UNKNOWN_OUTCOME 表示写可能已生效，调用方不得按失败处理。
 */
export type ClientFailure = {
  ok: false; error: 'NOT_LEADER' | 'NO_QUORUM' | 'UNKNOWN_OUTCOME'; leader: string | null;
};
export type ClientReply = { ok: true; result: OperationResult } | ClientFailure;

/** 一次新鲜多数派读屏障的任期与最低应用索引。 */
export type ReadBarrier = { ok: true; term: number; readIndex: number };
export type ReadBarrierReply = ReadBarrier | ClientFailure;

export type MembershipReply =
  | { ok: true; jointIndex: number }
  | { ok: false; error: 'NOT_LEADER' | 'CONFIG_IN_PROGRESS' | 'INVALID_VOTERS' | 'MEMBER_NOT_CAUGHT_UP' };
