import { docker, nodeIds, nodeUrl, volumeName } from './docker.ts';
import { openEvidence } from './evidence.ts';

const mode = 'scaffold-smoke';
const image = 'minidb-lab:local';
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
      && health.mode === mode, { port: 18081 + index, status: response.status, health });

    const container = runDocker(['compose', 'ps', '-q', nodeId]);
    const containerImage = runDocker(['inspect', container, '--format', '{{.Image}}']);
    evidence.assert(`${nodeId} image`, containerImage === imageId, { imageId: containerImage });
    const mount = runDocker(['inspect', container, '--format',
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}']);
    evidence.assert(`${nodeId} dedicated volume`, mount === volumeName(nodeId), { mount });
  }

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
