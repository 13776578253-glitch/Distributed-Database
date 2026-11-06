/** Cross-process lease for operations that change one Compose project. */
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectLock } from '../src/contracts/console.ts';

const directory = '.scratch/cluster-operations';

function lockPath(project: string, root: string) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid Compose project name');
  return join(root, `${project}.lock`);
}

export class ProjectBusy extends Error {}

export function readProjectLock(project: string, root = directory): ProjectLock | null {
  const path = lockPath(project, root);
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as ProjectLock | null;
    return record?.kind ? record : { kind: 'unknown' };
  } catch (error) {
    // 建立或更新记录时也视为占用，避免半写入被当成空闲。
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { kind: 'unknown' };
  }
}

export function acquireProjectLock(project: string, kind: ProjectLock['kind'], root = directory) {
  const path = lockPath(project, root);
  mkdirSync(root, { recursive: true });
  let fd: number;
  try { fd = openSync(path, 'wx'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectBusy(`Compose 项目 ${project} 已有操作执行或等待恢复`);
    throw error;
  }
  const record: ProjectLock = { kind, pid: process.pid, startedAt: new Date().toISOString() };
  let released = false;
  function release(retainForRecovery = false) {
    if (released) return;
    released = true;
    if (retainForRecovery) {
      record.recoveryRequired = true;
      try { write(); } finally { closeSync(fd); }
      return;
    }
    closeSync(fd);
    unlinkSync(path);
  }
  function write() {
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify(record), 0, 'utf8');
  }
  try { write(); } catch (error) { release(); throw error; }
  return { release, setRun(runId: string) { record.runId = runId; write(); } };
}
