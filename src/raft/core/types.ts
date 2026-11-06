import type { Operation, OperationResult } from '../../contracts/history.ts';

export type Role = 'follower' | 'candidate' | 'leader';
export type Command = Exclude<Operation, { type: 'get' }> | { type: 'noop' };
export type Entry = { term: number; command: Command };
export type HardState = { term: number; votedFor: string | null };

export interface Storage {
  load(): HardState & { entries: Entry[] };
  saveHardState(state: HardState): void;
  replaceSuffix(fromIndex: number, entries: Entry[]): void;
}

export type VoteRequest = {
  kind: 'vote';
  term: number;
  lastLogIndex: number;
  lastLogTerm: number;
};

export type AppendRequest = {
  kind: 'append';
  term: number;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: Entry[];
  leaderCommit: number;
  readId?: number;
};

export type RpcRequest = VoteRequest | AppendRequest;
export type RpcReply =
  | { kind: 'vote'; term: number; granted: boolean }
  | { kind: 'append'; term: number; success: true }
  | { kind: 'append'; term: number; success: false; nextIndex: number };

export type ClientReply =
  | { ok: true; result: OperationResult }
  | { ok: false; error: 'NOT_LEADER' | 'NO_QUORUM' | 'UNKNOWN_OUTCOME'; leader: string | null };
