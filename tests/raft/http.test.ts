import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpTransport } from '../../src/raft/adapters/http-transport.ts';
import { raftHttp } from '../../src/raft/api/http.ts';
import type { RaftNode } from '../../src/raft/core/node.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('answers malformed request targets with 400 and keeps serving health', async () => {
  const node = { status: () => ({ nodeId: 'a' }) } as RaftNode;
  const handler = raftHttp(node, [], new HttpTransport('a'), () => {}, false);
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const send = (url: string) => handler({ method: 'GET', url } as IncomingMessage,
    response as unknown as ServerResponse);
  await send('http://[bad]/');
  expect(response.writeHead).toHaveBeenLastCalledWith(400, expect.anything());
  expect(response.end).toHaveBeenLastCalledWith('{"error":"INVALID_URL"}');
  await send('/health');
  expect(response.writeHead).toHaveBeenLastCalledWith(200, expect.anything());
});

it('drops and reports invalid peer responses without discarding a valid reply', async () => {
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const good = { kind: 'vote', term: 3, granted: true };
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 502 }))
    .mockResolvedValueOnce(new Response('{'))
    .mockResolvedValueOnce(Response.json({ ...good, granted: 'yes' }))
    .mockResolvedValueOnce(Response.json(good)));
  const transport = new HttpTransport('a');
  const send = () => transport.send('b', { kind: 'vote', term: 3, lastLogIndex: 0, lastLogTerm: 0 });
  expect(await send()).toBeUndefined();
  expect(await send()).toBeUndefined();
  expect(await send()).toBeUndefined();
  expect(await send()).toEqual(good);
  expect(warnings).toHaveBeenCalledTimes(3);
});

it('labels explicit follower stale reads and uses only the local applied state', async () => {
  const node = {
    status: () => ({ nodeId: 'a', role: 'follower', leader: 'b' }),
    readLocal: vi.fn(() => ({ appliedIndex: 2, result: { found: true, value: 'old' } })),
  } as unknown as RaftNode;
  const handler = raftHttp(node, ['b'], new HttpTransport('a'), () => {}, false);
  const response = { writeHead: vi.fn(), end: vi.fn() };
  await handler({ method: 'GET', url: '/kv?key=k&consistency=stale' } as IncomingMessage,
    response as unknown as ServerResponse);
  expect(node.readLocal).toHaveBeenCalledWith('k');
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({
    ok: true, consistency: 'stale', nodeId: 'a', appliedIndex: 2, result: { found: true, value: 'old' },
  });
});

it('waits for local application of the safe read index before reading KV', async () => {
  let appliedIndex = 2;
  const readLocal = vi.fn(() => ({ appliedIndex, result: { found: true, value: 'new' } }));
  const node = {
    status: () => ({ nodeId: 'a', role: 'follower', leader: 'b', voter: true, lastApplied: appliedIndex }), readLocal,
  } as unknown as RaftNode;
  const transport = new HttpTransport('a');
  vi.spyOn(transport, 'requestReadIndex').mockResolvedValue({ ok: true, term: 3, readIndex: 5 });
  const handler = raftHttp(node, ['b'], transport, () => {}, false);
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const pending = handler({ method: 'GET', url: '/kv?key=k&consistency=safe-follower' } as IncomingMessage,
    response as unknown as ServerResponse);
  await Promise.resolve();
  expect(response.end).not.toHaveBeenCalled();
  expect(readLocal).not.toHaveBeenCalled();
  appliedIndex = 5;
  await pending;
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({
    ok: true, consistency: 'safe-follower', nodeId: 'a', term: 3, readIndex: 5,
    appliedIndex: 5, result: { found: true, value: 'new' },
  });
});

it('rejects a safe read when the read index RPC is blocked without reading the local value', async () => {
  const node = {
    status: () => ({ nodeId: 'a', role: 'follower', leader: 'b', voter: true, lastApplied: 9 }),
    readLocal: vi.fn(),
  } as unknown as RaftNode;
  const transport = new HttpTransport('a');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  transport.setBlocked(['b']);
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const handler = raftHttp(node, ['b'], transport, () => {}, false);
  const response = { writeHead: vi.fn(), end: vi.fn() };
  await handler({ method: 'GET', url: '/kv?key=k&consistency=safe-follower' } as IncomingMessage,
    response as unknown as ServerResponse);
  expect(response.writeHead).toHaveBeenLastCalledWith(503, expect.anything());
  expect(JSON.parse(response.end.mock.calls[0][0])).toMatchObject({ ok: false, error: 'NO_QUORUM' });
  expect(network).not.toHaveBeenCalled();
  expect(node.readLocal).not.toHaveBeenCalled();
});
