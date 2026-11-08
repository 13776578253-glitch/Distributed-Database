/**
 * Searches legal per-key register orders over a client-side history. Malformed
 * evidence or an exhausted search budget yields INCONCLUSIVE; a complete search
 * with no legal order yields FAIL.
 */
import { performance } from 'node:perf_hooks';
import { isOperation, isScalar } from '../contracts/history.ts';
import type { ClientHistory, Operation, OperationResult, Scalar } from '../contracts/history.ts';

/** 寄存器状态；undefined 表示键缺失，没有单独的墓碑值。 */
type Register = Scalar | undefined;
/** initial 是每个键的初始状态；预算耗尽时返回 INCONCLUSIVE。 */
type Options = {
  initial: ReadonlyMap<string, Scalar>;
  maxStates?: number;
  timeoutMs?: number;
  maxOperationsPerKey?: number;
};
/** 参与搜索的调用；unknown 写没有 returned/result，因而可被选中或省略。 */
type Call = {
  id: string;
  operation: Operation;
  invoked: bigint;
  returned?: bigint;
  result?: OperationResult;
};
type Mismatch = { operationId: string; expected: OperationResult; observed: OperationResult };
type DeadEnd = { prefix: string[]; mismatches: Mismatch[] };
type Witness = { key: string; order: string[]; omitted: string[] };

export type LinearizabilityResult =
  | { status: 'PASS'; states: number; witnesses: Witness[]; rejected: string[]; unobservedReads: string[] }
  | { status: 'FAIL'; states: number; counterexample: DeadEnd & {
      key: string; operations: string[]; realTime: { before: string; after: string }[];
    } }
  | { status: 'INCONCLUSIVE'; states: number; reason: string };

/** 结果必须完整对应操作类型；缺失或形状不符的 ok 历史不可判定。 */
function validResult(type: Operation['type'], result?: OperationResult): result is OperationResult {
  if (!result || typeof result !== 'object') return false;
  if (type === 'put') return 'stored' in result && result.stored === true;
  if (type === 'delete') return 'deleted' in result && typeof result.deleted === 'boolean';
  return 'found' in result && (result.found === false || (result.found === true && isScalar(result.value)));
}

/** 单个键的寄存器状态转移；删除在缺失键上也返回 deleted:false。 */
function effect(operation: Operation, current: Register): [Register, OperationResult] {
  if (operation.type === 'put') return [operation.value, { stored: true }];
  if (operation.type === 'delete') return [undefined, { deleted: current !== undefined }];
  return [current, current === undefined ? { found: false } : { found: true, value: current }];
}

function agrees(expected: OperationResult, observed: OperationResult): boolean {
  if ('stored' in expected) return 'stored' in observed && observed.stored;
  if ('deleted' in expected) return 'deleted' in observed && expected.deleted === observed.deleted;
  return 'found' in observed && expected.found === observed.found
    && (!expected.found || (observed.found && expected.value === observed.value));
}

