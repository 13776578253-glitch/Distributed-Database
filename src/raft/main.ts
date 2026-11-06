import { createServer } from 'node:http';

const nodeId = process.env.NODE_ID;
if (!nodeId) throw new Error('NODE_ID is required');

createServer((request, response) => {
  const isHealth = request.method === 'GET' && request.url === '/health';
  response.writeHead(isHealth ? 200 : 404, { 'content-type': 'application/json' });
  response.end(JSON.stringify(isHealth
    ? { nodeId, mode: 'scaffold-smoke' }
    : { error: 'NOT_FOUND' }));
}).listen(8080);

console.log(`${nodeId} listening on 8080 (scaffold-smoke)`);
