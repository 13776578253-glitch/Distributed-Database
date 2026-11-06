import { setTimeout as sleep } from 'node:timers/promises';
import type { ClientHistory, Operation } from '../src/contracts/history.ts';
import type { ClientReply } from '../src/raft/core/types.ts';
import type { RaftNode } from '../src/raft/core/node.ts';
import { nodeIds } from './docker.ts';
import type { openEvidence } from './evidence.ts';

type Status = ReturnType<RaftNode['status']> & { committedDigest: string };
type Evidence = ReturnType<typeof openEvidence>;

function networkFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
}

async function statuses(address: (nodeId: string) => string): Promise<Status[]> {
  const responses = await Promise.all(nodeIds.map(async nodeId => {
    try {
      const response = await fetch(`${address(nodeId)}/internal/raft/status`, {
        signal: AbortSignal.timeout(450),
      });
      if (!response.ok) throw new Error(`${nodeId} status HTTP ${response.status}`);
      const status = await response.json() as Status;
      if (status.nodeId !== nodeId) throw new Error(`Expected ${nodeId}, received ${status.nodeId}`);
      return status;
    } catch (error) {
      if (networkFailure(error)) return undefined;
      throw error;
    }
  }));
  return responses.filter(response => response !== undefined);
}

export function raftClient(evidence: Evidence, resolveAddress: (nodeId: string) => string) {
  let sequence = 0;

  async function waitFor(label: string, condition: (nodes: Status[]) => boolean, timeout = 8000) {
    const deadline = performance.now() + timeout;
    let last: Status[] = [];
    while (performance.now() < deadline) {
      last = await statuses(resolveAddress);
      if (condition(last)) {
        evidence.event('raft.status', { label, nodes: last });
        return last;
      }
      await sleep(50);
    }
    throw new Error(`${label} timed out, last status: ${JSON.stringify(last)}`);
  }

  async function leader(members = nodeIds) {
    const eligible = (node: Status) => node.ready && members.includes(node.nodeId);
    const nodes = await waitFor('ready leader', nodes => nodes.filter(eligible).length === 1);
    return nodes.find(eligible)!;
  }

  async function converged() {
    return waitFor('converged committed log', nodes =>
      nodes.length === nodeIds.length && nodes.filter(node => node.ready).length === 1
      && nodes.every(node => node.commitIndex === nodes[0].commitIndex
        && node.lastApplied === node.commitIndex && node.logLength === node.commitIndex
        && node.committedDigest === nodes[0].committedDigest));
  }

  async function call(nodeId: string, clientId: string, operation: Operation): Promise<ClientHistory> {
    const invocation = {
      runId: evidence.runId, operationId: String(++sequence), engine: 'raft' as const,
      clientId, operation, invocationNs: process.hrtime.bigint().toString(),
    };
    evidence.event('client.invoke', { ...invocation, nodeId });
    const url = new URL(`${resolveAddress(nodeId)}/kv`);
    const init: RequestInit = { signal: AbortSignal.timeout(3000) };
    if (operation.type === 'get') url.searchParams.set('key', operation.key);
    else {
      url.pathname += `/${operation.type}`;
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(operation);
    }

    let history: ClientHistory;
    try {
      const response = await fetch(url, init);
      const reply = await response.json() as ClientReply;
      const responseNs = process.hrtime.bigint().toString();
      history = reply.ok
        ? { ...invocation, responseNs, outcome: 'ok', result: reply.result }
        : { ...invocation, responseNs, outcome: reply.error === 'UNKNOWN_OUTCOME' ? 'unknown' : 'rejected',
          errorCode: reply.error };
    } catch (error) {
      if (!networkFailure(error)) throw error;
      history = {
        ...invocation, responseNs: process.hrtime.bigint().toString(), outcome: 'unknown',
        errorCode: error instanceof DOMException && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNKNOWN_OUTCOME',
      };
    }
    evidence.event('client.return', { ...history, nodeId });
    return history;
  }

  async function block(nodeId: string, blockedPeers: string[]) {
    const response = await fetch(`${resolveAddress(nodeId)}/internal/fault/links`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockedPeers }), signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`${nodeId} fault HTTP ${response.status}`);
    await response.json();
    evidence.event('fault.links', { nodeId, blockedPeers });
  }

  return { leader, converged, call, block };
}
