/** Exposes transaction operations and read-only storage observations over HTTP. */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isOperation } from '../../contracts/history.ts';
import type { openTransaction } from '../storage/durable.ts';
import { faultPoints } from '../storage/wal.ts';
import type { FaultPoint } from '../storage/wal.ts';

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // 对端提交的 JSON 无法解析，由 HTTP 层统一返回参数错误。
  }
  throw new Error('INVALID_REQUEST');
}

export function transactionServer(
  { engine, wal, data, recovery, checkpoint }: ReturnType<typeof openTransaction>,
  armFault?: (point: FaultPoint) => void,
) {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET') {
      if (path === '/health') return send(res, 200, { ok: true });
      if (path === '/txn/status') {
        return send(res, 200, { ...engine.status(), ...data.counts(), appliedLsn: data.appliedLsn(), lastLsn: wal.records().length });
      }
      if (path === '/internal/txn/wal') return send(res, 200, wal.records());
      if (path === '/internal/txn/recovery') return send(res, 200, recovery);
      if (path === '/txn/as-of') {
        const key = url.searchParams.get('key');
        const lsn = url.searchParams.get('lsn');
        if (!key || !lsn || !/^\d+$/.test(lsn)) throw new Error('INVALID_REQUEST');
        return send(res, 200, engine.asOf(key, wal.commitSeqAt(Number(lsn))));
      }
    }
    if (req.method === 'POST') {
      if (path === '/txn/begin') {
        const { isolation, lock } = await json(req);
        if ((isolation !== 'RC' && isolation !== 'SI') || (lock !== undefined && (typeof lock !== 'string' || !lock))) {
          throw new Error('INVALID_REQUEST');
        }
        const reply = engine.begin(isolation, lock);
        return send(res, reply.ok ? 200 : 409, reply);
      }
      if (path === '/internal/txn/checkpoint') return send(res, 200, checkpoint());
      if (path === '/internal/txn/fault' && armFault) {
        const { point } = await json(req);
        const selected = faultPoints.find(candidate => candidate === point);
        if (!selected) throw new Error('INVALID_REQUEST');
        armFault(selected);
        return send(res, 200, { point: selected });
      }

      const route = /^\/txn\/(txn-\d+)\/(read|put|delete|commit|abort)$/.exec(path);
      if (route) {
        const [, txnId, action] = route;
        if (action === 'commit') {
          const reply = engine.commit(txnId);
          return send(res, reply.ok ? 200 : 409, reply);
        }
        if (action === 'abort') return send(res, 200, { ok: true, history: engine.abort(txnId) });
        const body = await json(req);
        const operation = { ...body, type: action === 'read' ? 'get' : action };
        if (!isOperation(operation)) throw new Error('INVALID_REQUEST');
        if (operation.type === 'get') return send(res, 200, engine.read(txnId, operation.key));
        if (operation.type === 'put') engine.put(txnId, operation.key, operation.value);
        else engine.delete(txnId, operation.key);
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  }

  return createServer((req, res) => {
    void handle(req, res).catch((error: Error) => {
      if (error.message === 'TXN_NOT_ACTIVE') return send(res, 409, { error: error.message });
      if (error.message === 'INVALID_REQUEST' || error.message === 'INVALID_LSN') {
        if (!res.destroyed) send(res, 400, { error: error.message });
        return;
      }
      // 持久化异常后立即结束服务，避免其他请求越过未完成的落盘动作。
      console.error(error);
      process.exit(1);
    });
  });
}
