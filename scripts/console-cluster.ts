/** Attaches to the configured Compose cluster or initializes an empty project. */
import { docker, labNodeIds, membershipLab, nodeIds } from './docker.ts';
import { acquireProjectLock } from './cluster-lock.ts';
import type { NodeTarget } from '../src/observer/cluster.ts';

export interface ComposeConfig {
  name: string;
  services: Record<string, {
    image?: string;
    ports?: { target: number; published: string; host_ip: string; protocol: string }[];
    volumes?: { type: string; source: string; target: string }[];
  }>;
  volumes: Record<string, { name: string; external?: boolean }>;
}

export function readComposeConfig(runDocker = docker): ComposeConfig {
  const config = JSON.parse(runDocker(['compose', 'config', '--format', 'json'], () => {}, 3000)) as ComposeConfig;
  if (typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(config.name)) {
    throw new Error('Invalid Compose project name');
  }
  return config;
}

export function configuredTargets(config: ComposeConfig, members = nodeIds) {
  return members.map(nodeId => {
    const ports = config.services[nodeId]?.ports?.filter(port =>
      port.target === 8080 && port.host_ip === '127.0.0.1' && port.protocol === 'tcp') ?? [];
    const port = Number(ports[0]?.published);
    if (ports.length !== 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${nodeId} requires one published loopback port for TCP 8080`);
    }
    return { nodeId, address: `http://127.0.0.1:${port}` };
  });
}

export function configuredVolumes(config: ComposeConfig, members = nodeIds) {
  const volumes = members.map(nodeId => {
    const mount = config.services[nodeId]?.volumes?.find(volume =>
      volume.type === 'volume' && volume.target === '/data');
    const volume = mount && config.volumes[mount.source];
    if (!volume?.external || typeof volume.name !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/i.test(volume.name)) {
      throw new Error(`${nodeId} requires an external /data volume`);
    }
    return volume.name;
  });
  if (new Set(volumes).size !== members.length) throw new Error('Raft members require separate data volumes');
  return volumes;
}

export function prepareConsoleCluster(runDocker = docker, {
  lock = acquireProjectLock, initialize = true,
} = {}): {
  targets: NodeTarget[];
  project?: string;
  mode: 'attached' | 'initialized' | 'degraded';
  warning?: string;
} {
  let targets: NodeTarget[] = labNodeIds.map(nodeId => ({ nodeId }));
  let project: string | undefined;
  try {
    const config = readComposeConfig(runDocker);
    project = config.name;
    if (membershipLab && config.name === 'minidb-lab') throw new Error('成员实验需要隔离的 Compose 项目');
    targets = configuredTargets(config, labNodeIds);

    // 已有任何成员（含停止状态）都只挂接，保留实验现场。
    if (runDocker(['compose', 'ps', '--all', '--quiet', ...labNodeIds])) return { targets, project, mode: 'attached' };
    if (!initialize) return { targets, project, mode: 'degraded', warning: '当前 Compose 项目没有 Raft 容器' };

    const lease = lock(project, 'initialize');
    try {
      if (runDocker(['compose', 'ps', '--all', '--quiet', ...labNodeIds])) return { targets, project, mode: 'attached' };
      for (const volume of configuredVolumes(config, labNodeIds)) runDocker(['volume', 'create', volume]);
      runDocker(['compose', 'build', '--provenance=false', nodeIds[0]]);
      runDocker(['compose', 'up', '--detach', '--no-build', '--no-recreate', '--wait', '--wait-timeout', '60', ...labNodeIds]);
      return { targets, project, mode: 'initialized' };
    } finally { lease.release(); }
  } catch (error) {
    return { targets, project, mode: 'degraded', warning: error instanceof Error ? error.message : String(error) };
  }
}
