/** Launches web-requested workers and tracks their bounded local job history. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ConsoleOperation, OperationJob } from '../src/contracts/console.ts';
import { ProjectBusy, readProjectLock } from './cluster-lock.ts';
import type { WorkerMessage } from './operation-worker.ts';

const worker = fileURLToPath(new URL('./operation-worker.ts', import.meta.url));

export function operationJobs(project?: string) {
  const history: OperationJob[] = [];
  let pending = false;
  let active: OperationJob | undefined;
  return {
    list: () => history,
    busy: () => pending || Boolean(active),
    async start(action: ConsoleOperation): Promise<OperationJob> {
      if (!project) throw new Error('Compose 项目未就绪');
      if (pending || active || readProjectLock(project)) throw new ProjectBusy('当前项目已有操作执行或等待恢复');
      pending = true;
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(process.execPath, [worker, JSON.stringify(action), project], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
          });
        } catch (error) {
          pending = false;
          reject(error);
          return;
        }
        let job: OperationJob | undefined;
        let failure: Error | undefined;
        child.on('message', (message: WorkerMessage) => {
          if (message.kind === 'started') {
            job = { id: randomUUID(), action, runId: message.runId, startedAt: new Date().toISOString(), status: 'running' };
            active = job;
            pending = false;
            history.unshift(job);
            if (history.length > 20) history.pop();
            resolve(job);
          } else if (message.kind === 'recovering' && job) {
            job.phase = 'recovering';
          } else if (message.kind === 'finished' && job) {
            job.verdict = message.verdict;
          } else if (message.kind === 'error') {
            failure = message.busy ? new ProjectBusy(message.error) : new Error(message.error);
          }
        });
        child.on('error', error => { failure = error; });
        child.once('close', code => {
          pending = false;
          active = undefined;
          if (!job) { reject(failure ?? new Error(`操作进程退出 (${code})`)); return; }
          job.status = code === 0 && job.verdict && job.verdict !== 'FAIL' ? 'succeeded' : 'failed';
          delete job.phase;
          if (job.status === 'failed') job.error = failure?.message
            ?? (job.verdict === 'FAIL' ? '实验或服务检查失败，已保存 Evidence' : '操作中断，检查项目锁和集群状态');
        });
      });
    },
  };
}
