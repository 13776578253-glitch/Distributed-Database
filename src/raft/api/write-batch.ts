/** Groups concurrent HTTP writes before submitting one local Raft log transaction. */
import type { RaftNode } from '../core/node.ts';
import type { ClientReply, WriteOperation } from '../core/types.ts';

const maxEntries = 64;
const maxDelayMs = 5;
type QueuedWrite = { command: WriteOperation; resolve: (reply: Promise<ClientReply>) => void };

/** 队列属于 HTTP 入口，Raft Core 仍负责持久化、提交与逐条应答。 */
export function batchWrites(node: RaftNode, flush: () => void) {
  let pending: QueuedWrite[] = [];
  let term = 0;
  let timer: NodeJS.Timeout;

  function submit() {
    clearTimeout(timer);
    const batch = pending;
    pending = [];
    const before = node.status();
    const replies = node.executeWrites(batch.map(write => write.command), performance.now(), term);
    if (before.role === 'leader' && before.term === term) {
      console.log(JSON.stringify({
        kind: 'raft.write.batch', nodeId: before.nodeId, term, size: batch.length,
        firstIndex: before.logLength + 1, lastIndex: before.logLength + batch.length,
      }));
    }
    for (const [offset, write] of batch.entries()) write.resolve(replies[offset]);
    flush();
  }

  return (command: WriteOperation): Promise<ClientReply> => {
    const status = node.status();
    if (status.role !== 'leader') return node.execute(command, performance.now());
    if (pending.length > 0 && term !== status.term) submit();
    return new Promise(resolve => {
      if (pending.length === 0) {
        term = status.term;
        timer = setTimeout(submit, maxDelayMs);
      }
      pending.push({ command, resolve });
      if (pending.length === maxEntries) submit();
    });
  };
}
