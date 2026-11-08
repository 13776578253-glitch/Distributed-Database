/** Continuous non-destructive demo traffic for the console live views. */
import type { ClusterObservation, NodeObservation } from '../contracts/observation.ts';
import type { TimelineEvent, WorkloadAction, WorkloadStatus } from '../contracts/console.ts';

const rates = new Set([1, 2, 5]);
const keyCount = 12;
const latencyWindow = 100;
const leaderTtlMs = 3000;

export type DemoOperation = 'put' | 'get' | 'delete';

export interface DemoPlan {
  seq: number;
  op: DemoOperation;
  key: string;
}

export interface WorkloadTarget {
  nodeId: string;
  address?: string;
}

/** 可注入的最小 HTTP 响应子集，便于在不启动真实集群时验证负载循环。 */
export interface WorkloadResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type WorkloadRequest = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<WorkloadResponse>;

export interface WorkloadDependencies {
  targets: readonly WorkloadTarget[];
  readStatuses: () => Promise<ClusterObservation>;
  publish: (event: Omit<TimelineEvent, 'id'>) => void;
  shouldPause: () => boolean;
  request?: WorkloadRequest;
  now?: () => number;
  timer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function parseWorkloadAction(value: unknown): WorkloadAction | undefined {
  if (!value || typeof value !== 'object') return;
  const action = value as Record<string, unknown>;
  if (action.action === 'stop') return { action: 'stop' };
  if (action.action !== 'start' || typeof action.rate !== 'number' || !rates.has(action.rate)) return;
  return { action: 'start', rate: action.rate };
}

export function planOperation(session: string, seq: number): DemoPlan {
  const key = `demo/${session}/k${seq % keyCount}`;
  if (seq % 12 === 11) return { seq, op: 'delete', key };
  if (seq % 5 === 4) return { seq, op: 'get', key: `demo/${session}/k${(seq * 7) % keyCount}` };
  return { seq, op: 'put', key };
}

export function latencyPercentile(samples: readonly number[], percentile: number): number | undefined {
  if (!samples.length) return;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index];
}

/** 同一最高观测任期只有一个 Leader 时才返回，和拓扑视图的判定保持一致。 */
export function pickLeader(nodes: readonly NodeObservation[]): string | undefined {
  const leaders = nodes.flatMap(node => node.ok && node.status.role === 'leader' ? [node.status] : []);
  if (!leaders.length) return;
  const term = Math.max(...leaders.map(status => status.term));
  const top = leaders.filter(status => status.term === term);
  return top.length === 1 ? top[0].nodeId : undefined;
}

