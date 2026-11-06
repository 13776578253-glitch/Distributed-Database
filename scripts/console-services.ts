/** Reads Compose health independently from Raft and the log collector. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServiceStatus } from '../src/contracts/console.ts';
import { nodeIds } from './docker.ts';

const exec = promisify(execFile);

export async function composeServices(): Promise<Pick<ServiceStatus, 'nodes' | 'dockerError'>> {
  try {
    const { stdout } = await exec('docker', ['compose', 'ps', '--all', '--format', 'json', ...nodeIds],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024, windowsHide: true });
    const input = stdout.trim();
    const rows: { Service: string; State: string; Health: string; ID: string }[] =
      input.startsWith('[') ? JSON.parse(input) : input.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return { nodes: nodeIds.map(nodeId => {
      const row = rows.find(item => item.Service === nodeId);
      return { nodeId, state: row?.State || 'absent', health: row?.Health || '—', containerId: row?.ID };
    }) };
  } catch (error) {
    return {
      nodes: nodeIds.map(nodeId => ({ nodeId, state: 'unknown', health: '—' })),
      dockerError: error instanceof Error ? error.message : String(error),
    };
  }
}
