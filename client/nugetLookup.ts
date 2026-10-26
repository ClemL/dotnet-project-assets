// nuget.org flat-container lookups with a 7-day localStorage cache.
// Only package Ids are sent; file contents never leave the browser.

import { mapWithConcurrency } from '../lib/concurrency';
import type { IdKey, NugetLookup } from '../lib/types';
import { versionKey } from '../lib/version';
import { browserStore, keysWithPrefix, readJson, removeKey, STORAGE_PREFIX, type KeyValueStore } from './storage';

export const LOOKUP_CONCURRENCY = 8;
export const LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'nuget:';

export function flatContainerUrl(id: string): string {
  return `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id.toLowerCase())}/index.json`;
}

export interface LookupCache {
  /** Fresh (non-expired) cached result, if any. */
  get(id: IdKey): NugetLookup | undefined;
  set(id: IdKey, value: NugetLookup): void;
  clear(): void;
}

type Cached = Exclude<NugetLookup, { status: 'error' }>;

export function createLookupCache(store: KeyValueStore | undefined = browserStore(), now: () => number = Date.now, ttlMs = LOOKUP_TTL_MS): LookupCache {
  const prune = (all: boolean) => {
    const entries = keysWithPrefix(CACHE_PREFIX, store).map((k) => ({ k, at: readJson<Cached | null>(k, null, store)?.fetchedAt ?? 0 }));
    entries.sort((a, b) => a.at - b.at);
    const cutoff = now() - ttlMs;
    const expired = entries.filter((e) => e.at < cutoff);
    const victims = expired.length > 0 && !all ? expired : entries.slice(0, Math.max(1, Math.ceil(entries.length / 4)));
    for (const v of victims) removeKey(v.k, store);
  };
  return {
    get(id) {
      const v = readJson<Cached | null>(CACHE_PREFIX + id, null, store);
      if (!v || typeof v.fetchedAt !== 'number' || now() - v.fetchedAt > ttlMs) return undefined;
      return v;
    },
    set(id, value) {
      if (value.status === 'error' || !store) return;
      const raw = JSON.stringify(value);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          store.setItem(STORAGE_PREFIX + CACHE_PREFIX + id, raw);
          return;
        } catch {
          // Quota exceeded: drop expired entries first, then the oldest quarter.
          prune(attempt > 0);
        }
      }
    },
    clear() {
      for (const k of keysWithPrefix(CACHE_PREFIX, store)) removeKey(k, store);
    },
  };
}

export type FetchFn = (url: string, init?: { signal?: AbortSignal; credentials?: 'omit'; referrerPolicy?: 'no-referrer' }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function fetchLookup(id: IdKey, fetchFn: FetchFn, now: () => number = Date.now, signal?: AbortSignal): Promise<NugetLookup> {
  try {
    const res = await fetchFn(flatContainerUrl(id), { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 404) return { status: 'notFound', fetchedAt: now() };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
    const body = (await res.json()) as { versions?: unknown };
    const versions = Array.isArray(body.versions) ? body.versions.filter((v): v is string => typeof v === 'string').map(versionKey) : [];
    return { status: 'found', versions, fetchedAt: now() };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Fresh cached results for `ids`; no network. */
export function cachedLookups(ids: readonly IdKey[], cache: LookupCache): Record<IdKey, NugetLookup> {
  const out: Record<IdKey, NugetLookup> = {};
  for (const id of ids) {
    const v = cache.get(id);
    if (v) out[id] = v;
  }
  return out;
}

export interface RunLookupsOptions {
  fetchFn: FetchFn;
  cache: LookupCache;
  concurrency?: number;
  now?: () => number;
  signal?: AbortSignal;
  /** Called once per Id as soon as its result is known (cached or fetched). */
  onResult?: (id: IdKey, result: NugetLookup, fromCache: boolean) => void;
}

/** Resolves every Id from the cache or the network, at most `concurrency` requests at a time. */
export async function runLookups(ids: readonly IdKey[], opts: RunLookupsOptions): Promise<Record<IdKey, NugetLookup>> {
  const now = opts.now ?? Date.now;
  const results: Record<IdKey, NugetLookup> = {};
  const misses: IdKey[] = [];
  for (const id of new Set(ids)) {
    const cached = opts.cache.get(id);
    if (cached) {
      results[id] = cached;
      opts.onResult?.(id, cached, true);
    } else {
      misses.push(id);
    }
  }
  await mapWithConcurrency(
    misses,
    opts.concurrency ?? LOOKUP_CONCURRENCY,
    async (id) => {
      const r = await fetchLookup(id, opts.fetchFn, now, opts.signal);
      opts.cache.set(id, r);
      results[id] = r;
      opts.onResult?.(id, r, false);
    },
    opts.signal,
  );
  return results;
}
