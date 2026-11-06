/** Same-origin JSON access for console pages. */
import { useEffect, useState } from 'react';

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return json(await fetch(path, { cache: 'no-store', signal }));
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return json(await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

export function usePolling<T>(path: string, interval: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await getJson<T>(path, AbortSignal.any([stop.signal, AbortSignal.timeout(4000)]));
        if (!stop.signal.aborted) { setData(value); setError(''); }
      } catch (failure) {
        if (!stop.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!stop.signal.aborted) timer = setTimeout(poll, interval);
      }
    }
    void poll();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [path, interval]);
  return { data, error };
}
