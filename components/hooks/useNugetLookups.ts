'use client';

import { useCallback, useRef, useState } from 'react';
import { cachedLookups, createLookupCache, runLookups, type LookupCache } from '@/client/nugetLookup';
import type { IdKey, NugetLookup } from '@/lib/types';

export interface LookupStatus {
  running: boolean;
  done: number;
  total: number;
  errors: number;
  cancelled?: boolean;
}

/** Runs nuget.org lookups and streams results to `onResults` in batches (every 300 ms). */
export function useNugetLookups(onResults: (batch: Record<IdKey, NugetLookup>) => void) {
  const [status, setStatus] = useState<LookupStatus | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<LookupCache | null>(null);
  const cache = useCallback(() => (cacheRef.current ??= createLookupCache()), []);

  const run = useCallback(
    async (ids: IdKey[]) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      let done = 0;
      let errors = 0;
      let buffer: Record<IdKey, NugetLookup> = {};
      const flush = (running: boolean, cancelled = false) => {
        if (Object.keys(buffer).length > 0) {
          onResults(buffer);
          buffer = {};
        }
        setStatus({ running, done, total: ids.length, errors, cancelled });
      };
      setStatus({ running: true, done: 0, total: ids.length, errors: 0 });
      const timer = setInterval(() => flush(true), 300);
      let cancelled = false;
      try {
        await runLookups(ids, {
          fetchFn: (url, init) => fetch(url, init),
          cache: cache(),
          signal: ac.signal,
          onResult: (id, r) => {
            buffer[id] = r;
            done++;
            if (r.status === 'error') errors++;
          },
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') cancelled = true;
        else throw e;
      } finally {
        clearInterval(timer);
        flush(false, cancelled);
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [cache, onResults],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const cached = useCallback((ids: IdKey[]) => cachedLookups(ids, cache()), [cache]);
  const clearCache = useCallback(() => cache().clear(), [cache]);

  return { status, run, cancel, cached, clearCache };
}
