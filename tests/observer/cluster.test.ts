/** Checks independent probes, shared sampling and recovery without Docker. */
import { describe, expect, it, vi } from 'vitest';
import { nodeIds } from '../../src/raft/config.ts';
import type { RaftStatus } from '../../src/contracts/observation.ts';
import { clusterReader } from '../../src/observer/cluster.ts';

const targets = nodeIds.map((nodeId, index) => ({ nodeId, address: `http://127.0.0.1:${18081 + index}` }));

function status(nodeId: string, term = 2): RaftStatus {
  return {
    nodeId, term, leader: 'raft-1', role: nodeId === 'raft-1' ? 'leader' : 'follower',
    logLength: 12, commitIndex: 10, lastApplied: 9, ready: nodeId === 'raft-1', committedDigest: 'a'.repeat(64),
  };
}

describe('cluster observation', () => {
  it('reports five independent results and samples recovered nodes on the next request', async () => {
    let recovered = false;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const index = Number(new URL(String(input)).port) - 18081;
      const nodeId = nodeIds[index];
      if (recovered || index === 0) return Response.json(status(nodeId, recovered ? 3 : 2));
      if (index === 1) {
        // 模拟响应头到达后正文挂起，检查单节点超时覆盖整个读取。
        return new Response(new ReadableStream({
          start(controller) {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        }));
      }
      if (index === 2) return new Response('unavailable', { status: 503 });
      if (index === 3) return Response.json(status('wrong-node'));
      throw new TypeError('connection refused');
    });
    const read = clusterReader(targets, { timeoutMs: 50, request });

    const first = read();
    expect(read()).toBe(first);
    expect(request).toHaveBeenCalledTimes(5);
    const initial = await first;
    expect(initial.nodes).toMatchObject([
      { nodeId: 'raft-1', ok: true, status: status('raft-1') },
      { nodeId: 'raft-2', ok: false, reason: 'timeout' },
      { nodeId: 'raft-3', ok: false, reason: 'http', httpStatus: 503 },
      { nodeId: 'raft-4', ok: false, reason: 'invalid-response' },
      { nodeId: 'raft-5', ok: false, reason: 'unreachable' },
    ]);

    recovered = true;
    const next = await read();
    expect(request).toHaveBeenCalledTimes(10);
    expect(next.nodes).toMatchObject(nodeIds.map(nodeId => ({ nodeId, ok: true, status: status(nodeId, 3) })));
  });
});
