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
