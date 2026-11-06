/** Builds and serves the local console and its same-origin observation API. */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { clusterReader } from '../src/observer/cluster.ts';
import { readRpcReplies } from '../src/observer/rpc-observation.ts';
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
const readCluster = clusterReader(cluster.targets, {
  startupWarning: cluster.warning,
  readRpc: () => readRpcReplies(cluster.targets.map(target => target.nodeId)),
});

server.on('request', async (request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' }).end();
    return;
  }
  const path = request.url?.split('?', 1)[0] ?? '/';
  if (path === '/api/cluster') {
    const snapshot = await readCluster();
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }).end(JSON.stringify(snapshot));
    return;
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
