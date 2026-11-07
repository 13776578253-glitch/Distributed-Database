/** Verifies replay against committed Evidence and the path allowlist. */
import { expect, it } from 'vitest';
import { evidenceReader } from '../../src/observer/evidence.ts';

it('reads Raft, transaction and verification evidence and preserves verdicts and order', async () => {
  const reader = evidenceReader();
  const runs = await reader.list();
  const r01 = runs.find(run => run.experimentId === 'R01' && run.status === 'PASS')!;
  const r03 = runs.find(run => run.experimentId === 'R03')!;
  expect(new Set(runs.map(run => run.experimentId))).toEqual(new Set([
    'R01', 'R02', 'R03', 'R04', 'E0', 'E1', 'E2', 'E3B', 'E4B', 'T01', 'T02', 'T03', 'V01', 'V02', 'V03',
  ]));
  expect(r03.status).toBe('INCONCLUSIVE');
  const detail = await reader.detail(r01.experimentId, r01.runId);
  expect(detail?.invalidLines).toBe(0);
  expect(detail?.files).toContain('raw.log');
  const kinds = detail?.events.map(event => event.kind) ?? [];
  expect(kinds.indexOf('fault.kill')).toBeGreaterThan(-1);
  expect(kinds.indexOf('fault.restart')).toBeGreaterThan(kinds.indexOf('fault.kill'));
  expect(await reader.file('R01', r01.runId, '../../.git/config')).toBeUndefined();
  expect(await reader.file('R01', '..', 'result.json')).toBeUndefined();
  expect(await reader.file('SMOKE', r01.runId, 'result.json')).toBeUndefined();
  const v01 = runs.find(run => run.experimentId === 'V01')!;
  const replay = await reader.detail(v01.experimentId, v01.runId);
  const source = replay?.events.find(event => event.kind === 'source')?.raw as { details: { id: string; runId: string } };
  expect(source.details.id).toBe('R03');
  expect((await reader.detail(source.details.id, source.details.runId))?.result.status).toBe('INCONCLUSIVE');
  expect(replay?.result.status).toBe('PASS');
});
