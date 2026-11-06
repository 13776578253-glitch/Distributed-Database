/** Runs approved Compose mutations and owns their leases and Evidence. */
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConsoleOperation } from '../src/contracts/console.ts';
import type { ExperimentResult } from '../src/contracts/history.ts';
import { acquireProjectLock, ProjectBusy } from './cluster-lock.ts';
import { configuredTargets, readComposeConfig } from './console-cluster.ts';
import { docker, nodeIds } from './docker.ts';
import { openEvidence } from './evidence.ts';
import { electionLimitMs, runExperiment } from './run-experiment.ts';

export type WorkerMessage =
  | { kind: 'started'; runId: string }
  | { kind: 'recovering' }
  | { kind: 'finished'; verdict: ExperimentResult['status'] }
  | { kind: 'error'; busy: boolean; error: string };

export function parseOperation(input: unknown): ConsoleOperation | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  if (value.kind === 'experiment' && (value.experimentId === 'R01' || value.experimentId === 'R02' || value.experimentId === 'R03')) {
    return { kind: value.kind, experimentId: value.experimentId };
  }
  if (value.kind === 'restart-node' && typeof value.nodeId === 'string' && nodeIds.includes(value.nodeId)) {
    return { kind: value.kind, nodeId: value.nodeId };
  }
}

async function restartNode(nodeId: string, address: string, evidence: ReturnType<typeof openEvidence>, project: string) {
  const runDocker = (args: string[]) => docker(args, evidence.log);
  try {
    const before = runDocker(['compose', 'ps', '--all', '--quiet', nodeId]);
    evidence.assert('project member exists', Boolean(before), { nodeId, before });
    evidence.event('service.restart', { nodeId });
    runDocker(['compose', 'restart', nodeId]);
    const deadline = Date.now() + 12000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${address}/health`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        if (response.ok && health.nodeId === nodeId && health.mode === 'raft') { healthy = true; break; }
      } catch { /* 容器启动阶段端口尚未就绪。 */ }
      await sleep(250);
    }
    const after = runDocker(['compose', 'ps', '--quiet', nodeId]);
    evidence.assert('member restarted in place and HTTP is healthy', healthy && before === after, { nodeId, before, after, healthy });
    return evidence.finish('PASS', { project });
  } catch (error) {
    evidence.log(String(error));
    return evidence.finish('FAIL', { project });
  }
}

export async function performOperation(
  action: ConsoleOperation, report: (message: WorkerMessage) => void = () => {}, expectedProject?: string,
) {
  const config = readComposeConfig();
  if (expectedProject && expectedProject !== config.name) throw new Error('Compose 项目已变更，请重启控制台');
  const targets = configuredTargets(config);
  const image = config.services[nodeIds[0]]?.image;
  if (action.kind === 'experiment' && !image) throw new Error('Compose 缺少 Raft 镜像配置');
  const lease = acquireProjectLock(config.name, action.kind);
  let recoveryRequired = false;
  // 普通退出信号交由已进入故障流程的任务走完恢复与取证。
  const finishFirst = () => {};
  process.on('SIGINT', finishFirst);
  process.on('SIGTERM', finishFirst);
  try {
    const command = action.kind === 'experiment' ? `pnpm experiment ${action.experimentId}` : `docker compose restart ${action.nodeId}`;
    const evidence = openEvidence(action.kind === 'experiment' ? action.experimentId : 'SERVICE', command,
      { project: config.name, action, nodeIds, electionLimitMs, targets });
    lease.setRun(evidence.runId);
    report({ kind: 'started', runId: evidence.runId });
    const address = (id: string) => targets.find(target => target.nodeId === id)!.address;
    const recovering = () => report({ kind: 'recovering' });
    if (action.kind === 'restart-node') {
      recovering();
      return await restartNode(action.nodeId, address(action.nodeId), evidence, config.name);
    }
    return await runExperiment(action.experimentId, evidence, image!, address, recovering, () => { recoveryRequired = true; });
  } finally {
    process.off('SIGINT', finishFirst);
    process.off('SIGTERM', finishFirst);
    lease.release(recoveryRequired);
  }
}

if (import.meta.main) {
  const notify = (message: WorkerMessage) => {
    try {
      if (process.connected) process.send?.(message, undefined, undefined, () => {});
    } catch { /* 观测进程退出时，任务仍需完成恢复和取证。 */ }
  };
  try {
    const action = parseOperation(JSON.parse(process.argv[2] ?? 'null'));
    if (!action) throw new Error('操作不在允许列表');
    const result = await performOperation(action, notify, process.argv[3]);
    notify({ kind: 'finished', verdict: result.status });
    if (result.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    notify({ kind: 'error', busy: error instanceof ProjectBusy, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}
