/** Maps absolute Raft indexes to entries after a logical log base. */
import type { Entry } from './types.ts';

export class RaftLog {
  readonly baseIndex: number;
  readonly baseTerm: number;
  private readonly entries: Entry[];

  /** entries[0] 对应 baseIndex + 1，基址只保留任期。 */
  constructor(entries: Entry[], baseIndex = 0, baseTerm = 0) {
    this.entries = entries;
    this.baseIndex = baseIndex;
    this.baseTerm = baseTerm;
  }

  get lastIndex(): number {
    return this.baseIndex + this.entries.length;
  }

  entryAt(index: number): Entry | undefined {
    return this.entries[index - this.baseIndex - 1];
  }

  termAt(index: number): number | undefined {
    return index === this.baseIndex ? this.baseTerm : this.entryAt(index)?.term;
  }

  /** 从指定绝对索引取最多 count 条保留日志。 */
  entriesFrom(index: number, count = this.entries.length): Entry[] {
    const offset = Math.max(0, index - this.baseIndex - 1);
    return this.entries.slice(offset, offset + count);
  }

  /** 在保留日志中回退到 index 所在连续任期的首索引。 */
  firstIndexOfTerm(index: number): number {
    const term = this.termAt(index);
    while (index > this.baseIndex + 1 && this.termAt(index - 1) === term) index--;
    return index;
  }

  /** first 位于保留后缀或下一条追加位置，调用者已经完成持久化。 */
  replaceSuffix(first: number, entries: Entry[]) {
    this.entries.length = first - this.baseIndex - 1;
    for (const entry of entries) this.entries.push(entry);
  }
}
