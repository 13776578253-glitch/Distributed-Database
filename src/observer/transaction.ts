/**
 * Resolves one local transaction Compose service and proxies its read-only HTTP
 * observations. The published host port is discovered per concurrent batch;
 * the next request rediscovers it, so container recreation is observable.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const paths = {
  status: '/txn/status',
  wal: '/internal/txn/wal',
  recovery: '/internal/txn/recovery',
  'as-of': '/txn/as-of',
} as const;

export function transactionReader(project = process.env.CONSOLE_TXN_PROJECT ?? 'minidb-txn') {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid CONSOLE_TXN_PROJECT');

  /** 只接受 Docker 发布的本地 TCP 端口；容器重建后端口可能变化。 */
  async function address() {
    const { stdout } = await exec('docker', ['compose', '-f', 'compose.transaction.yaml', '-p', project,
      'port', 'transaction', '8080'], { encoding: 'utf8', timeout: 1800, maxBuffer: 16 * 1024, windowsHide: true });
    const match = /^127\.0\.0\.1:(\d+)$/.exec(stdout.trim());
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('Invalid transaction listener');
    return 'http://' + match[0];
  }

  let discovery: Promise<string> | undefined;
  return async (query: keyof typeof paths, params = new URLSearchParams()) => {
    const key = params.get('key');
    const lsn = params.get('lsn');
    // AS OF 的 LSN 必须是完整非负整数；键保留原文。
    if (query === 'as-of' && (!key || !lsn || !/^\d+$/.test(lsn)
      || !Number.isSafeInteger(Number(lsn)))) {
      return { status: 400, data: { error: '请输入有效的键和非负整数 LSN' } };
    }

    try {
      // 并发读取共享端口发现；settle 后清空，下一轮重新解析。
      discovery ??= address().finally(() => { discovery = undefined; });
      const url = new URL(paths[query], await discovery);
      if (query === 'as-of') url.search = new URLSearchParams({ key: key!, lsn: lsn! }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(1800), redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        if (query === 'as-of' && response.status === 400) {
          return { status: 400, data: { error: 'LSN 超出事务服务的 WAL 范围' } };
        }
        return { status: 502, data: { error: '事务服务返回 HTTP ' + response.status } };
      }
      return { status: 200, data: await response.json() };
    } catch {
      return { status: 503, data: { error: '事务服务不可达 · ' + project } };
    }
  };
}
