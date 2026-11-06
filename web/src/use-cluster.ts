/** Polls the observer and keeps only the latest view and last-seen times. */
import { useEffect, useState } from 'react';
import type { ClusterObservation } from '../../src/contracts/observation.ts';

interface ClusterView {
  snapshot: ClusterObservation | null;
  lastSeen: Record<string, string>;
  error: boolean;
}

export function useCluster(interval: number, revision: number) {
  const [view, setView] = useState<ClusterView>({ snapshot: null, lastSeen: {}, error: false });

  useEffect(() => {
    const stop = new AbortController();
    let next: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch('/api/cluster', {
          cache: 'no-store',
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error(`Observer HTTP ${response.status}`);
        const snapshot: ClusterObservation = await response.json();
        if (stop.signal.aborted) return;
        setView(previous => {
          const lastSeen = { ...previous.lastSeen };
          for (const node of snapshot.nodes) {
            if (node.ok) lastSeen[node.nodeId] = node.observedAt;
          }
          return { snapshot, lastSeen, error: false };
        });
      } catch {
        if (!stop.signal.aborted) setView(previous => ({ ...previous, snapshot: null, error: true }));
      } finally {
        // 本轮结束后再安排下一次请求，避免并发刷新覆盖较新的采样。
        if (!stop.signal.aborted && interval > 0) next = setTimeout(poll, interval);
      }
    }
    void poll();
    return () => {
      stop.abort();
      clearTimeout(next);
    };
  }, [interval, revision]);

  return view;
}
