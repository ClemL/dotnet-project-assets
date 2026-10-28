// Origin classification.
//
// Order, first match wins:
//   manual override
//   0. source metadata for this exact Id+version (nuget.org → Public/System, internal feed → Private;
//      local paths and unconfigured feeds fall through with a note)
//   1. type: project            → Project
//   2. system prefix            → System
//   3. internal prefix          → Private
//   4. package signature        → .signature.p7s in libraries[*].files: Public (nuget.org repository-signs
//                                 every package); none: Private (inferred), since internal feeds serve
//                                 unsigned packages. Skipped when the assets file has no files list.
//   5. nuget.org flat container → Public / Private (inferred); offline → Unclassified

import { classifySource, isNugetOrg, isRemoteSource, metadataKey, normalizeSource } from './metadata';
import type {
  Classification,
  ClassifyInput,
  ClassifyOutput,
  ClassifySettings,
  IdClassification,
  IdKey,
  Origin,
  PackageRef,
  PrefixSuggestion,
  ProxyWarning,
} from './types';
import { versionKey } from './versions';

export const DEFAULT_SYSTEM_PREFIXES: readonly string[] = ['System.', 'Microsoft.', 'runtime.', 'NETStandard.', 'Microsoft.NETCore.'];

export const DEFAULT_SETTINGS: ClassifySettings = {
  systemPrefixes: [...DEFAULT_SYSTEM_PREFIXES],
  internalPrefixes: [],
  internalFeeds: [],
  offline: false,
  trustProxyFeedMetadata: false,
};

export const ORIGIN_LABELS: Record<Origin, string> = {
  Project: 'Project',
  System: 'System',
  Private: 'Private',
  PrivateInferred: 'Private (inferred)',
  Public: 'Public',
  Unclassified: 'Unclassified',
};

/** Roll-up precedence when versions of one Id disagree: the most internal origin wins. */
const ORIGIN_RANK: Record<Origin, number> = { Project: 0, Private: 1, PrivateInferred: 2, System: 3, Public: 4, Unclassified: 5 };

export function isInternalOrigin(origin: Origin): boolean {
  return origin === 'Project' || origin === 'Private' || origin === 'PrivateInferred';
}

/** Longest case-insensitive prefix of `id` among `prefixes`. */
export function matchPrefix(id: string, prefixes: readonly string[]): string | undefined {
  const lower = id.toLowerCase();
  let best: string | undefined;
  for (const p of prefixes) {
    const t = p.trim();
    if (t === '' || !lower.startsWith(t.toLowerCase())) continue;
    if (!best || t.length > best.length) best = t;
  }
  return best;
}

interface Context {
  settings: ClassifySettings;
  lookups: ClassifyInput['lookups'];
  metadata: ClassifyInput['metadata'];
  overrides: ClassifyInput['overrides'];
  /** Normalized feed whose metadata is being ignored because it proxies nuget.org. */
  ignoredFeed?: string;
}

interface Outcome {
  classification: Classification;
  /** The package got as far as the nuget.org step. */
  reachedLookup: boolean;
}

function classifyOne(pkg: PackageRef, ctx: Context): Outcome {
  const { settings } = ctx;
  const override = ctx.overrides[pkg.key];
  if (override) return { classification: { origin: override, code: 'override', reason: 'manual override' }, reachedLookup: false };

  const notes: string[] = [];
  const source = pkg.types.includes('package') && !pkg.isRootProject ? ctx.metadata[metadataKey(pkg.id, pkg.version)] : undefined;
  if (source !== undefined) {
    const kind = classifySource(source, settings.internalFeeds);
    if (kind === 'nugetOrg') {
      const sys = matchPrefix(pkg.id, settings.systemPrefixes);
      return {
        classification: sys
          ? { origin: 'System', code: 'metadata-system', reason: `metadata: ${source}; system prefix: ${sys}` }
          : { origin: 'Public', code: 'metadata-public', reason: `metadata: ${source}` },
        reachedLookup: false,
      };
    }
    if (kind === 'internalFeed') {
      if (ctx.ignoredFeed !== undefined && normalizeSource(source) === ctx.ignoredFeed) {
        notes.push(`metadata: ${source} (ignored: feed proxies nuget.org)`);
      } else {
        return { classification: { origin: 'Private', code: 'metadata-internal-feed', reason: `metadata: ${source}` }, reachedLookup: false };
      }
    } else if (kind === 'local') {
      notes.push(`metadata: ${source} (local source)`);
    } else {
      notes.push(`metadata: ${source} (unconfigured feed)`);
    }
  }

  const done = (origin: Origin, code: Classification['code'], reason: string, reachedLookup = false): Outcome => ({
    classification: { origin, code, reason: [...notes, reason].join('; ') },
    reachedLookup,
  });

  if (pkg.types.includes('project')) return done('Project', 'project', 'type: project');
  const sys = matchPrefix(pkg.id, settings.systemPrefixes);
  if (sys) return done('System', 'system-prefix', `system prefix: ${sys}`);
  const internal = matchPrefix(pkg.id, settings.internalPrefixes);
  if (internal) return done('Private', 'internal-prefix', `internal prefix: ${internal}`);
  if (pkg.signed === true) return done('Public', 'signature-signed', 'repository-signed (.signature.p7s) → public');
  if (pkg.signed === false) return done('PrivateInferred', 'signature-unsigned', 'unsigned → internal');
  if (settings.offline) return done('Unclassified', 'offline', 'offline mode: no prefix rule matched', true);

  const lookup = ctx.lookups[pkg.key];
  if (!lookup) return done('Unclassified', 'nuget-pending', 'nuget.org: not looked up yet', true);
  switch (lookup.status) {
    case 'found': {
      const v = versionKey(pkg.version);
      return lookup.versions.includes(v)
        ? done('Public', 'nuget-listed', `nuget.org: ${pkg.version} listed`, true)
        : done('PrivateInferred', 'nuget-unlisted-version', `nuget.org: Id exists but ${pkg.version} is not listed`, true);
    }
    case 'notFound':
      return done('PrivateInferred', 'nuget-not-found', 'nuget.org: 404 (Id not found)', true);
    case 'error':
      return done('Unclassified', 'nuget-error', `nuget.org lookup failed: ${lookup.message}`, true);
  }
}

