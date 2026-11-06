/** Runs the original Raft experiments inside an acquired project lease. */
import type { RunnableExperiment } from '../src/contracts/console.ts';
import { docker, nodeIds } from './docker.ts';
import type { openEvidence } from './evidence.ts';
import { raftClient } from './raft-client.ts';

export const electionLimitMs = 8000;

export async function runExperiment(
  id: RunnableExperiment, evidence: ReturnType<typeof openEvidence>,
  image: string, resolveAddress: (nodeId: string) => string,
  recovering: () => void, keepRecoveryLock: () => void,
) {
  const client = raftClient(evidence, resolveAddress);
  const runDocker = (args: string[]) => docker(args, evidence.log);
  const key = `${id}/${evidence.runId}`;
  let imageId: string | undefined;
  let recoveryRequired = false;
  function markRecoveryRequired() {
    recoveryRequired = true;
    keepRecoveryLock();
  }

  async function assertValue(nodeId: string, name: string, expected: string, readKey = key) {
    const read = await client.call(nodeId, 'reader', { type: 'get', key: readKey });
    evidence.assert(name, read.outcome === 'ok' && read.result !== undefined
      && 'found' in read.result && read.result.found && read.result.value === expected, read);
  }

  async function killLeader() {
    const leader = await client.leader();
    for (const value of ['previous', 'confirmed']) {
      const write = await client.call(leader.nodeId, 'writer', { type: 'put', key, value });
      evidence.assert(`put ${value}`, write.outcome === 'ok', write);
    }

    const container = runDocker(['compose', 'ps', '-q', leader.nodeId]);
    const started = performance.now();
    evidence.event('fault.kill', { nodeId: leader.nodeId, signal: 'SIGKILL' });
    try {
      runDocker(['compose', 'kill', '-s', 'SIGKILL', leader.nodeId]);
      const exit = runDocker(['inspect', container, '--format', '{{.State.ExitCode}}']);
      evidence.assert('killed by SIGKILL', exit === '137', { exit });
      const next = await client.leader(nodeIds.filter(nodeId => nodeId !== leader.nodeId));
      const elapsedMs = performance.now() - started;
      evidence.assert('new leader elected', next.term > leader.term && elapsedMs <= electionLimitMs,
        { previous: leader.nodeId, next: next.nodeId, previousTerm: leader.term, term: next.term, elapsedMs });
      await assertValue(next.nodeId, 'quorum read returns the latest confirmed write', 'confirmed');
    } finally {
      recovering();
      try { evidence.event('fault.restart', { nodeId: leader.nodeId }); }
      finally {
        try { runDocker(['compose', 'start', leader.nodeId]); }
        catch (error) { markRecoveryRequired(); throw error; }
      }
    }
    const nodes = await client.converged();
    evidence.assert('restarted node converges', nodes.some(node => node.nodeId === leader.nodeId), nodes);
  }

  async function partition() {
    const leader = await client.leader();
    const minority = [leader.nodeId, nodeIds.find(nodeId => nodeId !== leader.nodeId)!];
    const majority = nodeIds.filter(nodeId => !minority.includes(nodeId));
    const minorityKey = `${key}/minority`;
    evidence.event('fault.partition', { minority, majority, layer: 'application-rpc' });

    try {
      for (const nodeId of nodeIds) {
        await client.block(nodeId, minority.includes(nodeId) ? majority : minority);
      }
      const [minorityWrite, minorityRead] = await Promise.all([
        client.call(leader.nodeId, 'minority-writer', { type: 'put', key: minorityKey, value: 'isolated' }),
        client.call(leader.nodeId, 'minority-reader', { type: 'get', key: minorityKey }),
      ]);

      const next = await client.leader(majority);
      evidence.assert('majority elected a higher-term leader', next.term > leader.term,
        { previousTerm: leader.term, term: next.term, leader: next.nodeId });
      const write = await client.call(next.nodeId, 'majority-writer', { type: 'put', key, value: 'majority' });
      evidence.assert('majority confirms a write', write.outcome === 'ok', write);
      await assertValue(next.nodeId, 'majority serves a quorum read', 'majority');
      evidence.assert('minority cannot confirm the proposed write',
        minorityWrite.outcome === 'unknown' && minorityWrite.errorCode === 'UNKNOWN_OUTCOME', minorityWrite);
      evidence.assert('minority refuses the read without quorum',
        minorityRead.outcome === 'rejected' && minorityRead.errorCode === 'NO_QUORUM', minorityRead);
    } finally {
      recovering();
      const restores = await Promise.allSettled(nodeIds.map(nodeId => client.block(nodeId, [])));
      const errors = restores.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) {
        markRecoveryRequired();
        throw new AggregateError(errors, 'restoring RPC links failed');
      }
    }

    const nodes = await client.converged();
    evidence.assert('all five committed prefixes match', nodes.length === 5, nodes);
    const next = nodes.find(node => node.ready)!;
    await assertValue(next.nodeId, 'majority write survives healing', 'majority');
    const read = await client.call(next.nodeId, 'reader', { type: 'get', key: minorityKey });
    evidence.assert('conflicting minority proposal is absent',
      read.outcome === 'ok' && read.result !== undefined && 'found' in read.result && !read.result.found, read);
  }

  async function captureHistory() {
    const leader = await client.leader();
    const [a, b] = await Promise.all([
      (async () => [
        await client.call(leader.nodeId, 'a', { type: 'put', key, value: 'a' }),
        await client.call(leader.nodeId, 'a', { type: 'get', key }),
        await client.call(leader.nodeId, 'a', { type: 'delete', key }),
      ])(),
      (async () => [
        await client.call(leader.nodeId, 'b', { type: 'get', key }),
        await client.call(leader.nodeId, 'b', { type: 'put', key, value: 'b' }),
        await client.call(leader.nodeId, 'b', { type: 'get', key }),
      ])(),
    ]);
    const history = [...a, ...b];
    evidence.assert('six invocations and returns captured', history.every(operation => operation.responseNs),
      { operations: history.length });
    evidence.assert('client calls overlap', BigInt(b[0].invocationNs) < BigInt(a[0].responseNs!),
      { firstResponse: a[0].responseNs, secondInvocation: b[0].invocationNs });
    evidence.event('verification.pending', { stage: 'S4', initialState: { found: false } });
  }

  try {
    imageId = runDocker(['image', 'inspect', image, '--format', '{{.Id}}']);
    if (id === 'R01') await killLeader();
    if (id === 'R02') await partition();
    if (id === 'R03') await captureHistory();
    runDocker(['compose', 'logs', '--no-color', '--since', '2m']);
    return evidence.finish(id === 'R03' ? 'INCONCLUSIVE' : 'PASS', { imageId, node: process.version });
  } catch (error) {
    evidence.log(error instanceof Error ? error.stack ?? error.message : String(error));
    try {
      runDocker(['compose', 'logs', '--no-color', '--since', '2m']);
    } catch (logError) {
      evidence.log(String(logError));
    }
    return evidence.finish('FAIL', { imageId, node: process.version, recoveryRequired });
  }
}
