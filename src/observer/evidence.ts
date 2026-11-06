/** Reads completed experiment Evidence without changing its files or verdicts. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentIds } from '../contracts/console.ts';
import type { ExperimentId, RunDetail, RunSummary } from '../contracts/console.ts';
import type { ExperimentResult } from '../contracts/history.ts';
import { evidenceEvent } from './timeline.ts';

const files = ['command.txt', 'metadata.json', 'events.jsonl', 'raw.log', 'result.json', 'probe.mjs'];
const runPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z--[0-9a-f]{8}$/;
const isExperiment = (value: string): value is ExperimentId => experimentIds.some(id => id === value);
const info = (path: string) => lstat(path).catch(() => undefined);

export function evidenceReader(root = 'evidence') {
  async function file(experimentId: string, runId: string, name: string) {
    if (!isExperiment(experimentId) || !runPattern.test(runId) || !files.includes(name)) return;
    let directory = root;
    for (const part of ['', experimentId, runId]) {
      directory = join(directory, part);
      if (!(await info(directory))?.isDirectory()) return;
    }
    const path = join(directory, name);
    const stat = await info(path);
    if (stat?.isFile()) return { path, size: stat.size };
  }

  async function text(experimentId: string, runId: string, name: string) {
    const target = await file(experimentId, runId, name);
    if (!target) return;
    if (target.size > 2 * 1024 * 1024) throw new Error(`${name} 超出页面预览大小，仍可打开原始文件`);
    return readFile(target.path, 'utf8');
  }

  async function result(experimentId: ExperimentId, runId: string): Promise<ExperimentResult | undefined> {
    try {
      const input = await text(experimentId, runId, 'result.json');
      if (!input) return;
      const value = JSON.parse(input) as ExperimentResult;
      if (value?.experimentId !== experimentId || value.runId !== runId
        || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
        || !['PASS', 'FAIL', 'INCONCLUSIVE'].includes(value.status)
        || !Array.isArray(value.assertionResults) || !Array.isArray(value.evidencePaths)) return;
      return value;
    } catch { return; }
  }

  return {
    file,
    async list(): Promise<RunSummary[]> {
      const runs: RunSummary[] = [];
      if (!(await info(root))?.isDirectory()) return runs;
      for (const experimentId of experimentIds) {
        const directory = join(root, experimentId);
        if (!(await info(directory))?.isDirectory()) continue;
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        const ids = entries.filter(entry => entry.isDirectory() && runPattern.test(entry.name))
          .map(entry => entry.name).sort().reverse().slice(0, 100);
        for (const runId of ids) {
          const entry = await result(experimentId, runId);
          if (entry) runs.push({ experimentId, runId, startedAt: entry.startedAt, status: entry.status });
        }
      }
      return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
    async detail(experimentId: string, runId: string): Promise<RunDetail | undefined> {
      if (!isExperiment(experimentId)) return;
      const run = await result(experimentId, runId);
      if (!run) return;
      const [lines, metadataText, ...available] = await Promise.all([
        text(experimentId, runId, 'events.jsonl'), text(experimentId, runId, 'metadata.json'),
        ...files.map(async name => await file(experimentId, runId, name) ? name : undefined),
      ]);
      let metadata: unknown = null;
      try { if (metadataText) metadata = JSON.parse(metadataText); } catch { /* 原文仍可访问。 */ }
      let invalidLines = 0;
      const events = (lines ?? '').split(/\r?\n/).flatMap((line, index) => {
        if (!line.trim()) return [];
        const event = evidenceEvent(line, index + 1);
        if (event) return [event];
        invalidLines++;
        return [];
      });
      return { result: run, metadata, events, invalidLines, files: available.filter(name => name !== undefined) };
    },
  };
}
