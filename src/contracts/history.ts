export type Scalar = string | number | boolean | null;

export type Operation =
  | { type: 'get'; key: string }
  | { type: 'put'; key: string; value: Scalar }
  | { type: 'delete'; key: string };

export type OperationResult =
  | { found: true; value: Scalar }
  | { found: false }
  | { stored: true }
  | { deleted: boolean };

export type ClientHistory = {
  runId: string;
  operationId: string;
  engine: 'raft' | 'txn';
  clientId: string;
  operation: Operation;
  invocationNs: string;
  responseNs?: string;
  outcome: 'ok' | 'rejected' | 'unknown';
  result?: OperationResult;
  errorCode?: string;
};

export type ExperimentResult = {
  experimentId: string;
  runId: string;
  startedAt: string;
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  assertionResults: Array<{ name: string; passed: boolean; details: unknown }>;
  evidencePaths: string[];
};

export function isOperation(value: unknown): value is Operation {
  if (typeof value !== 'object' || value === null || !('key' in value)
      || typeof value.key !== 'string' || value.key.length === 0 || !('type' in value)) {
    return false;
  }
  if (value.type === 'get' || value.type === 'delete') return true;
  if (value.type !== 'put' || !('value' in value)) return false;
  return value.value === null || typeof value.value === 'string'
    || typeof value.value === 'boolean' || Number.isFinite(value.value);
}
