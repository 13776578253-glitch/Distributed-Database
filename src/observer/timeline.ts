/** Projects real container log records and Evidence lines into timeline rows. */
import type { TimelineEvent } from '../contracts/console.ts';
import type { RpcObservation } from '../contracts/observation.ts';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const strings = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))];

function json(line: string): Record<string, unknown> {
  try { return object(JSON.parse(line)); } catch { return {}; }
}

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
  if (kind !== 'raft.rpc' || typeof from !== 'string' || typeof to !== 'string' || from === to) return;
  const request = object(raw.request);
  const reply = object(raw.reply);
  const term = number(request.term);
  if (term === undefined || (request.kind !== 'vote' && request.kind !== 'append') || reply.kind !== request.kind) return;
  const accepted = request.kind === 'vote' ? reply.granted : reply.success;
  if (typeof accepted !== 'boolean') return;
  const count = Array.isArray(request.entries) ? request.entries.length : 0;
  const previous = number(request.prevLogIndex);
  const indexes: [number, number] | undefined = count && previous !== undefined
    ? [previous + 1, previous + count] : undefined;
  const label = request.kind === 'vote' ? 'RequestVote' : 'AppendEntries';
  return {
    event: { at, kind: request.kind, nodes: [from, to], term, indexes, label: `${label} · ${accepted ? '接受' : '拒绝'}`, raw },
    rpc: { at, from, to, term, kind: request.kind, accepted },
  };
}

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
  const indexes = [...statuses.map(status => status.commitIndex), details.index, details.commitIndex]
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
