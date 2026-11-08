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

type SessionPlan = DemoPlan & { session: string };

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

/** 对 Raft ClientReply 的确认成功、拒绝和结果未知做统一分类。 */
export interface ClassifiedReply {
  ok: boolean;
  outcome: string;
  retry: boolean;
  uncertain?: boolean;
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

/** 全部有效节点先取最高观测任期，再要求该任期只有一个自报 Leader。 */
export function pickLeader(nodes: readonly NodeObservation[]): string | undefined {
  const valid = nodes.filter((node): node is Extract<NodeObservation, { ok: true }> => node.ok);
  if (!valid.length) return;
  const term = Math.max(...valid.map(node => node.status.term));
  const leaders = valid.filter(node => node.status.term === term && node.status.role === 'leader');
  return leaders.length === 1 ? leaders[0].nodeId : undefined;
}

/**
 * Raft HTTP 直接返回 ClientReply：成功结果位于 `result`，失败为 409/503/504 加 error。
 * DELETE 的 false 仍是 HTTP 成功（键此前不存在），不能算请求失败。
 */
export function classifyReply(plan: DemoPlan, response: WorkloadResponse, body: unknown): ClassifiedReply {
  const record = isRecord(body) ? body : {};
  if (!response.ok) {
    const outcome = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`;
    return {
      ok: false,
      outcome,
      retry: response.status === 409 && outcome === 'NOT_LEADER',
      ...(outcome === 'UNKNOWN_OUTCOME' ? { uncertain: true } : {}),
    };
  }
  const result = isRecord(record.result) ? record.result : undefined;
  if (plan.op === 'get') {
    if (result?.found === true) return { ok: true, outcome: 'found', retry: false };
    if (result?.found === false) return { ok: true, outcome: 'absent', retry: false };
  } else if (plan.op === 'put') {
    if (result?.stored === true) return { ok: true, outcome: 'stored', retry: false };
  } else if (typeof result?.deleted === 'boolean') {
    return { ok: true, outcome: result.deleted ? 'deleted' : 'absent', retry: false };
  }
  return { ok: false, outcome: 'INVALID_RESULT', retry: false };
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
  let unknown = 0;
  let latencies: number[] = [];
  let lastLatencyMs: number | undefined;
  let lastKey: string | undefined;
  let lastOutcome: string | undefined;
  let startedAt: string | undefined;
  let leader: string | undefined;
  let leaderAt = 0;
  let timerHandle: unknown;
  let inFlight: Promise<WorkloadStatus> | undefined;

  const interval = () => Math.max(100, Math.round(1000 / rate));
  const isCurrent = (id: string) => running && session === id;
  const target = (nodeId: string | undefined) =>
    nodeId ? deps.targets.find(candidate => candidate.nodeId === nodeId && candidate.address) : undefined;

  function emit(event: Omit<TimelineEvent, 'id'>) {
    try { deps.publish(event); } catch { /* SSE 关闭时保持负载循环，事件只用于观测。 */ }
  }

  function noLeader(plan: SessionPlan, attempt: number) {
    operations++;
    failures++;
    lastKey = plan.key;
    lastOutcome = 'NO_LEADER';
    emit({
      at: new Date(now()).toISOString(), kind: 'demo.error', nodes: [],
      label: `${opLabel(plan.op)} 失败 · NO_LEADER`,
      raw: { ...plan, attempt, error: 'NO_LEADER' },
    });
    return status();
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
      unknown,
      p50LatencyMs: latencyPercentile(latencies, 50),
      p95LatencyMs: latencyPercentile(latencies, 95),
      lastLatencyMs,
      lastKey,
      lastOutcome,
      startedAt,
    };
  }

  async function resolveLeader(sessionId: string, force = false) {
    if (!force && leader && now() - leaderAt < leaderTtlMs) return target(leader);
    const observation = await deps.readStatuses();
    if (!isCurrent(sessionId)) return;
    leader = pickLeader(observation.nodes);
    leaderAt = now();
    return target(leader);
  }

  async function perform(node: WorkloadTarget, plan: SessionPlan, attempt: number) {
    const address = node.address!;
    const at = new Date(now()).toISOString();
    const label = opLabel(plan.op);
    const url = plan.op === 'get'
      ? `${address}/kv?key=${encodeURIComponent(plan.key)}`
      : `${address}${plan.op === 'put' ? '/kv/put' : '/kv/delete'}`;
    emit({
      at, kind: 'demo.request', nodes: [node.nodeId],
      label: `${label} ${plan.key}`,
      raw: { ...plan, attempt },
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
    const result = classifyReply(plan, response, body);
    emit({
      at: new Date(now()).toISOString(), kind: 'demo.response', nodes: [node.nodeId],
      label: `${label} ${response.status} · ${latencyMs}ms`,
      raw: {
        ...plan, attempt,
        latencyMs, status: response.status, outcome: result.outcome,
      },
    });
    return { ...result, latencyMs };
  }

  async function runSession(sessionId: string): Promise<WorkloadStatus> {
    if (!isCurrent(sessionId)) return status();
    if (deps.shouldPause()) { paused = true; return status(); }
    paused = false;
    const plan = { ...planOperation(sessionId, seq++), session: sessionId };
    let attempt = 1;
    let node: WorkloadTarget | undefined;
    try {
      node = await resolveLeader(sessionId);
      if (!isCurrent(sessionId)) return status();
      if (!node) return noLeader(plan, attempt);
      let result = await perform(node, plan, attempt);
      if (!isCurrent(sessionId)) return status();
      if (result.retry) {
        attempt++;
        node = await resolveLeader(sessionId, true);
        if (!isCurrent(sessionId)) return status();
        if (!node) return noLeader(plan, attempt);
        result = await perform(node, plan, attempt);
        if (!isCurrent(sessionId)) return status();
      }
      operations++;
      if (result.ok) successes++;
      else if (result.uncertain) unknown++;
      else failures++;
      latencies.push(result.latencyMs);
      if (latencies.length > latencyWindow) latencies = latencies.slice(-latencyWindow);
      lastLatencyMs = result.latencyMs;
      lastKey = plan.key;
      lastOutcome = result.outcome;
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : String(failure);
      if (isCurrent(sessionId)) {
        operations++;
        failures++;
        lastKey = plan.key;
        lastOutcome = error;
        // 连接异常时下一次立即重新解析 Leader，避免继续用旧地址。
        leader = undefined;
        leaderAt = 0;
      }
      emit({
        at: new Date(now()).toISOString(), kind: 'demo.error', nodes: node ? [node.nodeId] : [],
        label: `${opLabel(plan.op)} 失败 · ${error}`,
        raw: { ...plan, attempt, error },
      });
    }
    return status();
  }

  function runOnce(): Promise<WorkloadStatus> {
    if (!running) return Promise.resolve(status());
    if (inFlight) return inFlight;
    const sessionId = session;
    const pending = Promise.resolve().then(() => runSession(sessionId)).finally(() => {
      if (inFlight === pending) inFlight = undefined;
    });
    inFlight = pending;
    return pending;
  }

  function schedule(delay = interval()) {
    if (!running || timerHandle !== undefined) return;
    const sessionId = session;
    timerHandle = timer(() => {
      if (!isCurrent(sessionId)) return;
      timerHandle = undefined;
      void runOnce().finally(() => {
        // 旧会话结束后不可替新会话调度下一次写入。
        if (isCurrent(sessionId)) schedule(paused ? 1000 : interval());
      });
    }, delay);
  }

  async function cleanup(cleanupSession: string) {
    if (!cleanupSession) return;
    let node: WorkloadTarget | undefined;
    let cleaned = 0;
    let failed = 0;
    try {
      node = target(pickLeader((await deps.readStatuses()).nodes));
      if (!node?.address) {
        emit({
          at: new Date(now()).toISOString(), kind: 'demo.cleanup', nodes: [],
          label: '清理跳过 · NO_LEADER',
          raw: { session: cleanupSession, attempted: 0, cleaned: 0, failed: 0, outcome: 'NO_LEADER' },
        });
        return;
      }
      for (let index = 0; index < keyCount; index++) {
        try {
          const response = await request(`${node.address}/kv/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: `demo/${cleanupSession}/k${index}` }),
            signal: AbortSignal.timeout(1500),
          });
          if (response.ok) cleaned++;
          else failed++;
        } catch { failed++; }
      }
    } catch {
      failed = keyCount;
    }
    emit({
      at: new Date(now()).toISOString(), kind: 'demo.cleanup', nodes: node ? [node.nodeId] : [],
      label: `清理演示键 · ${cleaned}/${keyCount} 成功`,
      raw: { session: cleanupSession, attempted: keyCount, cleaned, failed },
    });
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
    unknown = 0;
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
    const stoppedSession = session;
    const pending = inFlight;
    inFlight = undefined;
    running = false;
    paused = false;
    if (timerHandle !== undefined) {
      clearTimer(timerHandle);
      timerHandle = undefined;
    }
    emit({
      at: new Date(now()).toISOString(), kind: 'demo.stop', nodes: [],
      label: '演示负载停止',
      raw: { session: stoppedSession, operations, successes, failures, unknown },
    });
    // 等待已发出的写请求结束，再删除这个会话的演示键。
    if (pending) void pending.finally(() => cleanup(stoppedSession));
    else void cleanup(stoppedSession);
    return status();
  }

  function close() {
    running = false;
    paused = false;
    inFlight = undefined;
    if (timerHandle !== undefined) {
      clearTimer(timerHandle);
      timerHandle = undefined;
    }
  }

  return { start, stop, close, runOnce, status };
}
