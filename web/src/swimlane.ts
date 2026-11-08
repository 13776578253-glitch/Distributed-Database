/** Projects timeline events into per-node role, fault and time-axis lanes. */
import type { TimelineEntry, TimelineEvent } from '../../src/contracts/console.ts';

export type Role = 'leader' | 'candidate' | 'follower' | 'unknown';

/** 实时模式的角色 seed 必须带采样时间，只影响采样之后的区间；回放不提供。 */
export interface RoleSeed {
  nodeId: string;
  role: Role;
  term?: number;
  /** 采样时间；用于避免把采样当时的角色倒填到整个历史窗口。 */
  at?: number;
}

export interface RoleSegment {
  nodeId: string;
  start: number;
  end: number;
  role: Role;
  term?: number;
  eventId?: string;
  fault?: 'down' | 'isolated';
}

export interface FaultWindow {
  nodeId: string;
  start: number;
  end: number;
  kind: 'down' | 'isolated';
  label: string;
}

export interface FaultMarker {
  at: number;
  kind: string;
  label: string;
  eventId: string;
}

/** 一次逻辑日志复制：同一任期、索引区间和条目载荷的多个 follower 应答。 */
export interface RpcGroup {
  key: string;
  at: number;
  from: string;
  term?: number;
  indexes?: [number, number];
  entries?: TimelineEntry[];
  replies: { nodeId: string; accepted?: boolean; at: string }[];
  accepted: string[];
  rejected: string[];
  events: TimelineEvent[];
}

type RoleChange = { at: number; role: Role; term?: number; eventId?: string };
type Extent = readonly [number, number];

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const rpcKinds = new Set(['vote', 'append', 'snapshot', 'read-index', 'rpc.error']);
const replicationAttemptWindowMs = 500;
const tickSteps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000];

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const roleValue = (value: unknown): Role | undefined =>
  value === 'leader' || value === 'candidate' || value === 'follower' ? value : undefined;
const time = (event: TimelineEvent) => Date.parse(event.at);

export function deriveLanes(events: readonly TimelineEvent[]): string[] {
  const nodes = new Set<string>();
  for (const event of events) for (const node of event.nodes) nodes.add(node);
  return [...nodes].sort(collator.compare);
}

function eventRange(events: readonly TimelineEvent[]): [number, number] | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const event of events) {
    const at = time(event);
    if (!Number.isFinite(at)) continue;
    start = Math.min(start, at);
    end = Math.max(end, at);
  }
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : undefined;
}

export function timeExtent(events: readonly TimelineEvent[]): [number, number] | undefined {
  const range = eventRange(events);
  if (!range) return;
  return range[1] - range[0] < 1000 ? [range[0], range[0] + 1000] : range;
}

export function liveExtent(events: readonly TimelineEvent[], windowMs: number, now?: number): [number, number] {
  const range = eventRange(events);
  const end = Math.max(now ?? -Infinity, range?.[1] ?? -Infinity);
  const anchor = Number.isFinite(end) ? end : Date.now();
  if (windowMs > 0) return [anchor - windowMs, anchor];
  const start = range?.[0] ?? anchor - 60000;
  return start < anchor ? [start, anchor] : [anchor - 1000, anchor];
}

export function roleSegments(
  events: readonly TimelineEvent[],
  lanes: readonly string[],
  extent: Extent,
  seeds: readonly RoleSeed[] = [],
): RoleSegment[] {
  const [start, end] = extent;
  if (end <= start) return [];

  const changes = new Map<string, RoleChange[]>();
  const add = (nodeId: string, change: RoleChange) => {
    const list = changes.get(nodeId);
    if (list) list.push(change);
    else changes.set(nodeId, [change]);
  };
  for (const seed of seeds) {
    const at = seed.at !== undefined && Number.isFinite(seed.at)
      ? Math.max(start, seed.at) : start;
    if (at > end) continue;
    add(seed.nodeId, { at, role: seed.role, term: seed.term });
  }
  for (const event of events) {
    const at = time(event);
    if (!Number.isFinite(at)) continue;
    if (event.kind === 'raft.role') {
      const raw = object(event.raw);
      const nodeId = event.nodes[0] ?? (typeof raw.nodeId === 'string' ? raw.nodeId : undefined);
      const role = roleValue(raw.role);
      if (!nodeId || !role) continue;
      add(nodeId, { at, role, term: event.term ?? integer(raw.term), eventId: event.id });
      continue;
    }
    if (event.kind !== 'raft.status') continue;
    const details = object(object(event.raw).details);
    const statuses = Array.isArray(details.nodes) ? details.nodes : [];
    for (const status of statuses) {
      const value = object(status);
      const role = roleValue(value.role);
      if (typeof value.nodeId !== 'string' || !role) continue;
      add(value.nodeId, { at, role, term: integer(value.term), eventId: event.id });
    }
  }

  const segments: RoleSegment[] = [];
  for (const nodeId of lanes) {
    const ordered = (changes.get(nodeId) ?? []).sort((a, b) => a.at - b.at);
    const compact: RoleChange[] = [];
    for (const change of ordered) {
      const previous = compact.at(-1);
      // 连续状态采样不产生新分段，只在角色或任期变化时切分。
      if (previous && previous.role === change.role && previous.term === change.term) continue;
      compact.push(change);
    }
    if (!compact.length) {
      segments.push({ nodeId, start, end, role: 'unknown' });
      continue;
    }
    if (compact[0].at > start) segments.push({ nodeId, start, end: Math.min(compact[0].at, end), role: 'unknown' });
    for (let index = 0; index < compact.length; index++) {
      const change = compact[index];
      const from = Math.max(change.at, start);
      const to = Math.min(compact[index + 1]?.at ?? end, end);
      if (to <= from) continue;
      segments.push({ nodeId, start: from, end: to, role: change.role, term: change.term, eventId: change.eventId });
    }
  }
  return segments;
}

