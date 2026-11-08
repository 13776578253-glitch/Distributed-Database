/** Derives an evidence-backed PUT trace from timeline events and cluster samples. */
import type { TimelineEvent } from '../../src/contracts/console.ts';
import type { ClusterObservation, NodeObservation } from '../../src/contracts/observation.ts';
import { groupReplication } from './swimlane.ts';
import type { RpcGroup } from './swimlane.ts';

export interface TraceObservation {
  at: string;
  nodeId: string;
  index: number;
  label: string;
}

export interface TraceNode {
  nodeId: string;
  role: 'leader' | 'follower';
  replicated: 'source' | 'accepted' | 'rejected' | 'unobserved';
  applied: 'applied' | 'pending' | 'unobserved';
  lastApplied?: number;
  appliedAt?: string;
}

export interface WriteTraceResult {
  key: string;
  seq?: number;
  session?: string;
  request?: TimelineEvent;
  response?: TimelineEvent;
  outcome?: string;
  httpStatus?: number;
  group?: RpcGroup;
  groupKey?: string;
  index?: number;
  term?: number;
  leader?: string;
  accepted: string[];
  rejected: string[];
  commit?: TraceObservation;
  apply?: TraceObservation;
  nodes: TraceNode[];
  notes: string[];
  isEvidence: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const eventTime = (event: TimelineEvent) => Date.parse(event.at);
const sampleTime = (sample: ClusterObservation) => Date.parse(sample.sampledAt);
type Reachable = Extract<NodeObservation, { ok: true }>;
const reachable = (sample: ClusterObservation): Reachable[] =>
  sample.nodes.filter((node): node is Reachable => node.ok);

export function deriveWriteTrace(
  events: readonly TimelineEvent[],
  selected: TimelineEvent,
  samples: readonly ClusterObservation[] = [],
): WriteTraceResult | undefined {
  const raw = record(selected.raw);
  const groups = groupReplication(events);
  let key: string | undefined;
  let seq: number | undefined;
  let session: string | undefined;
  let request: TimelineEvent | undefined;
  let response: TimelineEvent | undefined;
  let outcome: string | undefined;
  let httpStatus: number | undefined;
  let group: RpcGroup | undefined;
  let index: number | undefined;
  let batchSize = 0;
  let isEvidence = false;

  if (selected.kind === 'append') {
    group = groups.find(item => item.events.some(event => event.id === selected.id));
    const entries = group?.entries ?? selected.entries ?? [];
    const entry = entries.find(item => item.key !== undefined);
    key = entry?.key;
    seq = typeof entry?.value === 'number' ? entry.value : undefined;
    index = entry?.index;
    batchSize = entries.length;
  } else if (selected.kind.startsWith('demo.')) {
    if (text(raw.op) !== 'put' || typeof raw.key !== 'string') return;
    key = raw.key;
    seq = integer(raw.seq);
    session = text(raw.session);
    const related = events.filter(event => {
      const value = record(event.raw);
      return value.op === 'put' && value.key === key
        && (session === undefined || value.session === session)
        && (seq === undefined || value.seq === seq);
    });
    request = related.find(event => event.kind === 'demo.request');
    response = related.find(event => event.kind === 'demo.response')
      ?? related.find(event => event.kind === 'demo.error');
    const responseRaw = response ? record(response.raw) : {};
    outcome = text(responseRaw.outcome) ?? (response?.kind === 'demo.error' ? 'error' : undefined);
    httpStatus = integer(responseRaw.status) ?? integer(responseRaw.httpStatus);
  } else if (selected.kind === 'client.invoke' || selected.kind === 'client.return') {
    isEvidence = true;
    const details = record(raw.details);
    const operation = record(details.operation);
    if (operation.type !== 'put' || typeof operation.key !== 'string') return;
    key = operation.key;
    const operationId = details.operationId;
    const related = events.filter(event => record(record(event.raw).details).operationId === operationId);
    request = related.find(event => event.kind === 'client.invoke');
    response = related.find(event => event.kind === 'client.return');
    const responseDetails = response ? record(record(response.raw).details) : {};
    outcome = text(responseDetails.outcome);
    httpStatus = integer(responseDetails.httpStatus);
  } else {
    return;
  }

  if (!key) return;

  if (selected.kind === 'append') {
    const related = events.filter(event => {
      const value = record(event.raw);
      return value.op === 'put' && value.key === key && (seq === undefined || value.seq === seq);
    });
    request = related.find(event => event.kind === 'demo.request');
    response = related.find(event => event.kind === 'demo.response')
      ?? related.find(event => event.kind === 'demo.error');
    const responseRaw = response ? record(response.raw) : {};
    outcome = text(responseRaw.outcome) ?? (response?.kind === 'demo.error' ? 'error' : undefined);
    httpStatus = integer(responseRaw.status) ?? integer(responseRaw.httpStatus);
    session = text(record(request?.raw).session) ?? text(responseRaw.session);
  }

  if (!group && seq !== undefined) {
    const matches = groups.filter(item =>
      item.entries?.some(entry => entry.key === key && entry.value === seq));
    const anchor = request ? eventTime(request) : eventTime(selected);
    group = matches.find(item => item.at >= anchor - 100) ?? matches.at(-1);
  }
  if (group && index === undefined) {
    const entry = group.entries?.find(item => item.key === key && (seq === undefined || item.value === seq));
    index = entry?.index ?? group.indexes?.[0];
    batchSize = group.entries?.length ?? batchSize;
  }
  if (!session) {
    session = text(record(request?.raw).session) ?? text(record(response?.raw).session);
  }
  if (seq === undefined) {
    const entry = group?.entries?.find(item => item.key === key);
    seq = typeof entry?.value === 'number' ? entry.value : undefined;
  }

  const leader = group?.from ?? response?.nodes[0] ?? request?.nodes[0];
  const accepted = group?.accepted ?? [];
  const rejected = group?.rejected ?? [];
  const start = group ? group.at : request ? eventTime(request) : eventTime(selected);
  const later = samples.filter(sample => {
    const at = sampleTime(sample);
    return Number.isFinite(at) && Number.isFinite(start) && at >= start;
  });
  const latest = samples.at(-1);
  const nodeIds = new Set<string>();
  if (leader) nodeIds.add(leader);
  for (const reply of group?.replies ?? []) nodeIds.add(reply.nodeId);
  for (const node of latest?.nodes ?? []) nodeIds.add(node.nodeId);

  let commit: TraceObservation | undefined;
  let apply: TraceObservation | undefined;
  const appliedAt = new Map<string, string>();
  const lastApplied = new Map<string, number>();
  if (index !== undefined) {
    for (const sample of later) {
      const nodes = reachable(sample);
      const observer = nodes.find(node => node.nodeId === leader && node.status.commitIndex >= index)
        ?? nodes.find(node => node.status.commitIndex >= index);
      if (observer) {
        commit = { at: sample.sampledAt, nodeId: observer.nodeId, index, label: 'commitIndex' };
        break;
      }
    }
    for (const sample of later) {
      const nodes = reachable(sample);
      const observer = nodes.find(node => node.nodeId === leader && node.status.lastApplied >= index)
        ?? nodes.find(node => node.status.lastApplied >= index);
      if (observer) {
        apply = { at: sample.sampledAt, nodeId: observer.nodeId, index, label: 'lastApplied' };
        break;
      }
    }
    for (const nodeId of nodeIds) {
      for (const sample of later) {
        const node = sample.nodes.find(item => item.nodeId === nodeId);
        if (!node?.ok) continue;
        lastApplied.set(nodeId, node.status.lastApplied);
        if (node.status.lastApplied >= index) {
          appliedAt.set(nodeId, sample.sampledAt);
          break;
        }
      }
      if (latest && Number.isFinite(sampleTime(latest)) && sampleTime(latest) >= start) {
        const node = latest.nodes.find(item => item.nodeId === nodeId);
        if (node?.ok) lastApplied.set(nodeId, node.status.lastApplied);
      }
    }
  }

  const nodes: TraceNode[] = [...nodeIds].map(nodeId => {
    const replicated = nodeId === leader ? 'source'
      : accepted.includes(nodeId) ? 'accepted'
        : rejected.includes(nodeId) ? 'rejected' : 'unobserved';
    const applied: TraceNode['applied'] = index === undefined ? 'unobserved'
      : appliedAt.has(nodeId) ? 'applied'
        : lastApplied.has(nodeId) && lastApplied.get(nodeId)! < index ? 'pending' : 'unobserved';
    return {
      nodeId,
      role: nodeId === leader ? 'leader' : 'follower',
      replicated,
      applied,
      ...(appliedAt.has(nodeId) ? { appliedAt: appliedAt.get(nodeId) } : {}),
      ...(lastApplied.has(nodeId) ? { lastApplied: lastApplied.get(nodeId) } : {}),
    };
  });

  const notes: string[] = [];
  if (isEvidence) notes.push('该 Evidence 未记录 RPC 条目与绝对索引，复制、提交和应用保持未观测。');
  if (!group && !isEvidence) notes.push('当前事件窗口中未找到该写入的 AppendEntries 证据。');
  if (group && index === undefined) notes.push('已找到复制事件，但缺少可关联的条目索引。');
  if (index !== undefined && later.length === 0) notes.push('写入后尚无状态采样，提交和应用保持未观测。');
  if (index !== undefined && later.length > 0 && !commit) notes.push('当前采样尚未显示 commitIndex 覆盖该索引。');
  if (commit && !apply) notes.push('已观测到提交，但尚未观测到状态机应用。');
  if (batchSize > 1) notes.push(`该复制批次包含 ${batchSize} 条，当前追踪第 1 条。`);
  if (!response) notes.push('未观测到对应的客户端返回。');

  return {
    key,
    seq,
    session,
    request,
    response,
    outcome,
    httpStatus,
    group,
    groupKey: group?.key,
    index,
    term: group?.term,
    leader,
    accepted,
    rejected,
    commit,
    apply,
    nodes,
    notes,
    isEvidence,
  };
}
