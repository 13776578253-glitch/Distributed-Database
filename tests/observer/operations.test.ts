/** Checks the operation allowlist and ownership of one project lease. */
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireProjectLock, ProjectBusy, readProjectLock } from '../../scripts/cluster-lock.ts';
import { parseOperation } from '../../scripts/operation-worker.ts';

it('shares one atomic lease per project and keeps a failed recovery guarded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'minidb-lock-'));
  try {
    const lease = acquireProjectLock('lab', 'experiment', directory);
    const other = acquireProjectLock('other', 'restart-node', directory);
    try {
      lease.setRun('run-from-evidence');
      expect(readProjectLock('lab', directory)).toMatchObject({ kind: 'experiment', runId: 'run-from-evidence' });
      expect(() => acquireProjectLock('lab', 'restart-node', directory)).toThrow(ProjectBusy);
    } finally {
      other.release();
      lease.release(true);
    }
    expect(readProjectLock('lab', directory)?.recoveryRequired).toBe(true);
    expect(() => acquireProjectLock('lab', 'experiment', directory)).toThrow(ProjectBusy);
    unlinkSync(join(directory, 'lab.lock'));
    const next = acquireProjectLock('lab', 'restart-node', directory);
    next.release();
    expect(readProjectLock('lab', directory)).toBeNull();
  } finally { rmdirSync(directory); }
});

it('accepts recorded experiment IDs and only configured node actions', () => {
  expect(parseOperation({ kind: 'experiment', experimentId: 'R02' })).toEqual({ kind: 'experiment', experimentId: 'R02' });
  expect(parseOperation({ kind: 'experiment', experimentId: 'R04' })).toBeUndefined();
  expect(parseOperation({ kind: 'restart-node', nodeId: 'raft-5' })).toEqual({ kind: 'restart-node', nodeId: 'raft-5' });
  expect(parseOperation({ kind: 'restart-node', nodeId: '--all' })).toBeUndefined();
  expect(parseOperation({ kind: 'shell', command: 'docker ps' })).toBeUndefined();
});
