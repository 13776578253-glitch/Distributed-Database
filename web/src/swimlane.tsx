/** Renders per-node role, RPC and fault lanes over a shared time axis. */
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TimelineEvent } from '../../src/contracts/console.ts';
import { PreferencesContext } from './preferences.tsx';
import {
  applyFaultWindows, deriveLanes, dotTone, faultMarkers, faultWindows, groupReplication, isRpcEvent,
  liveExtent, roleSegments, rpcAccepted, timeExtent, timeTicks,
} from './swimlane.ts';
import type { Role, RoleSeed } from './swimlane.ts';

const AXIS_HEIGHT = 28;
const LANE_HEIGHT = 34;
const LANE_GAP = 6;
const LABEL_WIDTH = 66;
const PAD = 8;
const roleNames: Record<Role, string> = {
  leader: 'Leader', candidate: 'Candidate', follower: 'Follower', unknown: '未知',
};

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Swimlane({ events, lanes, history, extent, windowMs, follow, seeds, selectedId, focusGroupKey, onSelect }: {
  events: readonly TimelineEvent[];
  lanes?: readonly string[];
  history?: readonly TimelineEvent[];
  extent?: readonly [number, number];
  windowMs?: number;
  follow?: boolean;
  seeds?: readonly RoleSeed[];
  selectedId?: string;
  focusGroupKey?: string;
  onSelect?: (id: string) => void;
}) {
  const [ref, width] = useWidth();
  const { hour12 } = useContext(PreferencesContext);
  const identifier = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'swimlane';
  const source = history ?? events;
  const nodeIds = useMemo(() => lanes ?? deriveLanes(source), [lanes, source]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!follow || windowMs === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [follow, windowMs]);
  const extentStart = extent?.[0];
  const extentEnd = extent?.[1];
  const range = useMemo<[number, number]>(() => {
    if (extentStart !== undefined && extentEnd !== undefined) return [extentStart, extentEnd];
    if (windowMs !== undefined) return liveExtent(source, windowMs, follow ? now : undefined);
    return timeExtent(source) ?? liveExtent(source, 60000);
  }, [extentStart, extentEnd, source, windowMs, follow, now]);
  const [rangeStart, rangeEnd] = range;
  const windows = useMemo(() => faultWindows(source, range), [source, range]);
  const segments = useMemo(() => applyFaultWindows(roleSegments(source, nodeIds, range, seeds), windows),
    [source, nodeIds, range, seeds, windows]);
  const markers = useMemo(() => faultMarkers(source, range), [source, range]);
  const groups = useMemo(() => groupReplication(source), [source]);
  const focusGroup = useMemo(() => {
    const selectedGroup = selectedId
      ? groups.find(group => group.events.some(event => event.id === selectedId)) : undefined;
    return (focusGroupKey ? groups.find(group => group.key === focusGroupKey) : undefined)
      ?? selectedGroup ?? groups.at(-1);
  }, [groups, focusGroupKey, selectedId]);
  const laneIndex = useMemo(() => new Map(nodeIds.map((node, index) => [node, index])), [nodeIds]);
  const formatter = useMemo(() => new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12,
  }), [hour12]);
  const format = (at: number) => formatter.format(new Date(at));

  const plotLeft = LABEL_WIDTH + PAD;
  const plotRight = Math.max(plotLeft + 24, width - PAD);
  const plotWidth = Math.max(plotRight - plotLeft, 1);
  const ticks = timeTicks(rangeStart, rangeEnd, Math.max(2, Math.min(6, Math.floor(plotWidth / 70))));
  const height = AXIS_HEIGHT + Math.max(nodeIds.length, 1) * (LANE_HEIGHT + LANE_GAP) - LANE_GAP + PAD;
  const laneTop = (index: number) => AXIS_HEIGHT + index * (LANE_HEIGHT + LANE_GAP);
  const laneMiddle = (index: number) => laneTop(index) + LANE_HEIGHT / 2;
  const scale = (at: number) => plotLeft + ((at - rangeStart) / Math.max(rangeEnd - rangeStart, 1)) * plotWidth;
  const visible = (at: number) => at >= rangeStart && at <= rangeEnd;
  const headingId = `${identifier}-heading`;

  return <section className="swimlane" aria-labelledby={headingId}>
    <div className="swimlane-heading">
      <h3 id={headingId}>节点泳道</h3>
      <span className="muted">{nodeIds.length} 个节点 · {events.length} 个事件</span>
    </div>
    <div className="swimlane-body" ref={ref}>
      {!nodeIds.length ? <p className="empty-state">等待节点事件…</p>
        : width > 0 ? <svg width={width} height={height} role="img"
          aria-label="按节点分行的 Raft 事件时序图，表格提供逐条键盘操作">
          <defs>
            <marker id={`${identifier}-accepted`} viewBox="0 0 6 6" refX="5.5" refY="3"
              markerWidth="5" markerHeight="5" orient="auto">
              <path className="rpc-arrow accepted" d="M0 0 6 3 0 6Z" />
            </marker>
            <marker id={`${identifier}-rejected`} viewBox="0 0 6 6" refX="5.5" refY="3"
              markerWidth="5" markerHeight="5" orient="auto">
              <path className="rpc-arrow rejected" d="M0 0 6 3 0 6Z" />
            </marker>
            <marker id={`${identifier}-unknown`} viewBox="0 0 6 6" refX="5.5" refY="3"
              markerWidth="5" markerHeight="5" orient="auto">
              <path className="rpc-arrow unknown" d="M0 0 6 3 0 6Z" />
            </marker>
          </defs>
          {nodeIds.map((node, index) => <g key={node}>
            <rect className="lane-bg" x={plotLeft} y={laneTop(index)} width={plotWidth}
              height={LANE_HEIGHT} rx={6} />
            <text className="swimlane-label" x={10} y={laneMiddle(index) + 4}>{node}</text>
          </g>)}
          {ticks.map(at => {
            const x = scale(at);
            return <g key={at}>
              <line className="swimlane-grid" x1={x} x2={x} y1={AXIS_HEIGHT - 6} y2={height - PAD} />
              <text className="swimlane-axis" x={Math.min(Math.max(x, plotLeft + 20), plotRight - 20)}
                y={AXIS_HEIGHT - 12} textAnchor="middle">{format(at)}</text>
            </g>;
          })}
          {segments.map((segment, index) => {
            const lane = laneIndex.get(segment.nodeId);
            if (lane === undefined) return null;
            const x1 = scale(segment.start);
            const x2 = Math.max(scale(segment.end), x1 + 1);
            const w = x2 - x1;
            const selected = segment.eventId !== undefined && segment.eventId === selectedId;
            const label = `${roleNames[segment.role]}${segment.term !== undefined ? ` · T${segment.term}` : ''}`;
            const showLabel = segment.role !== 'unknown' && w > label.length * 6.2 + 12;
            const activate = segment.eventId && onSelect
              ? () => onSelect(segment.eventId!) : undefined;
            return <g key={`${segment.nodeId}/${index}`} className={activate ? 'role-group' : undefined}
              onClick={activate} role={activate ? 'button' : undefined} tabIndex={activate ? 0 : undefined}
              onKeyDown={activate ? event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activate();
                }
              } : undefined}>
              <rect className={`role-segment role-${segment.role}${segment.fault ? ` fault-${segment.fault}` : ''}${selected ? ' selected' : ''}`}
                x={x1} y={laneTop(lane) + 3} width={w} height={LANE_HEIGHT - 6} rx={5}>
                <title>{segment.nodeId} · {label}{segment.eventId ? ` · ${format(segment.start)}` : ''}</title>
              </rect>
              {showLabel && <text className="role-text" x={x1 + 6} y={laneMiddle(lane) + 3.5}>{label}</text>}
            </g>;
          })}
          {windows.map((window, index) => {
            const lane = laneIndex.get(window.nodeId);
            if (lane === undefined) return null;
            const x1 = scale(window.start);
            const x2 = Math.max(scale(window.end), x1 + 1.5);
            return <g key={`${window.nodeId}/${window.kind}/${index}`}>
              <rect className={`fault-window fault-${window.kind}`} x={x1} y={laneTop(lane) + 2}
                width={Math.max(x2 - x1, 1.5)} height={LANE_HEIGHT - 4} rx={4}>
                <title>{window.label} · {format(window.start)} – {format(window.end)}</title>
              </rect>
              <line className={`fault-edge fault-${window.kind}`} x1={x1} x2={x1}
                y1={laneTop(lane)} y2={laneTop(lane) + LANE_HEIGHT} />
              {x2 - x1 > 2 && <line className={`fault-edge fault-${window.kind}`} x1={x2} x2={x2}
                y1={laneTop(lane)} y2={laneTop(lane) + LANE_HEIGHT} />}
            </g>;
          })}
          {groups.filter(group => visible(group.at)).map(group => {
            const lane = laneIndex.get(group.from);
            if (lane === undefined) return null;
            const x = scale(group.at);
            const selected = group.key === focusGroup?.key;
            const rejected = group.rejected.length > 0;
            const unknown = group.replies.filter(reply => reply.accepted === undefined).length;
            const firstKey = group.entries?.find(entry => entry.key)?.key;
            return <g key={group.key} className="replication-group" onClick={() => onSelect?.(group.events[0].id)}>
              <rect className={`group-tick${rejected ? ' rejected' : ''}${!group.accepted.length && !rejected ? ' unknown' : ''}${selected ? ' selected' : ''}`}
                x={x - 1.5} y={laneTop(lane) + 1} width={3} height={8} rx={1.5}>
                <title>{`任期 ${group.term ?? '—'} · 索引 ${group.indexes?.join('–') ?? '—'}${firstKey ? ` · ${firstKey}` : ''} · 接受 ${group.accepted.length}/${group.replies.length}${rejected ? ` · 拒绝 ${group.rejected.join('、')}` : ''}${unknown ? ` · 未确认 ${unknown}` : ''}`}</title>
              </rect>
            </g>;
          })}
          {focusGroup && visible(focusGroup.at) && (() => {
            const fromLane = laneIndex.get(focusGroup.from);
            if (fromLane === undefined) return null;
            const x = scale(focusGroup.at);
            return focusGroup.replies.map(reply => {
              const toLane = laneIndex.get(reply.nodeId);
              if (toLane === undefined || toLane === fromLane) return null;
              const y1 = laneMiddle(fromLane);
              const y2 = laneMiddle(toLane);
              const room = Math.max(8, plotRight - x);
              const bulge = Math.min(48, room, 16 + Math.abs(y2 - y1) * 0.18);
              const path = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`;
              const event = focusGroup.events.find(item => item.nodes[1] === reply.nodeId);
              const tone = reply.accepted === true ? 'accepted' : reply.accepted === false ? 'rejected' : 'unknown';
              return <g key={`${focusGroup.key}/${reply.nodeId}`} className="rpc-group focused"
                onClick={() => event && onSelect?.(event.id)}>
                <path className={`rpc-arc focused ${tone}`} d={path}
                  markerEnd={`url(#${identifier}-${tone})`} />
                <title>{`${focusGroup.from} → ${reply.nodeId} · ${reply.accepted === true ? '接受' : reply.accepted === false ? '拒绝' : '未确认'} · ${format(focusGroup.at)}`}</title>
              </g>;
            });
          })()}
          {events.filter(event => isRpcEvent(event) && event.kind !== 'append').map(event => {
            const at = Date.parse(event.at);
            if (!Number.isFinite(at) || !visible(at)) return null;
            const from = laneIndex.get(event.nodes[0]);
            const to = laneIndex.get(event.nodes[1]);
            if (from === undefined || to === undefined || from === to) return null;
            const x = scale(at);
            const y1 = laneMiddle(from);
            const y2 = laneMiddle(to);
            const room = Math.max(8, plotRight - x);
            const bulge = Math.min(48, room, 16 + Math.abs(y2 - y1) * 0.18);
            const accepted = rpcAccepted(event);
            const tone = accepted === true ? 'accepted' : accepted === false ? 'rejected' : 'unknown';
            const selected = event.id === selectedId;
            const path = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`;
            return <g key={event.id} className="rpc-group" onClick={() => onSelect?.(event.id)}>
              <path className={`rpc-arc ${tone}${selected ? ' selected' : ''}`}
                d={path} markerEnd={`url(#${identifier}-${tone})`} />
              <title>{event.nodes[0]} → {event.nodes[1]} · {event.label} · {format(at)}</title>
            </g>;
          })}
          {events.filter(event => !isRpcEvent(event) && event.kind !== 'raft.status'
            && event.kind !== 'observer.gap' && event.kind !== 'demo.request'
            && !event.kind.startsWith('fault.')).flatMap(event => {
            const at = Date.parse(event.at);
            if (!Number.isFinite(at) || !visible(at)) return [];
            const x = scale(at);
            const selected = event.id === selectedId;
            return event.nodes.flatMap(node => {
              const lane = laneIndex.get(node);
              if (lane === undefined) return [];
              return [<circle key={`${event.id}/${node}`}
                className={`swimlane-dot ${dotTone(event)}${selected ? ' selected' : ''}`}
                cx={x} cy={laneTop(lane) + LANE_HEIGHT - 5} r={selected ? 3.8 : 2.2}
                onClick={() => onSelect?.(event.id)}>
                <title>{node} · {event.label} · {format(at)}</title>
              </circle>];
            });
          })}
          {markers.map(marker => {
            const x = scale(marker.at);
            const gap = marker.kind === 'observer.gap';
            return <g key={marker.eventId} className="event-marker" onClick={() => onSelect?.(marker.eventId)}>
              <line className={gap ? 'gap-line' : 'partition-line'} x1={x} x2={x}
                y1={AXIS_HEIGHT - 6} y2={height - PAD} />
              <title>{marker.label} · {format(marker.at)}</title>
            </g>;
          })}
        </svg> : <p className="empty-state">正在测量泳道宽度…</p>}
    </div>
    <div className="swimlane-legend" aria-hidden="true">
      <span><i className="legend-role leader" />Leader</span>
      <span><i className="legend-role follower" />Follower</span>
      <span><i className="legend-role candidate" />Candidate</span>
      <span><i className="legend-rpc" />RPC 接受</span>
      <span><i className="legend-rpc rejected" />RPC 拒绝</span>
      <span><i className="legend-rpc unknown" />RPC 未确认</span>
      <span><i className="legend-fault" />终止 / 隔离</span>
      <span><i className="legend-gap" />采集缺口</span>
    </div>
  </section>;
}
