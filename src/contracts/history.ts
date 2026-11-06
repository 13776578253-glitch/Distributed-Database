/**
 * Shared, engine-agnostic contracts for client operations, operation
 * results, client histories, and experiment verdicts. Defines data shapes
 * only: Raft, the transaction engine, and the verifier must not add
 * protocol semantics here.
 */
export type Scalar = string | number | boolean | null;

/** 可记录的客户端操作；key 必须非空，由边界校验保证。 */
export type Operation =
  | { type: 'get'; key: string }
  | { type: 'put'; key: string; value: Scalar }
  | { type: 'delete'; key: string };

/** 操作的可观察结果；get 由 found 区分键缺失与保存的 JSON null，delete 报告键此前是否存在。 */
export type OperationResult =
  | { found: true; value: Scalar }
  | { found: false }
  | { stored: true }
  | { deleted: boolean };

/**
 * 单次客户端调用的历史记录。时间戳为纳秒字符串；outcome 为 unknown 时
 * 表示调用方无法确定操作是否生效，验证器必须按未知结果处理。
 */
export type ClientHistory = {
  runId: string;
  operationId: string;
  engine: 'raft' | 'txn';
  clientId: string;
  operation: Operation;
  // 调用发起的纳秒时间戳 (T_invoke)
  invocationNs: string;
  // 调用返回的纳秒时间戳 (T_return)，仅在调用方收到响应时记录
  responseNs?: string;
  outcome: 'ok' | 'rejected' | 'unknown';
  result?: OperationResult;
  errorCode?: string;
};

/** 一次实验的判定与证据索引；INCONCLUSIVE 表示证据不足，不能视为通过或失败。 */
export type ExperimentResult = {
  experimentId: string;
  runId: string;
  startedAt: string;
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  assertionResults: Array<{ name: string; passed: boolean; details: unknown }>;
  evidencePaths: string[];
};

/** 校验并收窄任意 JSON 输入；只接受非空字符串 key 的 get/put/delete，put 值必须是 JSON 标量。 */
export function isOperation(value: unknown): value is Operation {
  if (typeof value !== 'object' || value === null || !('key' in value)
      || typeof value.key !== 'string' || value.key.length === 0 || !('type' in value)) {
    return false;
  }
  if (value.type === 'get' || value.type === 'delete') return true;
  if (value.type !== 'put' || !('value' in value)) return false;
  // JSON 无法表示 NaN 和 Infinity，非有限数值一律拒绝。
  return value.value === null || typeof value.value === 'string'
    || typeof value.value === 'boolean' || Number.isFinite(value.value);
}
