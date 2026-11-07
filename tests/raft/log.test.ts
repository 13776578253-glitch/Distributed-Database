/** Exercises index translation without invoking Raft or persistence. */
import { expect, it } from 'vitest';
import { RaftLog } from '../../src/raft/core/log.ts';
import type { Entry } from '../../src/raft/core/types.ts';

const entry = (term: number): Entry => ({ term, command: { type: 'noop' } });

it('addresses and pages retained entries by absolute index beyond a non-zero base', () => {
  const log = new RaftLog([entry(3), entry(3), entry(4)], 40, 3);
  expect(log.lastIndex).toBe(43);
  expect(log.termAt(39)).toBeUndefined();
  expect(log.termAt(40)).toBe(3);
  expect(log.entryAt(40)).toBeUndefined();
  expect(log.entryAt(43)).toEqual(entry(4));
  expect(log.termAt(44)).toBeUndefined();
  expect(log.entriesFrom(42, 1)).toEqual([entry(3)]);
  expect(log.entriesFrom(44)).toEqual([]);
  expect(log.firstIndexOfTerm(42)).toBe(41);
  expect(log.firstIndexOfTerm(43)).toBe(43);
});

it('replaces and appends an absolute suffix without renumbering its prefix', () => {
  const log = new RaftLog([entry(3), entry(4), entry(4)], 40, 2);
  log.replaceSuffix(42, [entry(5)]);
  expect(log.lastIndex).toBe(42);
  expect(log.termAt(41)).toBe(3);
  expect(log.termAt(42)).toBe(5);
  log.replaceSuffix(43, [entry(6)]);
  expect(log.entriesFrom(41)).toEqual([entry(3), entry(5), entry(6)]);
  const empty = new RaftLog([], 40, 2);
  expect(empty.lastIndex).toBe(40);
  expect(empty.termAt(empty.lastIndex)).toBe(2);
});
