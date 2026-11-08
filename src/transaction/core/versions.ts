/** In-memory committed version chains resolved by commit boundary. */
import type {
  CommitSeq, TransactionId, TransactionReadResult, VersionData, VersionId,
} from '../../contracts/transaction.ts';

/** 一条已提交版本；commitSeq 是可见性边界，versionId 只标识写尝试。 */
export type CommittedVersion = Readonly<{
  key: string;
  versionId: VersionId;
  creatorTxn: TransactionId;
  commitSeq: CommitSeq;
  data: VersionData;
}>;

export class VersionStore {
  private readonly chains = new Map<string, CommittedVersion[]>();

  /** 链按 commitSeq 单调追加；同一提交、同一键只应发布最后一条写。 */
  append(version: CommittedVersion): void {
    let chain = this.chains.get(version.key);
    if (!chain) {
      chain = [];
      this.chains.set(version.key, chain);
    }
    chain.push(version);
  }

  /** 返回 commitSeq <= viewSeq 的最新版本；viewSeq 本身可读。 */
  visible(key: string, viewSeq: CommitSeq): CommittedVersion | undefined {
    const chain = this.chains.get(key);
    if (!chain) return undefined;
    for (let index = chain.length - 1; index >= 0; index--) {
      if (chain[index].commitSeq <= viewSeq) return chain[index];
    }
    return undefined;
  }
}

/** 墓碑和缺失都得到一个 found:false；调用方不能区分“删除过”和“从未存在”。 */
export function readValue(data: VersionData | undefined): TransactionReadResult {
  return data && !data.tombstone ? { found: true, value: data.value } : { found: false };
}
