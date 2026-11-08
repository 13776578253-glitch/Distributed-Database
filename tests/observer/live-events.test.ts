/** Checks bounded live replay, overlap deduplication and container changes. */
import { expect, it } from 'vitest';
import { liveEvents } from '../../src/observer/live-events.ts';

it('publishes a gap when log reads fail and recovers', async () => {
  let now = Date.parse('2026-11-06T10:00:00.000Z');
  let fail = true;
  const row = `${new Date(now).toISOString()} {"kind":"raft.role","nodeId":"raft-1","role":"follower","term":3}`;
  const feed = liveEvents(['raft-1'], {
    now: () => now,
    read: async () => {
      if (fail) throw new Error('docker logs unavailable');
      return { logs: row, containers: 'stable' };
    },
  });
  await feed.refresh();
  expect(feed.status().available).toBe(false);
  expect(feed.replay().entries.at(-1)?.kind).toBe('observer.gap');

  fail = false;
  now += 1000;
  await feed.refresh();
  expect(feed.status().available).toBe(true);
  expect(feed.replay().entries.some(entry => entry.kind === 'raft.role')).toBe(true);
  feed.close();
});

it('deduplicates overlapping windows and identifies stale replay cursors', async () => {
  let now = Date.parse('2026-11-06T10:00:00.000Z');
  const row = (nodeId: string) => `${new Date(now).toISOString()} {"kind":"raft.role","nodeId":"${nodeId}","role":"follower","term":3}`;
  let logs = row('raft-1');
  let containers = 'first';
  const feed = liveEvents(['raft-1', 'raft-2'], { capacity: 2, now: () => now, read: async () => ({ logs, containers }) });
  await feed.refresh();
  const first = feed.replay().entries[0].id;
  now += 1000;
  logs += '\n' + row('raft-2');
  await feed.refresh();
  expect(feed.replay(first).entries.map(event => event.nodes)).toEqual([['raft-2']]);
  now += 1000;
  containers = 'replacement';
  await feed.refresh();
  expect(feed.replay(first)).toMatchObject({ gap: true, entries: [{ kind: 'raft.role' }, { kind: 'observer.gap' }] });
  feed.close();
});
