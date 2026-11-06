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
import { prepareConsoleCluster } from './console-cluster.ts';

const host = '127.0.0.1';
const port = Number(process.env.CONSOLE_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONSOLE_PORT');

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
const server = createServer();
server.listen(port, host);
await once(server, 'listening');
const cluster = prepareConsoleCluster();
const events = liveEvents(cluster.targets.map(target => target.nodeId));
const evidence = evidenceReader();
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
  if (request.headers.host !== `${host}:${port}` && request.headers.host !== `localhost:${port}`) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' }).end();
    return;
  }
  const path = request.url?.split('?', 1)[0] ?? '/';
  try {
    if (path === '/api/cluster') return json(response, 200, await readCluster());
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
if (cluster.warning) console.warn(`Compose: ${cluster.warning}`);
console.log(`Raft Console (${cluster.mode}): http://${host}:${port}`);
