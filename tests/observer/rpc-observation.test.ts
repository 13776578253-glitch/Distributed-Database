/** Checks the timestamped, payload-free RPC projection used by the console. */
import { describe, expect, it } from 'vitest';
import { projectRpcReplies } from '../../src/observer/rpc-observation.ts';
import { containerEvent } from '../../src/observer/timeline.ts';

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

  it('retains the actual snapshot boundary and follower read index', () => {
    const snapshot = '2026-11-06T12:00:08Z {"kind":"raft.rpc","from":"raft-1","to":"raft-2","request":{"kind":"snapshot","term":4,"lastIncludedIndex":18},"reply":{"kind":"snapshot","success":true}}';
    const read = '2026-11-06T12:00:09Z {"kind":"raft.read-index","from":"raft-3","to":"raft-1","reply":{"ok":true,"term":4,"readIndex":21}}';
    expect(containerEvent(snapshot)?.event).toMatchObject({ kind: 'snapshot', term: 4, indexSamples: [18] });
    expect(containerEvent(read)?.event).toMatchObject({ kind: 'read-index', term: 4, indexSamples: [21] });
    expect(projectRpcReplies(snapshot + '\n' + read, members, now).map(rpc => rpc.kind)).toEqual(['read-index', 'snapshot']);
  });

  it('extracts append entry identities and surfaces transport errors', () => {
    const append = '2026-11-06T12:00:08Z {"kind":"raft.rpc","from":"raft-1","to":"raft-2","request":{"kind":"append","term":4,"prevLogIndex":28,"entries":[{"term":4,"command":{"type":"put","key":"demo/s/k1","value":7}},{"term":4,"command":{"type":"delete","key":"demo/s/k2"}}]},"reply":{"kind":"append","success":true}}';
    const error = '2026-11-06T12:00:09Z {"kind":"raft.rpc.error","from":"raft-1","to":"raft-2","rpc":"append","reason":"timeout"}';

    expect(containerEvent(append)?.event).toMatchObject({
      kind: 'append',
      indexes: [29, 30],
      label: 'AppendEntries · demo/s/k1 +1 · 接受',
      entries: [
        { index: 29, key: 'demo/s/k1', value: 7, type: 'put' },
        { index: 30, key: 'demo/s/k2', type: 'delete' },
      ],
    });
    expect(containerEvent(error)?.event).toMatchObject({
      kind: 'rpc.error',
      nodes: ['raft-1', 'raft-2'],
      label: 'AppendEntries 失败 · timeout',
    });
  });
});
