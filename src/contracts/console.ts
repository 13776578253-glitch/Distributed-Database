/** Read models for the live Timeline and experiment Evidence. */
import type { ExperimentResult, Scalar } from './history.ts';

export const raftExperiments = ['R01', 'R02', 'R03', 'R04', 'E0', 'E1', 'E2', 'E3B', 'E4B'] as const;
export const transactionExperiments = ['T01', 'T02', 'T03'] as const;
export const verificationExperiments = ['V01', 'V02', 'V03'] as const;
export const experimentIds = [...raftExperiments, ...transactionExperiments, ...verificationExperiments] as const;
export type ExperimentId = typeof experimentIds[number];

export const experimentNames: Record<ExperimentId, string> = {
  R01: '终止 Leader', R02: '3–2 RPC 分区', R03: '并发历史采集', R04: '跨任期提交探针',
  E0: 'Raft 基线', E1: '批量提交', E2: 'Follower 读', E3B: '快照安装与恢复', E4B: '成员变更',
  T01: '事务隔离', T02: '写偏斜与具名锁', T03: 'WAL 故障恢复',
  V01: '线性一致性', V02: '事务依赖图', V03: '业务不变量',
};

/** AppendEntries 中的条目身份；index 使用 Raft 绝对索引。 */
export interface TimelineEntry {
  index: number;
  key?: string;
  value?: Scalar;
  type?: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  nodes: string[];
  term?: number;
  terms?: number[];
  indexes?: [number, number];
  indexSamples?: number[];
  entries?: TimelineEntry[];
  label: string;
  raw: unknown;
}

export interface RunSummary {
  experimentId: ExperimentId;
  runId: string;
  startedAt: string;
  status: ExperimentResult['status'];
}

export interface RunDetail {
  result: ExperimentResult;
  metadata: unknown;
  events: TimelineEvent[];
  invalidLines: number;
  files: string[];
}

export type RunnableExperiment = 'R01' | 'R02' | 'R03';
export type ConsoleOperation =
  | { kind: 'experiment'; experimentId: RunnableExperiment }
  | { kind: 'restart-node'; nodeId: string };

export interface OperationJob {
  id: string;
  action: ConsoleOperation;
  status: 'running' | 'succeeded' | 'failed';
  phase?: 'recovering';
  startedAt: string;
  runId?: string;
  verdict?: ExperimentResult['status'];
  error?: string;
}

export interface ProjectLock {
  kind: ConsoleOperation['kind'] | 'initialize' | 'observer-restart' | 'demo' | 'reset' | 'unknown';
  pid?: number;
  startedAt?: string;
  runId?: string;
  recoveryRequired?: boolean;
}

export interface OperationsStatus {
  project?: string;
  membershipLab?: boolean;
  jobs: OperationJob[];
  lock: ProjectLock | null;
}

export interface ServiceStatus {
  listener: string;
  pid: number;
  project?: string;
  dockerError?: string;
  nodes: { nodeId: string; state: string; health: string; containerId?: string }[];
  logs: { available: boolean | null; subscribers: number };
  lock: ProjectLock | null;
}

/** 控制台演示负载的只读状态；事件本身通过实时流发布。 */
export interface WorkloadStatus {
  running: boolean;
  paused: boolean;
  pausedReason?: 'experiment';
  rate: number;
  session?: string;
  leader?: string;
  operations: number;
  successes: number;
  failures: number;
  /** HTTP 504 UNKNOWN_OUTCOME：写请求可能已生效，不能算确认失败。 */
  unknown: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  lastLatencyMs?: number;
  lastKey?: string;
  lastOutcome?: string;
  startedAt?: string;
}

export type WorkloadAction =
  | { action: 'start'; rate: number }
  | { action: 'stop' };
