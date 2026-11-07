/** Owns committed version chains and resolves point reads at a commit boundary. */
import type {
  CommitSeq, TransactionId, TransactionReadResult, VersionData, VersionId,
} from '../../contracts/transaction.ts';

export type CommittedVersion = Readonly<{
  key: string;
  versionId: VersionId;
  creatorTxn: TransactionId;
  commitSeq: CommitSeq;
  data: VersionData;
}>;

export class VersionStore {
  private readonly chains = new Map<string, CommittedVersion[]>();

  /** 引擎按提交顺序追加版本，同一次提交在一个键上只发布一个版本。 */
  append(version: CommittedVersion): void {
    let chain = this.chains.get(version.key);
    if (!chain) {
      chain = [];
      this.chains.set(version.key, chain);
    }
    chain.push(version);
  }

  visible(key: string, viewSeq: CommitSeq): CommittedVersion | undefined {
    const chain = this.chains.get(key);
    if (!chain) return undefined;
    for (let index = chain.length - 1; index >= 0; index--) {
      if (chain[index].commitSeq <= viewSeq) return chain[index];
    }
    return undefined;
  }
}

export function readValue(data: VersionData | undefined): TransactionReadResult {
  return data && !data.tombstone ? { found: true, value: data.value } : { found: false };
}
