/** Builds and serves the local console and its same-origin observation API. */
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { clusterReader } from '../src/observer/cluster.ts';
import { evidenceReader } from '../src/observer/evidence.ts';
import { liveEvents } from '../src/observer/live-events.ts';
import { transactionReader } from '../src/observer/transaction.ts';
import { createWorkload, parseWorkloadAction } from '../src/observer/workload.ts';
import { acquireProjectLock, ProjectBusy, readProjectLock } from './cluster-lock.ts';
import { prepareConsoleCluster } from './console-cluster.ts';
import { composeServices } from './console-services.ts';
import { membershipLab } from './docker.ts';
import { operationJobs } from './operation-jobs.ts';
import { parseOperation } from './operation-worker.ts';

const host = '127.0.0.1';
const port = Number(process.env.CONSOLE_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONSOLE_PORT');
const readTransaction = transactionReader();

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const assets = new Map<string, { type: string; body: string | Buffer }>();
const bundle = await build({
  configFile: fileURLToPath(new URL('../web/vite.config.ts', import.meta.url)),
  build: { write: false },
});
for (const result of Array.isArray(bundle) ? bundle : [bundle]) {
  if (!('output' in result)) throw new Error('Expected a console build, received a watcher');
  for (const asset of result.output) {
    const type = mimeTypes[extname(asset.fileName)];
    if (!type) throw new Error(`Unsupported console asset: ${asset.fileName}`);
    const body = asset.type === 'chunk' ? asset.code : asset.source;
    const path = asset.fileName === 'index.html' ? '/' : `/${asset.fileName}`;
    assets.set(path, { type, body: typeof body === 'string' ? body : Buffer.from(body) });
  }
}

// 先占用监听端口，端口冲突时不启动或更改 Compose 集群。
const server = createServer({ requestTimeout: 10000 });
server.listen(port, host);
await once(server, 'listening');
const cluster = prepareConsoleCluster(undefined, { initialize: !process.argv.includes('--attach-only') });
const events = liveEvents(cluster.targets.map(target => target.nodeId), { membershipLab });
const evidence = evidenceReader();
const jobs = operationJobs(cluster.project);
const workload = createWorkload({
  targets: cluster.targets,
  readStatuses: clusterReader(cluster.targets, { timeoutMs: 1000 }),
  publish: event => events.publish(event),
  shouldPause: () => jobs.busy() || Boolean(cluster.project && readProjectLock(cluster.project)),
});
const listener = `http://${host}:${port}`;
const hosts = new Set([new URL(listener).host, new URL(`http://localhost:${port}`).host, `${host}:${port}`, `localhost:${port}`]);
let closing = false;
let restartLease: ReturnType<typeof acquireProjectLock> | undefined;
const readCluster = clusterReader(cluster.targets, {
  startupWarning: cluster.warning,
  readRpc: events.recentRpc,
});

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  }).end(JSON.stringify(data));
}

server.on('request', async (request, response) => {
  const authority = request.headers.host ?? '';
  if (!hosts.has(authority)) {
    response.writeHead(403).end();
    return;
  }
  const path = request.url?.split('?', 1)[0] ?? '/';
  if (request.method === 'POST' && (path === '/api/operations' || path === '/api/services/restart-observer' || path === '/api/workload')) {
    if (request.headers.origin !== new URL(`http://${authority}`).origin) return json(response, 403, { error: '仅接受同源控制台请求' });
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: '需要 JSON 请求' });
    if (closing) return json(response, 409, { error: '观测服务正在重启' });
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) return json(response, 413, { error: '请求体过大' });
      }
      const input: unknown = JSON.parse(body);
      if (path === '/api/operations') {
        const action = parseOperation(input);
        if (!action) return json(response, 400, { error: '操作不在允许列表' });
        return json(response, 202, await jobs.start(action));
      }
      if (path === '/api/workload') {
        const action = parseWorkloadAction(input);
        if (!action) return json(response, 400, { error: '负载参数无效' });
        if (action.action === 'start' && workload.status().paused) {
          return json(response, 409, { error: '实验期间暂停演示负载' });
        }
        return json(response, 200, action.action === 'start' ? workload.start(action.rate) : workload.stop());
      }
      if (!process.connected) return json(response, 409, { error: '当前观测进程未由启动器托管' });
      if (jobs.busy()) throw new ProjectBusy('项目有操作正在执行');
      restartLease = cluster.project ? acquireProjectLock(cluster.project, 'observer-restart') : undefined;
      closing = true;
      response.once('finish', () => shutdown(75));
      response.once('close', () => shutdown(75));
      return json(response, 202, { status: 'restarting' });
    } catch (error) {
      const status = error instanceof ProjectBusy ? 409 : error instanceof SyntaxError ? 400 : 503;
      return json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' }).end();
    return;
  }
  try {
    if (path === '/api/cluster') return json(response, 200, await readCluster());
    if (path === '/api/workload') return json(response, 200, workload.status());
    const transaction = /^\/api\/transaction\/(status|wal|recovery|as-of)$/.exec(path)?.[1];
    if (transaction === 'status' || transaction === 'wal' || transaction === 'recovery' || transaction === 'as-of') {
      const sample = await readTransaction(transaction, new URLSearchParams(request.url?.slice(path.length + 1)));
      return json(response, sample.status, sample.data);
    }
    if (path === '/api/operations') return json(response, 200, {
      project: cluster.project, membershipLab, jobs: jobs.list(),
      lock: cluster.project ? readProjectLock(cluster.project) : null,
    });
    if (path === '/api/services') return json(response, 200, {
      listener, pid: process.pid, project: cluster.project,
      ...(await composeServices()), logs: events.status(),
      lock: cluster.project ? readProjectLock(cluster.project) : null,
    });
    if (path === '/api/events/stream') {
      const cursor = request.headers['last-event-id'];
      events.subscribe(response, typeof cursor === 'string' ? cursor : undefined);
      return;
    }
    if (path === '/api/runs') return json(response, 200, await evidence.list());
    const run = /^\/api\/runs\/([^/]+)\/([^/]+)(?:\/files\/([^/]+))?$/.exec(path);
    if (run) {
      const [, experimentId, runId, name] = run;
      if (name) {
        const target = await evidence.file(experimentId, runId, name);
        if (!target) return json(response, 404, { error: 'Evidence 文件不存在' });
        const input = createReadStream(target.path);
        input.on('error', () => response.destroy());
        response.on('close', () => input.destroy());
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
        });
        input.pipe(response);
        return;
      }
      const detail = await evidence.detail(experimentId, runId);
      return detail ? json(response, 200, detail) : json(response, 404, { error: '实验记录不存在' });
    }
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
  const asset = assets.get(path);
  if (asset) {
    response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' }).end(asset.body);
    return;
  }
  response.writeHead(404).end();
});
let draining = false;
function shutdown(code: number) {
  if (draining) return;
  draining = closing = true;
  workload.close();
  events.close();
  server.close(() => {
    restartLease?.release();
    process.exit(code);
  });
  setTimeout(() => server.closeAllConnections(), 1000).unref();
}
process.on('message', message => { if (message === 'stop') shutdown(0); });
process.on('disconnect', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
if (cluster.warning) console.warn(`Compose: ${cluster.warning}`);
console.log(`Raft Console (${cluster.mode}): ${listener}`);
