import { describe, expect, it } from 'vitest';
import { cachedLookups, createLookupCache, flatContainerUrl, LOOKUP_TTL_MS, runLookups, type FetchFn } from '../client/nugetLookup';
import { createMemoryStore } from '../client/storage';
import { mapWithConcurrency } from '../lib/concurrency';

function fakeFetch(table: Record<string, { status: number; versions?: string[] }>, log: string[] = [], delayMs = 5) {
  let inFlight = 0;
  let maxInFlight = 0;
  const fn: FetchFn = async (url) => {
    log.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    const id = /flatcontainer\/([^/]+)\/index\.json$/.exec(url)?.[1] ?? '';
    const row = table[decodeURIComponent(id)] ?? { status: 404 };
    return { ok: row.status >= 200 && row.status < 300, status: row.status, json: async () => ({ versions: row.versions ?? [] }) };
  };
  return { fn, maxInFlight: () => maxInFlight };
}

describe('nuget.org lookups', () => {
  it('builds lowercase flat-container URLs', () => {
    expect(flatContainerUrl('Newtonsoft.Json')).toBe('https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json');
  });

  it('caps concurrency at 8 and maps 200/404/5xx', async () => {
    const table: Record<string, { status: number; versions?: string[] }> = {};
    const ids = Array.from({ length: 30 }, (_, i) => `pkg${i}`);
    for (const id of ids) table[id] = { status: 200, versions: ['1.0.0', '2.0.0-Beta'] };
    table.pkg1 = { status: 404 };
    table.pkg2 = { status: 503 };
    const fake = fakeFetch(table);
    const results = await runLookups(ids, { fetchFn: fake.fn, cache: createLookupCache(createMemoryStore()) });
    expect(fake.maxInFlight()).toBe(8);
    expect(results.pkg0).toMatchObject({ status: 'found', versions: ['1.0.0', '2.0.0-beta'] });
    expect(results.pkg1).toMatchObject({ status: 'notFound' });
    expect(results.pkg2).toEqual({ status: 'error', message: 'HTTP 503' });
  });

  it('caches found and 404 results for 7 days but never errors', async () => {
    const store = createMemoryStore();
    let t = 1_000_000;
    const cache = createLookupCache(store, () => t);
    const log: string[] = [];
    const fake = fakeFetch({ a: { status: 200, versions: ['1.0.0'] }, c: { status: 500 } }, log, 0);
    await runLookups(['a', 'b', 'c'], { fetchFn: fake.fn, cache, now: () => t });
    expect(log.length).toBe(3);
    expect(Object.keys(cachedLookups(['a', 'b', 'c'], cache)).sort()).toEqual(['a', 'b']);

    log.length = 0;
    await runLookups(['a', 'b', 'c'], { fetchFn: fake.fn, cache, now: () => t });
    expect(log).toEqual(['https://api.nuget.org/v3-flatcontainer/c/index.json']);

    t += LOOKUP_TTL_MS + 1;
    expect(cachedLookups(['a', 'b'], cache)).toEqual({});
  });

  it('survives storage that throws', async () => {
    const broken = createMemoryStore();
    broken.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    const fake = fakeFetch({ a: { status: 200, versions: ['1.0.0'] } }, [], 0);
    const r = await runLookups(['a'], { fetchFn: fake.fn, cache: createLookupCache(broken) });
    expect(r.a?.status).toBe('found');
  });

  it('mapWithConcurrency keeps input order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });
});
