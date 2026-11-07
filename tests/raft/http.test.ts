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
