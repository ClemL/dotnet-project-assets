// Package source metadata: .nupkg.metadata files, global-packages-folder paths, bundled source maps,
// source-kind detection, and nuget.org proxy detection.

import { splitPath } from './paths';
import type { SourceMap } from './types';
import { parseVersion, versionKey } from './versions';

export const NUGET_ORG_V3 = 'https://api.nuget.org/v3/index.json';

const NUGET_ORG_SOURCES = new Set([NUGET_ORG_V3, 'https://www.nuget.org/api/v2', 'https://nuget.org/api/v2']);

export type SourceKind = 'nugetOrg' | 'internalFeed' | 'local' | 'otherRemote';

/** Comparable form of a feed URL or path: lowercase, forward slashes, no trailing slash. */
export function normalizeSource(source: string): string {
  return source.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

export function isNugetOrg(source: string): boolean {
  return NUGET_ORG_SOURCES.has(normalizeSource(source));
}

/** Visual Studio's offline package folder, which VS adds to every project's sources. */
export function isVsOfflineSource(source: string): boolean {
  return normalizeSource(source).includes('microsoft sdks/nugetpackages');
}

export function classifySource(source: string, internalFeeds: string[]): SourceKind {
  if (isNugetOrg(source)) return 'nugetOrg';
  const n = normalizeSource(source);
  if (internalFeeds.some((f) => normalizeSource(f) === n)) return 'internalFeed';
  return isRemoteSource(source) ? 'otherRemote' : 'local';
}

export function metadataKey(id: string, version: string): string {
  return `${id.toLowerCase()}/${versionKey(version)}`;
}

export type NupkgMetadataResult = { ok: true; source: string; contentHash?: string } | { ok: false; error: string };

/** Parses a .nupkg.metadata body: { "version": 2, "contentHash": "…", "source": "…" }. Unknown fields are ignored. */
export function parseNupkgMetadata(text: string): NupkgMetadataResult {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'Expected a JSON object.' };
  const obj = value as Record<string, unknown>;
  if (typeof obj.source !== 'string' || obj.source.trim() === '') return { ok: false, error: 'Missing "source".' };
  return { ok: true, source: obj.source.trim(), contentHash: typeof obj.contentHash === 'string' ? obj.contentHash : undefined };
}

/**
 * Derives the package key from a global-packages-folder path ending in
 * "<id>/<version>/.nupkg.metadata". Returns null for any other path.
 */
export function parsePackagesFolderPath(relPath: string): { key: string; id: string; version: string } | null {
  const segs = splitPath(relPath);
  const n = segs.length;
  if (n < 3 || segs[n - 1] !== '.nupkg.metadata') return null;
  const id = segs[n - 3] as string;
  const version = segs[n - 2] as string;
  if (!parseVersion(version)) return null;
  return { key: metadataKey(id, version), id: id.toLowerCase(), version: versionKey(version) };
}

/** Parses a bundled map { "<id-lower>/<version>": "<source>" }. Keys are re-normalized; bad entries are counted. */
export function parseSourceMap(text: string): { ok: true; map: SourceMap; invalid: number } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'Expected a JSON object.' };
  const map: SourceMap = {};
  let invalid = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const slash = k.indexOf('/');
    if (slash <= 0 || typeof v !== 'string' || v.trim() === '' || !parseVersion(k.slice(slash + 1))) {
      invalid++;
      continue;
    }
    map[metadataKey(k.slice(0, slash), k.slice(slash + 1))] = v.trim();
  }
  return { ok: true, map, invalid };
}

/** Internal-feed suggestions: restore sources minus nuget.org and Visual Studio's offline folder. */
export function suggestInternalFeeds(sources: string[]): string[] {
  const seen = new Map<string, string>();
  for (const s of sources) {
    if (isNugetOrg(s) || isVsOfflineSource(s)) continue;
    const n = normalizeSource(s);
    if (!seen.has(n)) seen.set(n, s.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
