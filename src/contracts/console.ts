/** Read models for the live Timeline and experiment Evidence. */
import type { ExperimentResult } from './history.ts';

export const experimentIds = ['R01', 'R02', 'R03', 'R04'] as const;
export type ExperimentId = typeof experimentIds[number];

export const experimentNames: Record<ExperimentId, string> = {
  R01: '终止 Leader', R02: '3–2 RPC 分区', R03: '并发历史采集', R04: '跨任期提交探针',
};

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  nodes: string[];
  term?: number;
  terms?: number[];
  indexes?: [number, number];
  indexSamples?: number[];
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

export type RunnableExperiment = Exclude<ExperimentId, 'R04'>;
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
