/** Attaches to the configured Compose cluster or initializes an empty project. */
import { docker, nodeIds } from './docker.ts';
import type { NodeTarget } from '../src/observer/cluster.ts';

interface ComposeConfig {
  services: Record<string, {
    ports?: { target: number; published: string; host_ip: string; protocol: string }[];
    volumes?: { type: string; source: string; target: string }[];
  }>;
  volumes: Record<string, { name: string; external?: boolean }>;
}

export function prepareConsoleCluster(runDocker = docker): {
  targets: NodeTarget[];
  mode: 'attached' | 'initialized' | 'degraded';
  warning?: string;
} {
  let targets: NodeTarget[] = nodeIds.map(nodeId => ({ nodeId }));
  try {
    const config = JSON.parse(runDocker(['compose', 'config', '--format', 'json'], () => {})) as ComposeConfig;
    targets = nodeIds.map(nodeId => {
      const ports = config.services[nodeId]?.ports?.filter(port =>
        port.target === 8080 && port.host_ip === '127.0.0.1' && port.protocol === 'tcp') ?? [];
      const port = Number(ports[0]?.published);
      if (ports.length !== 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${nodeId} requires one published loopback port for TCP 8080`);
      }
      return { nodeId, address: `http://127.0.0.1:${port}` };
    });

    // 已有任何成员（含停止状态）都只挂接，保留实验现场。
    if (runDocker(['compose', 'ps', '--all', '--quiet', ...nodeIds])) return { targets, mode: 'attached' };

    const volumes = nodeIds.map(nodeId => {
      const mount = config.services[nodeId]?.volumes?.find(volume =>
        volume.type === 'volume' && volume.target === '/data');
      const volume = mount && config.volumes[mount.source];
      if (!volume?.external || !volume.name) throw new Error(`${nodeId} requires an external /data volume`);
      return volume.name;
    });
    if (new Set(volumes).size !== nodeIds.length) throw new Error('Raft members require separate data volumes');
    for (const volume of volumes) runDocker(['volume', 'create', volume]);
    runDocker(['compose', 'build', '--provenance=false', nodeIds[0]]);
    runDocker(['compose', 'up', '--detach', '--no-build', '--no-recreate', '--wait', '--wait-timeout', '60', ...nodeIds]);
    return { targets, mode: 'initialized' };
  } catch (error) {
    return { targets, mode: 'degraded', warning: error instanceof Error ? error.message : String(error) };
  }
}