export function checkLinearizable(history: readonly ClientHistory[], options: Options): LinearizabilityResult {
  const byKey = new Map<string, Call[]>();
  const seen = new Set<string>();
  const rejected: string[] = [];
  const unobservedReads: string[] = [];
  const decimal = /^\d+$/;
  let states = 0;
  const incomplete = (reason: string): LinearizabilityResult => ({ status: 'INCONCLUSIVE', states, reason });

  for (const entry of history) {
    const { operationId: id, operation, invocationNs, responseNs, outcome, result } = entry;
    // 同一 run/engine、唯一 ID、十进制纳秒时间和完整 outcome 是搜索前提。
    if (!id || seen.has(id) || entry.runId !== history[0].runId || entry.engine !== history[0].engine
      || !isOperation(operation) || typeof invocationNs !== 'string' || !decimal.test(invocationNs)
      || (responseNs !== undefined && (typeof responseNs !== 'string' || !decimal.test(responseNs)))
      || !['ok', 'rejected', 'unknown'].includes(outcome)
      || (outcome !== 'unknown' && responseNs === undefined)) return incomplete(`Incomplete call: ${id}`);
    seen.add(id);
    const invoked = BigInt(invocationNs);
    const response = responseNs === undefined ? undefined : BigInt(responseNs);
    if (response !== undefined && response < invoked) return incomplete(`Invalid time interval: ${id}`);
    if (outcome === 'ok' && !validResult(operation.type, result)) return incomplete(`Missing result: ${id}`);
    if (outcome === 'rejected') { rejected.push(id); continue; }
    // unknown 读没有可匹配的结果；unknown 写仍进入搜索，可能生效也可能未生效。
    if (outcome === 'unknown' && operation.type === 'get') { unobservedReads.push(id); continue; }

    const calls = byKey.get(operation.key) ?? [];
    calls.push({
      id, operation, invoked,
      returned: outcome === 'ok' ? response : undefined,
      result: outcome === 'ok' ? result : undefined,
    });
    byKey.set(operation.key, calls);
  }

  const deadline = performance.now() + (options.timeoutMs ?? 1_000);
  const witnesses: Witness[] = [];
  for (const [key, calls] of byKey) {
    if (calls.length > (options.maxOperationsPerKey ?? 64)) return incomplete(`Too many operations for ${key}`);
    const bits = calls.map((_, index) => 1n << BigInt(index));
    // 只有带结果的调用必须被放置；unknown 写可以被省略。
    const required = calls.reduce((mask, call, i) => call.result ? mask | bits[i] : mask, 0n);
    const realTime: { before: string; after: string }[] = [];
    // 已返回且返回时间早于当前调用发起的操作，顺序必须在当前调用之前。
    const predecessors = calls.map(call => calls.reduce((mask, earlier, i) => {
      if (earlier.returned === undefined || earlier.returned >= call.invoked) return mask;
      realTime.push({ before: earlier.id, after: call.id });
      return mask | bits[i];
    }, 0n));
    const failed = new Set<string>();
    const prefix: string[] = [];
    let deadEnd: DeadEnd = { prefix: [], mismatches: [] };

    function search(mask: bigint, value: Register): 'found' | 'failed' | 'limit' {
      if ((mask & required) === required) return 'found';
      if (performance.now() >= deadline || states >= (options.maxStates ?? 100_000)) return 'limit';
      const fingerprint = JSON.stringify([mask.toString(), value === undefined ? [] : [value]]);
      if (failed.has(fingerprint)) return 'failed';
      states++;
      const mismatches: Mismatch[] = [];
      let advanced = false;
      for (const [i, call] of calls.entries()) {
        if ((mask & bits[i]) !== 0n || (mask & predecessors[i]) !== predecessors[i]) continue;
        const [next, expected] = effect(call.operation, value);
        if (call.result && !agrees(expected, call.result)) {
          mismatches.push({ operationId: call.id, expected, observed: call.result });
          continue;
        }
        advanced = true;
        prefix.push(call.id);
        const answer = search(mask | bits[i], next);
        if (answer !== 'failed') return answer;
        prefix.pop();
      }
      // 无可用调用且未覆盖全部 required：保留最长的失败前缀作为反例。
      if (!advanced && prefix.length >= deadEnd.prefix.length) deadEnd = { prefix: [...prefix], mismatches };
      failed.add(fingerprint);
      return 'failed';
    }

    const answer = search(0n, options.initial.get(key));
    if (answer === 'limit') return incomplete(`Search budget exhausted for ${key}`);
    if (answer === 'failed') {
      return { status: 'FAIL', states, counterexample: { key, operations: calls.map(call => call.id), realTime, ...deadEnd } };
    }
    const selected = new Set(prefix);
    witnesses.push({ key, order: prefix, omitted: calls.filter(call => !selected.has(call.id)).map(call => call.id) });
  }
  return { status: 'PASS', states, witnesses, rejected, unobservedReads };
}