export function applyFaultWindows(segments: readonly RoleSegment[], windows: readonly FaultWindow[]): RoleSegment[] {
  const result: RoleSegment[] = [];
  for (const segment of segments) {
    const overlaps = windows
      .filter(window => window.nodeId === segment.nodeId && window.start < segment.end && window.end > segment.start)
      .sort((a, b) => a.start - b.start);
    if (!overlaps.length) {
      result.push(segment);
      continue;
    }
    let cursor = segment.start;
    let resumed = false;
    for (const window of overlaps) {
      if (window.start > cursor) {
        result.push({ ...segment, start: cursor, end: window.start, role: resumed ? 'unknown' : segment.role,
          fault: resumed ? undefined : segment.fault, eventId: resumed ? undefined : segment.eventId });
      }
      const from = Math.max(window.start, cursor);
      const to = Math.min(window.end, segment.end);
      if (to > from) {
        const downgraded = window.kind === 'down' || resumed;
        result.push({ ...segment, start: from, end: to, fault: window.kind,
          role: downgraded ? 'unknown' : segment.role, eventId: downgraded ? undefined : segment.eventId });
      }
      cursor = Math.max(cursor, to);
      // 终止期间没有可信的本地角色，重启后保持未知直到下一次有效采样。
      if (window.kind === 'down') resumed = true;
    }
    if (cursor < segment.end) {
      result.push({ ...segment, start: cursor, end: segment.end, role: resumed ? 'unknown' : segment.role,
        fault: resumed ? undefined : segment.fault, eventId: resumed ? undefined : segment.eventId });
    }
  }
  return result;
}

export function faultWindows(events: readonly TimelineEvent[], extent: Extent): FaultWindow[] {
  const [start, end] = extent;
  const down = new Map<string, { start: number; label: string }>();
  const isolated = new Map<string, { start: number; label: string }>();
  const closedDown: FaultWindow[] = [];
  const closedIsolated: FaultWindow[] = [];

  for (const event of events) {
    const at = time(event);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const raw = object(event.raw);
    const details = object(raw.details);
    const nodeId = event.nodes[0]
      ?? (typeof raw.nodeId === 'string' ? raw.nodeId : typeof details.nodeId === 'string' ? details.nodeId : undefined);
    if (!nodeId) continue;

    if (event.kind === 'fault.kill') {
      const current = down.get(nodeId);
      if (current) closedDown.push({ nodeId, start: current.start, end: at, kind: 'down', label: current.label });
      down.set(nodeId, { start: at, label: '节点终止' });
      continue;
    }
    if (event.kind === 'fault.restart') {
      const current = down.get(nodeId);
      if (current) {
        closedDown.push({ nodeId, start: current.start, end: at, kind: 'down', label: current.label });
        down.delete(nodeId);
      }
      continue;
    }
    if (event.kind !== 'fault.links') continue;

    const peers = Array.isArray(details.blockedPeers) ? details.blockedPeers
      : Array.isArray(raw.blockedPeers) ? raw.blockedPeers : [];
    const names = peers.filter((peer): peer is string => typeof peer === 'string');
    if (names.length) {
      if (!isolated.has(nodeId)) isolated.set(nodeId, { start: at, label: `隔离 ${names.join('、')}` });
    } else {
      const current = isolated.get(nodeId);
      if (current) {
        closedIsolated.push({ nodeId, start: current.start, end: at, kind: 'isolated', label: current.label });
        isolated.delete(nodeId);
      }
    }
  }

  const openDown: FaultWindow[] = [...down].map(([nodeId, current]) =>
    ({ nodeId, start: current.start, end, kind: 'down', label: current.label }));
  const openIsolated: FaultWindow[] = [...isolated].map(([nodeId, current]) =>
    ({ nodeId, start: current.start, end, kind: 'isolated', label: current.label }));
  return [...closedDown, ...openDown, ...closedIsolated, ...openIsolated].sort((a, b) => a.start - b.start);
}

