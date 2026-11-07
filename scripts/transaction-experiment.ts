/** Runs T01–T03 through HTTP against isolated Compose containers and preserves raw evidence. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { Scalar } from '../src/contracts/history.ts';
import type { CommittedTransaction, TransactionReadResult } from '../src/contracts/transaction.ts';
import type { recover } from '../src/transaction/storage/recovery.ts';
import type { FaultPoint, WalRecord } from '../src/transaction/storage/wal.ts';
import { openEvidence } from './evidence.ts';

type Evidence = ReturnType<typeof openEvidence>;
type Recovery = ReturnType<typeof recover>;
type Status = { commitSeq: number; active: string[]; pending: number; committed: number; appliedLsn: number; lastLsn: number };
type Commit = Extract<WalRecord, { type: 'COMMIT' }>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class Lab {
  readonly project: string;
  private readonly evidence: Evidence;
  private boot = 0;
  private container?: string;
  private origin?: string;

  constructor(project: string, evidence: Evidence) {
    this.project = project;
    this.evidence = evidence;
  }

  docker(...args: string[]): string {
    const result = spawnSync('docker', args, {
      encoding: 'utf8', timeout: 120_000, env: { ...process.env, TXN_FAULTS_ENABLED: '1' },
    });
    this.evidence.log(`> docker ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${result.status}`);
    return result.stdout.trim();
  }

  compose(...args: string[]) {
    return this.docker('compose', '-f', 'compose.transaction.yaml', '-p', this.project, ...args);
  }

  async start(point?: 'during-redo' | 'after-clr-wal') {
    const name = `${this.project}-boot-${++this.boot}`;
    const startup = point ? ['-e', `TXN_FAULT_POINT=${point}`] : [];
    this.container = this.compose('run', '-d', '--no-deps', '--service-ports', '--name', name, ...startup, 'transaction');
    const mounts = JSON.parse(this.docker('inspect', '--format', '{{json .Mounts}}', this.container)) as { Name: string; Destination: string }[];
    const volume = mounts.find(mount => mount.Destination === '/data')?.Name;
    this.evidence.assert('transaction uses the dedicated project volume', volume === `${this.project}_data`,
      { container: this.container, name, volume, boot: this.boot, startupFault: point });
    this.origin = undefined;
    if (point) return;
    const address = this.docker('port', this.container, '8080/tcp');
    this.origin = `http://${address}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${this.origin}/health`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
      if (response?.ok) {
        const body: unknown = await response.json();
        this.evidence.event('ready', { container: this.container, origin: this.origin, body });
        return;
      }
      await pause(100);
    }
    this.docker('logs', '--timestamps', this.container);
    throw new Error(`Transaction service did not become ready at ${this.origin}`);
  }

  async request<T>(path: string, body?: object) {
    const invocationNs = process.hrtime.bigint().toString();
    const context = { project: this.project, container: this.container, path, body, invocationNs };
    this.evidence.event('http-invocation', context);
    try {
      const response = await fetch(this.origin + path, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json() as T;
      this.evidence.event('http-response', {
        ...context, responseNs: process.hrtime.bigint().toString(), status: response.status, result,
      });
      return { status: response.status, result };
    } catch (error) {
      this.evidence.event('http-disconnected', {
        ...context, responseNs: process.hrtime.bigint().toString(), error: String(error),
      });
      throw error;
    }
  }

  async ok<T>(path: string, body?: object): Promise<T> {
    const reply = await this.request<T>(path, body);
    if (reply.status !== 200) throw new Error(`${path}: ${JSON.stringify(reply)}`);
    return reply.result;
  }

  async begin(isolation: 'RC' | 'SI' = 'RC', lock?: string) {
    return (await this.ok<{ txnId: string }>('/txn/begin', { isolation, lock })).txnId;
  }

  put(txn: string, key: string, value: Scalar) { return this.ok(`/txn/${txn}/put`, { key, value }); }
  delete(txn: string, key: string) { return this.ok(`/txn/${txn}/delete`, { key }); }
  read(txn: string, key: string) { return this.ok<TransactionReadResult>(`/txn/${txn}/read`, { key }); }
  async commit(txn: string) {
    const result = await this.ok<{ history: CommittedTransaction }>(`/txn/${txn}/commit`, {});
    this.evidence.event('txn-history', { project: this.project, ...result.history });
    return result.history;
  }
  status() { return this.ok<Status>('/txn/status'); }
  wal() { return this.ok<WalRecord[]>('/internal/txn/wal'); }
  recovery() { return this.ok<Recovery>('/internal/txn/recovery'); }
  asOf(key: string, lsn: number) {
    return this.ok<TransactionReadResult>(`/txn/as-of?${new URLSearchParams({ key, lsn: String(lsn) })}`);
  }

  async fault(point: FaultPoint, path: string, body: object = {}) {
    await this.ok('/internal/txn/fault', { point });
    let disconnected = false;
    try { await this.request(path, body); } catch { disconnected = true; }
    this.evidence.assert('fault interrupted the HTTP response', disconnected, { point, path });
    return this.exited(point);
  }

  kill() {
    this.docker('kill', '--signal', 'SIGKILL', this.container!);
    return this.exited();
  }

  exited(point?: FaultPoint): WalRecord[] {
    const container = this.container!;
    const exit = this.docker('wait', container);
    const state: unknown = JSON.parse(this.docker('inspect', '--format', '{{json .State}}', container));
    const logs = this.docker('logs', '--timestamps', container);
    const path = join('.scratch', this.evidence.runId, `${this.project}-${this.boot}.jsonl`);
    mkdirSync(join('.scratch', this.evidence.runId), { recursive: true });
    this.docker('cp', `${container}:/data/wal.jsonl`, path);
    const rawWal = readFileSync(path, 'utf8');
    this.evidence.event('crashed-wal', { project: this.project, container, point, rawWal });
    this.evidence.assert('observed SIGKILL exit 137', exit === '137' &&
      (!point || logs.includes(`"signal":"SIGKILL","point":"${point}"`)), { container, point, exit, state });
    return rawWal.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line) as WalRecord);
  }

  stop() {
    if (!this.container) return;
    this.docker('stop', this.container);
    this.docker('logs', '--timestamps', this.container);
  }
}

function commitRecord(records: WalRecord[], txnId: string): Commit {
  const record = records.find(entry => entry.type === 'COMMIT' && entry.txnId === txnId);
  if (record?.type !== 'COMMIT') throw new Error(`Missing COMMIT for ${txnId}`);
  return record;
}

async function t01(lab: Lab, evidence: Evidence) {
  await lab.start();
  const seed = await lab.begin();
  await lab.put(seed, 'x', 'original');
  await lab.put(seed, 'y', 1);
  await lab.commit(seed);
  const seedLsn = commitRecord(await lab.wal(), seed).lsn;

  for (const point of ['after-update-wal', 'after-update-data', 'before-commit-wal'] as const) {
    const loser = await lab.begin('SI');
    if (point === 'before-commit-wal') {
      await lab.put(loser, 'x', 'unconfirmed');
      await lab.delete(loser, 'y');
    }
    const crashed = await (point === 'before-commit-wal' ? lab.fault(point, `/txn/${loser}/commit`)
      : lab.fault(point, `/txn/${loser}/put`, { key: 'x', value: 'unconfirmed' }));
    const updateLsns = crashed.flatMap(record => record.type === 'UPDATE' && record.txnId === loser ? [record.lsn] : []);
    evidence.assert('loser UPDATE is durable without COMMIT', updateLsns.length === (point === 'before-commit-wal' ? 2 : 1) &&
      !crashed.some(record => record.type === 'COMMIT' && record.txnId === loser), { point, loser, updateLsns });
    if (point === 'after-update-wal') {
      await lab.start('during-redo');
      await lab.exited('during-redo');
    }
    await lab.start();
    const recovery = await lab.recovery();
    const status = await lab.status();
    const values = [await lab.asOf('x', status.lastLsn), await lab.asOf('y', status.lastLsn)];
    evidence.assert('loser undone and earlier confirmed versions preserved',
      recovery.losers.includes(loser) && same(recovery.undoneLsns, [...updateLsns].reverse()) &&
      recovery.redoLsns.length === 0 && status.pending === 0 &&
      same(values, [{ found: true, value: 'original' }, { found: true, value: 1 }]), { point, recovery, status, values });
  }

  const winner = await lab.begin('SI');
  await lab.put(winner, 'x', 'durable');
  await lab.delete(winner, 'y');
  const crashed = await lab.fault('after-commit-wal', `/txn/${winner}/commit`);
  const commit = commitRecord(crashed, winner);
  await lab.start();
  const recovery = await lab.recovery();
  const prior = [await lab.asOf('x', commit.lsn - 1), await lab.asOf('y', commit.lsn - 1)];
  const after = [await lab.asOf('x', commit.lsn), await lab.asOf('y', commit.lsn)];
  evidence.assert('durable COMMIT redone atomically at its AS OF LSN', recovery.winners.includes(winner) &&
    recovery.redoLsns.includes(commit.lsn) && same(prior, [{ found: true, value: 'original' }, { found: true, value: 1 }]) &&
    same(after, [{ found: true, value: 'durable' }, { found: false }]), { commit, recovery, prior, after });

  const active = await lab.begin();
  await lab.put(active, 'z', 'pending');
  const checkpoint = await lab.ok<WalRecord>('/internal/txn/checkpoint', {});
  const partial = await lab.fault('during-checkpoint', '/internal/txn/checkpoint');
  await lab.start();
  const checkpointRecovery = await lab.recovery();
  const status = await lab.status();
  const absent = await lab.asOf('z', status.lastLsn);
  evidence.assert('interrupted checkpoint uses previous complete checkpoint', partial.at(-1)?.type === 'CHECKPOINT_BEGIN' &&
    checkpointRecovery.checkpointLsn === checkpoint.lsn && checkpointRecovery.losers.includes(active) &&
    !absent.found && status.pending === 0, { checkpoint, checkpointRecovery, status, absent });

  const beforeRestart = await lab.wal();
  lab.kill();
  await lab.start();
  const repeated = await lab.recovery();
  const seedValue = await lab.asOf('x', seedLsn);
  const current = await lab.asOf('x', status.lastLsn);
  evidence.assert('repeated restart preserves WAL and historical reads', same(beforeRestart, await lab.wal()) &&
    repeated.redoLsns.length === 0 && repeated.losers.length === 0 && repeated.winners.length === 0 &&
    same(seedValue, { found: true, value: 'original' }) && same(current, after[0]), { repeated, seedValue, current });
}

async function t02(lab: Lab, evidence: Evidence) {
  await lab.start();
  const draft = await lab.begin('SI');
  await lab.put(draft, 'draft', null);
  const own = await lab.read(draft, 'draft');
  const aborted = await lab.ok<{ history: { status: string } }>(`/txn/${draft}/abort`, {});
  const clean = await lab.status();
  evidence.assert('HTTP ABORT removes a private null version', same(own, { found: true, value: null }) &&
    aborted.history.status === 'aborted' && clean.pending === 0 && !(await lab.asOf('draft', clean.lastLsn)).found,
    { own, aborted, clean });
  for (const guarded of [false, true]) {
    const seed = await lab.begin();
    await lab.put(seed, 'alice', true);
    await lab.put(seed, 'bob', true);
    await lab.commit(seed);
    const lock = guarded ? 'on-call' : undefined;
    const alice = await lab.begin('SI', lock);
    const bobAttempt = await lab.request<{ txnId?: string; error?: string }>('/txn/begin', { isolation: 'SI', lock });
    const aliceRead = await lab.read(alice, 'bob');
    if (aliceRead.found && aliceRead.value === true) await lab.put(alice, 'alice', false);
    const leaveBob = async (id: string) => {
      const read = await lab.read(id, 'alice');
      if (read.found && read.value === true) await lab.put(id, 'bob', false);
    };
    if (!guarded) await leaveBob(bobAttempt.result.txnId!);
    const aliceHistory = await lab.commit(alice);
    const bob = guarded ? await lab.begin('SI', lock) : bobAttempt.result.txnId!;
    if (guarded) await leaveBob(bob);
    const bobHistory = await lab.commit(bob);
    const status = await lab.status();
    const values = [await lab.asOf('alice', status.lastLsn), await lab.asOf('bob', status.lastLsn)];
    const onCall = values.filter(value => value.found && value.value === true).length;
    const read = bobHistory.accesses.find(access => access.kind === 'read');
    evidence.assert(guarded ? 'lock conflict retries with a fresh snapshot and preserves coverage' : 'SI write skew breaks coverage',
      onCall === (guarded ? 1 : 0) &&
      (guarded ? bobAttempt.status === 409 && bobAttempt.result.error === 'LOCK_CONFLICT' &&
        bobHistory.snapshotSeq === aliceHistory.commitSeq && read?.observedVersionId === `${alice}:1`
        : bobAttempt.status === 200 && aliceHistory.snapshotSeq === bobHistory.snapshotSeq &&
          read?.observedVersionId === `${seed}:1`), { bobAttempt, aliceHistory, bobHistory, values, onCall });
  }
}

async function t03(lab: Lab, baseline: Lab, evidence: Evidence) {
  async function setup(target: Lab) {
    await target.start();
    const winner = await target.begin();
    await target.put(winner, 'x', 'confirmed');
    await target.commit(winner);
    const loser = await target.begin('SI');
    await target.put(loser, 'x', 'private');
    await target.ok('/internal/txn/checkpoint', {});
    await target.put(loser, 'y', 2);
    await target.delete(loser, 'x');
    const status = await target.status();
    const wal = target.kill();
    const updates = wal.flatMap(record => record.type === 'UPDATE' && record.txnId === loser ? [record.lsn] : []);
    evidence.assert('loser has three durable private updates before SIGKILL', status.pending === 3 && updates.length === 3,
      { project: target.project, loser, status, updates });
    return { loser, updates };
  }

  const { loser, updates } = await setup(lab);
  await lab.start('after-clr-wal');
  const interrupted = await lab.exited('after-clr-wal');
  const firstClr = interrupted.at(-1);
  evidence.assert('partial undo flushed one CLR with an undo-next link', firstClr?.type === 'CLR' &&
    firstClr.undoneLsn === updates[2] && firstClr.undoNextLsn === updates[1], { firstClr, updates });
  await lab.start();
  const resumed = await lab.recovery();
  const clrs = (await lab.wal()).filter(record => record.type === 'CLR');
  evidence.assert('redo replays the durable CLR and undo resumes without duplicating it',
    resumed.losers.includes(loser) && resumed.redoLsns.includes(firstClr!.lsn) &&
    same(resumed.undoneLsns, [updates[1], updates[0]]) &&
    same(clrs.map(record => record.undoneLsn), [...updates].reverse()), { resumed, clrs });

  await setup(baseline);
  await baseline.start();
  const control = await baseline.recovery();
  const status = await lab.status();
  const baselineStatus = await baseline.status();
  const values = await Promise.all([lab.asOf('x', status.lastLsn), lab.asOf('y', status.lastLsn)]);
  const baselineValues = await Promise.all([
    baseline.asOf('x', baselineStatus.lastLsn), baseline.asOf('y', baselineStatus.lastLsn),
  ]);
  evidence.assert('interrupted undo and single recovery have identical terminal state',
    same(values, [{ found: true, value: 'confirmed' }, { found: false }]) && same(values, baselineValues) &&
    status.pending === 0 && same(status, baselineStatus) && same(await lab.wal(), await baseline.wal()) &&
    same(control.undoneLsns, [...updates].reverse()), { status, baselineStatus, values, baselineValues, control });
}

const id = process.argv[2];
if (id !== 'T01' && id !== 'T02' && id !== 'T03') throw new Error('Usage: pnpm txn:experiment T01|T02|T03');
const evidence = openEvidence(id, `pnpm txn:experiment ${id}`, { signal: 'SIGKILL', compose: 'compose.transaction.yaml' });
const project = `txn-${id.toLowerCase()}-${evidence.runId.slice(-8)}`;
const lab = new Lab(project, evidence);
const baseline = id === 'T03' ? new Lab(`${project}-control`, evidence) : undefined;
let image: string | undefined;
let passed = false;
try {
  lab.compose('build', 'transaction');
  image = lab.docker('image', 'inspect', 'minidb-txn:local', '--format', '{{.Id}}');
  if (id === 'T01') await t01(lab, evidence);
  if (id === 'T02') await t02(lab, evidence);
  if (id === 'T03') await t03(lab, baseline!, evidence);
  passed = true;
} catch (error) {
  evidence.log(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  for (const target of [lab, baseline]) {
    try { target?.stop(); } catch (error) { passed = false; evidence.log(String(error)); }
  }
  evidence.finish(passed ? 'PASS' : 'FAIL', { image, projects: [project, baseline?.project].filter(Boolean) });
  if (!passed) process.exitCode = 1;
}
