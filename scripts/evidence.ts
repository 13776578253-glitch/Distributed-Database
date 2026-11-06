import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExperimentResult } from '../src/contracts/history.ts';

export function openEvidence(experimentId: string, command: string, parameters: unknown) {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(':', '-')}--${randomUUID().slice(0, 8)}`;
  const directory = join('evidence', experimentId, runId);
  const evidencePaths = ['command.txt', 'metadata.json', 'events.jsonl', 'raw.log', 'result.json'];
  const file = (name: string) => join(directory, name);
  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  const gitSha = git.status === 0 ? git.stdout.trim() : null;
  const gitStatus = spawnSync('git', ['status', '--porcelain', '--', '.', ':(exclude)evidence'], { encoding: 'utf8' });
  const gitDirty = gitStatus.status === 0 ? gitStatus.stdout.trim() !== '' : null;
  const assertionResults: ExperimentResult['assertionResults'] = [];

  mkdirSync(directory, { recursive: true });
  writeFileSync(file('command.txt'), command + '\n');
  writeFileSync(file('events.jsonl'), '');
  writeFileSync(file('raw.log'), '');

  function event(kind: string, details: unknown) {
    appendFileSync(file('events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), kind, details,
    }) + '\n');
  }

  function log(line: string) {
    appendFileSync(file('raw.log'), line + '\n');
    console.log(line);
  }

  function assert(name: string, passed: boolean, details: unknown) {
    const assertion = { name, passed, details };
    assertionResults.push(assertion);
    event('assertion', assertion);
    if (!passed) throw new Error(name);
  }

  function finish(status: ExperimentResult['status'], environment: unknown) {
    writeFileSync(file('metadata.json'), JSON.stringify({
      startedAt, endedAt: new Date().toISOString(), gitSha, gitDirty, parameters, environment,
    }, null, 2) + '\n');
    const result: ExperimentResult = {
      experimentId, runId, startedAt, status, assertionResults, evidencePaths,
    };
    // result.json 是完成标记，读者只会看到完整的最终判定。
    writeFileSync(file('.result.tmp'), JSON.stringify(result, null, 2) + '\n');
    renameSync(file('.result.tmp'), file('result.json'));
    console.log(`${experimentId} ${status} ${directory}`);
    return result;
  }

  return { runId, directory, event, log, assert, finish };
}
