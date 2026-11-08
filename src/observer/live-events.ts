/**
 * Shared Compose log reader with bounded replay history and SSE subscribers.
 * Events are projected from overlapping log windows, deduplicated by full-line
 * occurrence, and emitted with an explicit gap when the window is incomplete.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import type { TimelineEvent } from '../contracts/console.ts';
import { projectRpcReplies } from './rpc-observation.ts';
import { containerEvent } from './timeline.ts';

const exec = promisify(execFile);
/** Docker 日志窗口；两次采样间隔超过它会显式报缺口。 */
const windowMs = 8000;

export function liveEvents(members: readonly string[], {
  capacity = 400,
  now = Date.now,
  membershipLab = false,
  read = async () => {
    const options = { encoding: 'utf8' as const, timeout: 1200, maxBuffer: 512 * 1024, windowsHide: true };
    const compose = membershipLab ? ['compose', '--profile', 'membership'] : ['compose'];
    const [logs, containers] = await Promise.all([
      exec('docker', [...compose, 'logs', '--timestamps', '--no-log-prefix', '--no-color', '--since', '8s', ...members], options),
      exec('docker', [...compose, 'ps', '--all', '--quiet', ...members], options),
    ]);
    return { logs: logs.stdout, containers: containers.stdout.trim().split(/\s+/).sort().join(' ') };
  },
} = {}) {
  const membersSet = new Set(members);
  const epoch = randomUUID();
  const history: TimelineEvent[] = [];
  const clients = new Set<ServerResponse>();
  /** 上一次日志窗口里每条完整日志行出现的次数，用于跨窗口去重。 */
  let seen = new Map<string, number>();
  let sequence = 0;
  let sampledAt = -Infinity;
  let containers: string | undefined;
  let available: boolean | undefined;
  let logs = '';
  let inFlight: Promise<void> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const frame = (event: TimelineEvent) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;

  function publish(event: Omit<TimelineEvent, 'id'>) {
    const entry = { ...event, id: `${epoch}:${++sequence}` };
    history.push(entry);
    if (history.length > capacity) history.shift();
    // 慢客户端断开，但不阻塞其他订阅者或历史缓存。
    for (const response of clients) {
      if (response.writableLength > 512 * 1024) response.destroy();
      else response.write(frame(entry));
    }
  }

  function gap(reason: string) {
    publish({ at: new Date(now()).toISOString(), kind: 'observer.gap', label: reason, nodes: [], raw: { reason } });
  }

  function refresh() {
    // 800ms 节流避免日志命令和轮询同时堆积；并发调用共享同一个 Promise。
    if (closed || now() - sampledAt < 800) return Promise.resolve();
    inFlight ??= read().then(snapshot => {
      if (closed) return;
      const current = now();
      // 容器集合变化或采样间隔超过 Docker 窗口都可能漏行，先记录缺口。
      if (containers !== undefined && containers !== snapshot.containers) gap('Compose 容器集合变化，日志窗口可能有缺口');
      else if (Number.isFinite(sampledAt) && current - sampledAt > windowMs) gap('两次采样间隔超过日志窗口');
      containers = snapshot.containers;
      const next = new Map<string, number>();
      const additions: Omit<TimelineEvent, 'id'>[] = [];
      let skipped = false;
      for (const line of snapshot.logs.split(/\r?\n/)) {
        const parsed = containerEvent(line);
        if (!parsed || !membersSet.has(parsed.event.nodes[0])) continue;
        if (Buffer.byteLength(line) > 16 * 1024) { skipped = true; continue; }
        // 同一个 8 秒窗口来回重叠时，只发布新出现的那一次完整行。
        const occurrence = (next.get(line) ?? 0) + 1;
        next.set(line, occurrence);
        if (occurrence > (seen.get(line) ?? 0)) additions.push(parsed.event);
      }
      if (skipped) gap('部分日志超过单条事件大小上限');
      additions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).forEach(publish);
      seen = next;
      logs = snapshot.logs;
      available = true;
      sampledAt = current;
    }).catch(() => {
      if (closed) return;
      // 连续失败只发一次缺口；恢复后由下一次成功采样继续。
      if (available !== false) gap('Compose 日志读取中断，正在重试');
      available = false;
      sampledAt = now();
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  /** 有游标时补发其后的事件；游标已被容量淘汰则重发当前缓存并报缺口。 */
  function replay(cursor?: string) {
    if (!cursor) return { entries: [...history], gap: false };
    const index = history.findIndex(event => event.id === cursor);
    return index === -1 ? { entries: [...history], gap: true } : { entries: history.slice(index + 1), gap: false };
  }

  function stopTimers() {
    clearInterval(ticker);
    clearInterval(heartbeat);
    ticker = heartbeat = undefined;
  }

  /** SSE 订阅上限 12；首个订阅者启用采样/心跳，最后一个离开时停止。 */
  function subscribe(response: ServerResponse, cursor?: string) {
    if (closed || clients.size >= 12) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    response.on('close', () => {
      clients.delete(response);
      if (clients.size === 0) stopTimers();
    });
    clients.add(response);
    const buffered = replay(cursor);
    response.write('retry: 1000\n\n');
    if (buffered.gap) response.write('event: gap\nid:\ndata: {"reason":"上次事件游标已失效，已重新读取当前缓存"}\n\n');
    for (const entry of buffered.entries) response.write(frame(entry));
    if (!ticker) {
      ticker = setInterval(() => { void refresh(); }, 1000).unref();
      heartbeat = setInterval(() => {
        for (const client of clients) {
          if (client.writableLength > 512 * 1024) client.destroy();
          else client.write(': heartbeat\n\n');
        }
      }, 15000).unref();
    }
    void refresh();
  }

  return {
    subscribe, refresh, replay,
    publish: (event: Omit<TimelineEvent, 'id'>) => publish(event),
    status: () => ({ available: available ?? null, subscribers: clients.size }),
    async recentRpc() {
      await refresh();
      return available ? projectRpcReplies(logs, members, now()) : null;
    },
    close() {
      closed = true;
      stopTimers();
      for (const response of clients) response.end();
      clients.clear();
    },
  };
}