export function faultMarkers(events: readonly TimelineEvent[], extent: Extent): FaultMarker[] {
  const markers: FaultMarker[] = [];
  for (const event of events) {
    const at = time(event);
    if (!Number.isFinite(at) || at < extent[0] || at > extent[1]) continue;
    if (event.kind === 'fault.partition' || event.kind === 'observer.gap') {
      markers.push({ at, kind: event.kind, label: event.label, eventId: event.id });
    }
  }
  return markers;
}

/**
 * 聚合一次逻辑复制的 follower 应答。事件没有 RPC attempt id，因此用
 * leader+term+索引+完整条目载荷作为身份，并用 500ms 的连续窗口隔离重试。
 * 超过窗口的同载荷事件属于新的 RPC 尝试，不能覆盖上一轮 reply。
 */
export function groupReplication(events: readonly TimelineEvent[]): RpcGroup[] {
  const groups = new Map<string, RpcGroup[]>();
  const ordered = events
    .filter(event => event.kind === 'append' && event.nodes.length >= 2 && event.nodes[0] !== event.nodes[1])
    .sort((left, right) => time(left) - time(right));
  for (const event of ordered) {
    const at = time(event);
    if (!Number.isFinite(at)) continue;
    const signature = JSON.stringify((event.entries ?? []).map(entry =>
      [entry.index, entry.type ?? null, entry.key ?? null, entry.value ?? null]));
    const identity = `${event.nodes[0]}|${event.term ?? ''}|${event.indexes?.[0] ?? ''}|${event.indexes?.[1] ?? ''}|${signature}`;
    const target = event.nodes[1];
    const attempts = groups.get(identity) ?? [];
    // 同一 follower 在同一载荷上再次出现意味着新的 RPC 尝试，即使仍在时间窗口内。
    let group = attempts.find(candidate => at >= candidate.at && at - candidate.at <= replicationAttemptWindowMs
      && !candidate.replies.some(reply => reply.nodeId === target));
    if (!group) {
      group = {
        key: `${identity}@${attempts.length}`, at, from: event.nodes[0], term: event.term, indexes: event.indexes,
        entries: event.entries, replies: [], accepted: [], rejected: [], events: [],
      };
      attempts.push(group);
      groups.set(identity, attempts);
    }
    group.events.push(event);
    group.replies.push({ nodeId: target, accepted: rpcAccepted(event), at: event.at });
  }
  for (const attempts of groups.values()) {
    for (const group of attempts) {
      group.accepted = group.replies.filter(reply => reply.accepted === true).map(reply => reply.nodeId);
      group.rejected = group.replies.filter(reply => reply.accepted === false).map(reply => reply.nodeId);
    }
  }
  return [...groups.values()].flat().sort((a, b) => a.at - b.at);
}

export function isRpcEvent(event: TimelineEvent): boolean {
  return rpcKinds.has(event.kind) && event.nodes.length >= 2 && event.nodes[0] !== event.nodes[1];
}

export function rpcAccepted(event: TimelineEvent): boolean | undefined {
  if (event.kind === 'rpc.error') return false;
  if (event.label.includes('拒绝')) return false;
  if (event.label.includes('接受')) return true;
  const reply = object(object(event.raw).reply);
  if (typeof reply.granted === 'boolean') return reply.granted;
  if (typeof reply.success === 'boolean') return reply.success;
  if (typeof reply.ok === 'boolean') return reply.ok;
  return;
}

export function dotTone(event: TimelineEvent): 'client' | 'assertion' | 'demo' | 'demo-error' | 'plain' {
  if (event.kind === 'demo.error') return 'demo-error';
  if (event.kind.startsWith('demo.')) return 'demo';
  if (event.kind.startsWith('client.')) return 'client';
  if (event.kind === 'assertion') return 'assertion';
  return 'plain';
}

export function timeTicks(start: number, end: number, target = 6): number[] {
  const span = Math.max(end - start, 1);
  const step = tickSteps.find(value => span / value <= Math.max(target, 2)) ?? tickSteps.at(-1)!;
  const first = Math.ceil(start / step) * step;
  const ticks: number[] = [];
  for (let at = first; at <= end; at += step) ticks.push(at);
  return ticks.length ? ticks : [start];
}
