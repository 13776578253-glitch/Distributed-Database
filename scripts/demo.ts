import { docker, image, labName, labNodeIds as nodeIds, membershipLab, nodePort, nodeUrl, volumeName } from './docker.ts';
import { openEvidence } from './evidence.ts';
import { raftClient } from './raft-client.ts';

if (membershipLab && labName === 'minidb-lab') throw new Error('Use an isolated RAFT_LAB_NAME for membership experiments');
const mode = 'raft-smoke';
const evidence = openEvidence('SMOKE', 'pnpm demo', { mode, nodeIds, image });
const runDocker = (args: string[]) => docker(args, evidence.log);
let imageId: string | undefined;

try {
  runDocker(['compose', 'config', '--quiet']);
  for (const nodeId of nodeIds) runDocker(['volume', 'create', volumeName(nodeId)]);
  runDocker(['compose', 'build', '--provenance=false', 'raft-1']);
  runDocker(['compose', 'up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '60']);
  imageId = runDocker(['image', 'inspect', image, '--format', '{{.Id}}']);

  for (const [index, nodeId] of nodeIds.entries()) {
    const response = await fetch(`${nodeUrl(index)}/health`, { signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    evidence.assert(`${nodeId} health`, response.ok && health.nodeId === nodeId
      && health.mode === 'raft', { port: nodePort(index), status: response.status, health });

    const container = runDocker(['compose', 'ps', '-q', nodeId]);
    const containerImage = runDocker(['inspect', container, '--format', '{{.Image}}']);
    evidence.assert(`${nodeId} image`, containerImage === imageId, { imageId: containerImage });
    const mount = runDocker(['inspect', container, '--format',
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}']);
    evidence.assert(`${nodeId} dedicated volume`, mount === volumeName(nodeId), { mount });
  }

  const client = raftClient(evidence);
  const leader = await client.leader();
  const key = `smoke/${evidence.runId}`;
  const write = await client.call(leader.nodeId, 'demo', { type: 'put', key, value: null });
  evidence.assert('confirmed put', write.outcome === 'ok', write);
  const read = await client.call(leader.nodeId, 'demo', { type: 'get', key });
  evidence.assert('quorum read of stored null', read.outcome === 'ok'
    && read.result !== undefined && 'found' in read.result && read.result.found && read.result.value === null, read);
  const remove = await client.call(leader.nodeId, 'demo', { type: 'delete', key });
  evidence.assert('confirmed delete', remove.outcome === 'ok'
    && remove.result !== undefined && 'deleted' in remove.result && remove.result.deleted, remove);
  runDocker(['compose', 'logs', '--no-color']);
  evidence.finish('PASS', { node: process.version, imageId });
} catch (error) {
  evidence.log(String(error));
  try {
    runDocker(['compose', 'logs', '--no-color']);
  } finally {
    evidence.finish('FAIL', { node: process.version, imageId });
    process.exitCode = 1;
  }
}