const opLabel = (op: DemoOperation) => op === 'put' ? 'PUT' : op === 'delete' ? 'DELETE' : 'GET';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function createWorkload(deps: WorkloadDependencies) {
  const request: WorkloadRequest = deps.request ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let running = false;
  let paused = false;
  let rate = 2;
  let session = '';
  let seq = 0;
  let operations = 0;
  let successes = 0;
  let failures = 0;
  let latencies: number[] = [];
  let lastLatencyMs: number | undefined;
  let lastKey: string | undefined;
  let lastOutcome: string | undefined;
  let startedAt: string | undefined;
  let leader: string | undefined;
  let leaderAt = 0;
  let timerHandle: unknown;

  const interval = () => Math.max(100, Math.round(1000 / rate));
  const target = (nodeId: string | undefined) =>
    nodeId ? deps.targets.find(candidate => candidate.nodeId === nodeId && candidate.address) : undefined;

  function emit(event: Omit<TimelineEvent, 'id'>) {
    try { deps.publish(event); } catch { /* SSE 关闭时保持负载循环，事件只用于观测。 */ }
  }

  function status(): WorkloadStatus {
    const blocked = deps.shouldPause();
    return {
      running,
      paused: running ? paused || blocked : blocked,
      pausedReason: blocked ? 'experiment' : undefined,
      rate,
      session: session || undefined,
      leader,
      operations,
      successes,
      failures,
      p50LatencyMs: latencyPercentile(latencies, 50),
      p95LatencyMs: latencyPercentile(latencies, 95),
      lastLatencyMs,
      lastKey,
      lastOutcome,
      startedAt,
    };
  }

  async function resolveLeader(force = false) {
    if (!force && leader && now() - leaderAt < leaderTtlMs) return target(leader);
    const observation = await deps.readStatuses();
    leader = pickLeader(observation.nodes);
    leaderAt = now();
    return target(leader);
  }

  async function perform(node: WorkloadTarget, plan: DemoPlan) {
    const address = node.address!;
    const at = new Date(now()).toISOString();
    const label = opLabel(plan.op);
    const url = plan.op === 'get'
      ? `${address}/kv?key=${encodeURIComponent(plan.key)}`
      : `${address}${plan.op === 'put' ? '/kv/put' : '/kv/delete'}`;
    emit({
      at, kind: 'demo.request', nodes: [node.nodeId],
      label: `${label} ${plan.key}`,
      raw: { session, seq: plan.seq, op: plan.op, key: plan.key },
    });

    const started = now();
    const response = await request(url, {
      method: plan.op === 'get' ? 'GET' : 'POST',
      ...(plan.op === 'get' ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plan.op === 'put'
          ? { key: plan.key, value: plan.seq }
          : { key: plan.key }),
      }),
      signal: AbortSignal.timeout(2000),
    });
    const latencyMs = Math.max(0, now() - started);
    const body: unknown = await response.json().catch(() => null);
    const record = isRecord(body) ? body : {};
    const outcome = response.ok
      ? (plan.op === 'get' ? (record.found === true ? 'found' : 'absent')
        : plan.op === 'delete' ? 'deleted' : 'stored')
      : (typeof record.error === 'string' ? record.error : `HTTP ${response.status}`);
    emit({
      at: new Date(now()).toISOString(), kind: 'demo.response', nodes: [node.nodeId],
      label: `${label} ${response.status} · ${latencyMs}ms`,
      raw: { session, seq: plan.seq, op: plan.op, key: plan.key, latencyMs, status: response.status, outcome },
    });
    return {
      ok: response.ok,
      outcome,
      latencyMs,
      retry: response.status === 409 && record.error === 'NOT_LEADER',
    };
  }

  async function runOnce(): Promise<WorkloadStatus> {
    if (!running) return status();
    if (deps.shouldPause()) { paused = true; return status(); }
    paused = false;
    const plan = planOperation(session, seq++);
    let node: WorkloadTarget | undefined;
    try {
      node = await resolveLeader();
      if (!node) {
        operations++;
        failures++;
        lastKey = plan.key;
        lastOutcome = 'NO_LEADER';
        return status();
      }
      let result = await perform(node, plan);
      if (result.retry) {
        node = await resolveLeader(true);
        if (node) result = await perform(node, plan);
      }
      operations++;
      if (result.ok) successes++;
      else failures++;
      latencies.push(result.latencyMs);
      if (latencies.length > latencyWindow) latencies = latencies.slice(-latencyWindow);
      lastLatencyMs = result.latencyMs;
      lastKey = plan.key;
      lastOutcome = result.outcome;
    } catch (failure) {
      operations++;
      failures++;
      lastKey = plan.key;
      lastOutcome = failure instanceof Error ? failure.message : String(failure);
      emit({
        at: new Date(now()).toISOString(), kind: 'demo.error', nodes: node ? [node.nodeId] : [],
        label: `${opLabel(plan.op)} 失败 · ${lastOutcome}`,
        raw: { session, seq: plan.seq, op: plan.op, key: plan.key, error: lastOutcome },
      });
    }
    return status();
  }

  function schedule() {
    if (!running || timerHandle !== undefined) return;
    timerHandle = timer(tick, interval());
  }

  function tick() {
    timerHandle = undefined;
    if (!running) return;
    void runOnce().finally(() => {
      if (!running) return;
      // 实验暂停时降低轮询，避免在锁释放前反复探测。
      timerHandle = timer(tick, paused ? 1000 : interval());
    });
  }

  async function cleanup() {
    if (!session) return;
    const node = await resolveLeader(true).catch(() => undefined);
    if (!node?.address) return;
    for (let index = 0; index < keyCount; index++) {
      try {
        await request(`${node.address}/kv/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: `demo/${session}/k${index}` }),
          signal: AbortSignal.timeout(1500),
        });
      } catch { /* 演示键使用独立前缀，清理失败不影响主流程。 */ }
    }
  }

  function start(nextRate: number): WorkloadStatus {
    if (!rates.has(nextRate)) throw new Error('Unsupported workload rate');
    rate = nextRate;
    if (running) return status();
    running = true;
    paused = false;
    session = `demo-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    seq = 0;
    operations = 0;
    successes = 0;
    failures = 0;
    latencies = [];
    lastLatencyMs = undefined;
    lastKey = undefined;
    lastOutcome = undefined;
    leader = undefined;
    leaderAt = 0;
    startedAt = new Date(now()).toISOString();
    emit({
      at: startedAt, kind: 'demo.start', nodes: [],
      label: `演示负载开始 · ${rate} ops/s`,
      raw: { session, rate },
    });
    schedule();
    return status();
  }

  function stop(): WorkloadStatus {
    if (!running) return status();
    running = false;
    paused = false;
    if (timerHandle !== undefined) {
      clearTimer(timerHandle);
      timerHandle = undefined;
    }
    emit({
      at: new Date(now()).toISOString(), kind: 'demo.stop', nodes: [],
      label: '演示负载停止',
      raw: { session, operations, successes, failures },
    });
    void cleanup();
    return status();
  }

  function close() {
    running = false;
    paused = false;
    if (timerHandle !== undefined) {
      clearTimer(timerHandle);
      timerHandle = undefined;
    }
  }

  return { start, stop, close, runOnce, status };
}
