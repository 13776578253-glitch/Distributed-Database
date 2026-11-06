/** Checks Compose startup decisions and isolation of configured targets. */
import { describe, expect, it, vi } from 'vitest';
import { prepareConsoleCluster } from '../../scripts/console-cluster.ts';
import { nodeIds } from '../../src/raft/config.ts';

const config = JSON.stringify({
  name: 'console-test',
  services: Object.fromEntries(nodeIds.map((nodeId, index) => [nodeId, {
    ports: [{ target: 8080, published: String(19081 + index), host_ip: '127.0.0.1', protocol: 'tcp' }],
    volumes: [{ type: 'volume', source: nodeId, target: '/data' }],
  }])),
  volumes: Object.fromEntries(nodeIds.map(nodeId => [nodeId, { name: `test-${nodeId}`, external: true }])),
});

describe('console cluster startup', () => {
  it('attaches when even one Compose container exists, without writing to Docker', () => {
    const docker = vi.fn().mockReturnValueOnce(config).mockReturnValueOnce('existing-container');
    expect(prepareConsoleCluster(docker)).toMatchObject({
      mode: 'attached',
      targets: nodeIds.map((nodeId, index) => ({ nodeId, address: `http://127.0.0.1:${19081 + index}` })),
    });
    expect(docker.mock.calls.map(([args]) => args)).toEqual([
      ['compose', 'config', '--format', 'json'],
      ['compose', 'ps', '--all', '--quiet', ...nodeIds],
    ]);
  });

  it('creates the configured external volumes and starts only the Raft services on an empty project', () => {
    const docker = vi.fn().mockReturnValueOnce(config).mockReturnValue('');
    const release = vi.fn();
    const lock = vi.fn().mockReturnValue({ release });
    expect(prepareConsoleCluster(docker, { lock }).mode).toBe('initialized');
    expect(lock).toHaveBeenCalledWith('console-test', 'initialize');
    expect(release).toHaveBeenCalledOnce();
    expect(docker.mock.calls.slice(2).map(([args]) => args)).toEqual([
      ['compose', 'ps', '--all', '--quiet', ...nodeIds],
      ...nodeIds.map(nodeId => ['volume', 'create', `test-${nodeId}`]),
      ['compose', 'build', '--provenance=false', 'raft-1'],
      ['compose', 'up', '--detach', '--no-build', '--no-recreate', '--wait', '--wait-timeout', '60', ...nodeIds],
    ]);
  });

  it('keeps the configured probe targets when Docker is unavailable', () => {
    const docker = vi.fn().mockReturnValueOnce(config).mockImplementation(() => { throw new Error('Docker offline'); });
    expect(prepareConsoleCluster(docker)).toMatchObject({
      mode: 'degraded', warning: 'Docker offline', targets: [{ address: 'http://127.0.0.1:19081' },
        { address: 'http://127.0.0.1:19082' }, { address: 'http://127.0.0.1:19083' },
        { address: 'http://127.0.0.1:19084' }, { address: 'http://127.0.0.1:19085' }],
    });
  });

  it('does not initialize missing containers when restarting only the Observer', () => {
    const docker = vi.fn().mockReturnValueOnce(config).mockReturnValue('');
    const lock = vi.fn();
    expect(prepareConsoleCluster(docker, { lock, initialize: false })).toMatchObject({
      mode: 'degraded', warning: '当前 Compose 项目没有 Raft 容器',
    });
    expect(docker).toHaveBeenCalledTimes(2);
    expect(lock).not.toHaveBeenCalled();
  });
});