/**
 * Detects a feed that proxies nuget.org: every public-looking package (System/Public by the
 * prefix and lookup rules alone) with remote source metadata reports the same non-nuget.org feed.
 */
export function detectProxyFeed(input: ClassifyInput): ProxyWarning | undefined {
  const bare: Context = { settings: input.settings, lookups: input.lookups, metadata: {}, overrides: {} };
  const feeds = new Map<string, { source: string; count: number }>();
  let sawNugetOrg = false;
  for (const pkg of input.packages) {
    if (pkg.isRootProject || !pkg.types.includes('package')) continue;
    const source = input.metadata[metadataKey(pkg.id, pkg.version)];
    if (source === undefined || !isRemoteSource(source)) continue;
    const base = classifyOne(pkg, bare).classification.origin;
    if (base !== 'System' && base !== 'Public') continue;
    if (isNugetOrg(source)) {
      sawNugetOrg = true;
      break;
    }
    const n = normalizeSource(source);
    const entry = feeds.get(n) ?? { source, count: 0 };
    entry.count++;
    feeds.set(n, entry);
  }
  if (sawNugetOrg || feeds.size !== 1) return undefined;
  const [entry] = [...feeds.values()] as [{ source: string; count: number }];
  const ignored = !input.settings.trustProxyFeedMetadata && classifySource(entry.source, input.settings.internalFeeds) === 'internalFeed';
  return { feed: entry.source, publicLookingCount: entry.count, ignored };
}

export function classifyAll(input: ClassifyInput): ClassifyOutput {
  const proxyWarning = detectProxyFeed(input);
  const ctx: Context = {
    settings: input.settings,
    lookups: input.lookups,
    metadata: input.metadata,
    overrides: input.overrides,
    ignoredFeed: proxyWarning?.ignored ? normalizeSource(proxyWarning.feed) : undefined,
  };

  const byPackage: Record<string, Classification> = {};
  const grouped = new Map<IdKey, { version: string; c: Classification }[]>();
  const candidates = new Set<IdKey>();
  let withMetadata = 0;
  let total = 0;

  for (const pkg of input.packages) {
    const { classification, reachedLookup } = classifyOne(pkg, ctx);
    const k = metadataKey(pkg.id, pkg.version);
    byPackage[k] = classification;
    const list = grouped.get(pkg.key) ?? [];
    list.push({ version: pkg.version, c: classification });
    grouped.set(pkg.key, list);
    if (reachedLookup) candidates.add(pkg.key);
    if (!pkg.isRootProject && pkg.types.includes('package')) {
      total++;
      if (input.metadata[k] !== undefined) withMetadata++;
    }
  }

  const byId: Record<IdKey, IdClassification> = {};
  for (const [key, list] of grouped) {
    const origins = new Set(list.map((x) => x.c.origin));
    const origin = [...origins].sort((a, b) => ORIGIN_RANK[a] - ORIGIN_RANK[b])[0] as Origin;
    byId[key] = {
      origin,
      mixed: origins.size > 1,
      // One line when every version has the same reason, otherwise one line per version.
      reasons: new Set(list.map((x) => x.c.reason)).size === 1 ? [list[0]?.c.reason ?? ''] : list.map((x) => `${x.version}: ${x.c.reason}`),
    };
  }

  return {
    byPackage,
    byId,
    proxyWarning,
    coverage: { withMetadata, total },
    lookupCandidates: [...candidates].sort(),
  };
}

/** Suggests internal prefixes from project names: the first dot-segment, skipping system prefixes. */
export function suggestInternalPrefixes(projectIds: string[], systemPrefixes: readonly string[]): PrefixSuggestion[] {
  const groups = new Map<string, { prefix: string; ids: Map<string, string> }>();
  for (const id of projectIds) {
    const dot = id.indexOf('.');
    if (dot <= 0 || matchPrefix(id, systemPrefixes)) continue;
    const prefix = id.slice(0, dot + 1);
    const k = prefix.toLowerCase();
    const g = groups.get(k) ?? { prefix, ids: new Map<string, string>() };
    if (!g.ids.has(id.toLowerCase())) g.ids.set(id.toLowerCase(), id);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => ({ prefix: g.prefix, count: g.ids.size, examples: [...g.ids.values()].sort().slice(0, 3) }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix))
    .slice(0, 10);
}
