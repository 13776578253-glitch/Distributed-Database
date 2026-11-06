/** Checks the timestamped, payload-free RPC projection used by the console. */
import { describe, expect, it } from 'vitest';
import { projectRpcReplies } from '../../src/observer/rpc-observation.ts';

const now = Date.parse('2026-11-06T12:00:10.000Z');
const members = ['raft-1', 'raft-2', 'raft-3'];

describe('recent RPC observation', () => {
  it('keeps the latest real response per direction and omits payloads', () => {
    const logs = [
      '2026-11-06T12:00:05.000000000Z {"kind":"raft.rpc","from":"raft-1","to":"raft-2","request":{"kind":"append","term":3},"reply":{"kind":"append","success":false}}',
      '2026-11-06T12:00:07.100000000Z {"kind":"raft.rpc","from":"raft-1","to":"raft-2","request":{"kind":"append","term":3,"entries":["payload"]},"reply":{"kind":"append","success":true}}',
      '2026-11-06T12:00:08.000000000Z {"kind":"raft.rpc","from":"raft-2","to":"raft-1","request":{"kind":"vote","term":4},"reply":{"kind":"vote","granted":false}}',
    ].join('\r\n');

    expect(projectRpcReplies(logs, members, now)).toEqual([
      { at: '2026-11-06T12:00:08.000000000Z', from: 'raft-2', to: 'raft-1', kind: 'vote', term: 4, accepted: false },
      { at: '2026-11-06T12:00:07.100000000Z', from: 'raft-1', to: 'raft-2', kind: 'append', term: 3, accepted: true },
    ]);
  });

  it('drops stale and future replies, foreign peers and malformed events', () => {
    const row = (at: string, to: string) => `${at} {"kind":"raft.rpc","from":"raft-1","to":"${to}","request":{"kind":"vote","term":4},"reply":{"kind":"vote","granted":true}}`;
    const logs = [
      row('2026-11-06T12:00:01Z', 'raft-2'),
      row('2026-11-06T12:00:11Z', 'raft-2'),
      row('2026-11-06T12:00:08Z', 'foreign'),
      '2026-11-06T12:00:08Z {"kind":"raft.rpc",}',
      '2026-11-06T12:00:08Z {"kind":"raft.role","nodeId":"raft-1","role":"leader"}',
    ].join('\n');

    expect(projectRpcReplies(logs, members, now)).toEqual([]);
  });
});
