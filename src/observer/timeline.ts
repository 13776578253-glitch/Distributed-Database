/** Projects container log lines and Evidence records into timeline rows. */
import type { TimelineEntry, TimelineEvent } from '../contracts/console.ts';
import type { RpcObservation } from '../contracts/observation.ts';
import { isScalar } from '../contracts/history.ts';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const strings = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))];
const rpcNames: Record<string, string> = {
  vote: 'RequestVote', append: 'AppendEntries', snapshot: 'InstallSnapshot', readIndex: 'ReadIndex',
};

function json(line: string): Record<string, unknown> {
  try { return object(JSON.parse(line)); } catch { return {}; }
}

/**
 * 解析一行带 ISO 时间戳的容器输出。只有能确认节点/方向/请求应答形状的
 * raft.rpc 才产生 RpcObservation；缺字段或请求应答 kind 不一致则丢弃。
 */
export function containerEvent(line: string): { event: Omit<TimelineEvent, 'id'>; rpc?: RpcObservation } | undefined {
  const match = /^(\S+)\s+(\{.*\})\s*$/.exec(line);
  if (!match || !Number.isFinite(Date.parse(match[1]))) return;
  const at = match[1];
  const raw = json(match[2]);
  const { kind, nodeId, role, from, to } = raw;
  if (kind === 'raft.role' && typeof nodeId === 'string' && typeof role === 'string') {
    return { event: { at, kind, nodes: [nodeId], term: number(raw.term), label: `${nodeId} · ${role}`, raw } };
  }
  if (kind === 'fault.links' && typeof nodeId === 'string') {
    const peers = Array.isArray(raw.blockedPeers) ? strings(raw.blockedPeers) : [];
    return { event: { at, kind, nodes: [nodeId, ...peers], label: peers.length ? `阻断 ${peers.join('、')}` : '恢复 RPC 链路', raw } };
  }
  if (typeof from !== 'string' || typeof to !== 'string' || from === to) return;
  if (kind === 'raft.rpc.error' && typeof raw.rpc === 'string' && typeof raw.reason === 'string') {
    return {
      event: {
        at, kind: 'rpc.error', nodes: [from, to],
        label: `${rpcNames[raw.rpc] ?? raw.rpc} 失败 · ${raw.reason}`, raw,
      },
    };
  }
  // ReadIndex 只投影明确成功的应答；其他形状不产生事件。
  const reply = object(raw.reply);
  if (kind === 'raft.read-index' && reply.ok === true) {
    const term = number(reply.term);
    const readIndex = number(reply.readIndex);
    if (term === undefined || readIndex === undefined) return;
    return {
      event: { at, kind: 'read-index', nodes: [from, to], term, indexSamples: [readIndex], label: 'ReadIndex · 接受', raw },
      rpc: { at, from, to, term, kind: 'read-index', accepted: true },
    };
  }
  if (kind !== 'raft.rpc') return;
  const request = object(raw.request);
  const term = number(request.term);
  if (term === undefined || (request.kind !== 'vote' && request.kind !== 'append' && request.kind !== 'snapshot')
    || reply.kind !== request.kind) return;
  const accepted = request.kind === 'vote' ? reply.granted : reply.success;
  if (typeof accepted !== 'boolean') return;
  // AppendEntries 条目的绝对索引由 prevLogIndex 和批内偏移推出。
  const entries = Array.isArray(request.entries) ? request.entries.map(object) : [];
  const previous = number(request.prevLogIndex);
  const entryDetails: TimelineEntry[] = entries.flatMap((entry, offset) => {
    const command = object(entry.command);
    if (previous === undefined) return [];
    return [{
      index: previous + offset + 1,
      ...(typeof command.key === 'string' ? { key: command.key } : {}),
      ...(isScalar(command.value) ? { value: command.value } : {}),
      ...(typeof command.type === 'string' ? { type: command.type } : {}),
    }];
  });
  const count = entries.length;
  const indexes: [number, number] | undefined = count && previous !== undefined
    ? [previous + 1, previous + count] : undefined;
  const label = request.kind === 'vote' ? 'RequestVote' : request.kind === 'snapshot' ? 'InstallSnapshot' : 'AppendEntries';
  const keys = strings(entryDetails.map(entry => entry.key));
  const keyLabel = keys.length ? ` · ${keys[0]}${keys.length > 1 ? ` +${keys.length - 1}` : ''}` : '';
  const snapshotIndex = number(request.lastIncludedIndex);
  return {
    event: { at, kind: request.kind, nodes: [from, to], term, indexes,
      entries: entryDetails.length ? entryDetails : undefined,
      indexSamples: snapshotIndex === undefined ? undefined : [snapshotIndex],
      label: `${label}${keyLabel} · ${accepted ? '接受' : '拒绝'}`, raw },
    rpc: { at, from, to, term, kind: request.kind, accepted },
  };
}

/** Evidence 行只保证 at/kind；节点和索引是从已知 details 字段提取的样本。 */
export function evidenceEvent(line: string, lineNumber: number): TimelineEvent | undefined {
  const raw = json(line);
  const { at, kind } = raw;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof kind !== 'string') return;
  const details = object(raw.details);
  const facts = object(details.details);
  const statuses = Array.isArray(details.nodes) ? details.nodes.map(object) : [];
  const nodes = strings([details.nodeId, details.from, details.to, facts.previous, facts.next, facts.leader,
    ...statuses.map(status => status.nodeId),
    ...(Array.isArray(details.majority) ? details.majority : []),
    ...(Array.isArray(details.minority) ? details.minority : [])]);
  const indexes = [...statuses.map(status => status.commitIndex), details.index, details.commitIndex, details.snapshotIndex]
    .map(number).filter(value => value !== undefined);
  const terms = [...new Set(statuses.map(status => number(status.term)).filter(value => value !== undefined))];
  return {
    id: String(lineNumber), at, kind, nodes,
    term: number(details.term) ?? number(facts.term), terms,
    indexSamples: [...new Set(indexes)],
    label: typeof details.name === 'string' ? details.name : typeof details.label === 'string' ? details.label : kind,
    raw,
  };
}
