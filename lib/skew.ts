// Version skew: stale internal builds. A parent package declares a dependency with a requested
// version (the range's lower bound); when that is older than the version that actually resolves, the
// parent was compiled against an older build of the child than the one that ships.
//
// Edges come from targets[tfm][P].dependencies (transitive) and project.frameworks[tfm].dependencies
// (direct references of the root project). Ids match case-insensitively throughout. The rebuild plan
// orders the stale parents, plus their internal consumers when cascading, with the existing
// collapsed-graph topological sort.

import { isInternalOrigin } from './classify';
import { analyzeFloating } from './floating';
import { collapseToInternal, computeBuildOrder } from './graph';
import type {
  CasingNote,
  ConsumerRow,
  FloatingReport,
  IdKey,
  MergedGraph,
  Origin,
  ProjectModel,
  RebuildPlan,
  RebuildStep,
  RequestedGroup,
  Severity,
  SkewEdge,
  SkewReport,
  SkewRow,
  SkewSettings,
  TargetGraph,
  VersionDiff,
} from './types';
import { compareVersionStrings, compileBuildPattern, DEFAULT_BUILD_PATTERN, extractBuildNumber, normalizeVersion, requestedVersion, versionDiff } from './versions';

export const DEFAULT_SKEW_SETTINGS: SkewSettings = {
  buildNumberPattern: DEFAULT_BUILD_PATTERN,
  thresholds: { low: 1, medium: 50, high: 200 },
  rebuildMinSeverity: 'medium',
  cascade: true,
  includePublic: false,
};

const SEVERITY_RANK: Record<Severity, number> = { none: 0, info: 1, low: 2, medium: 3, high: 4 };
const DIFF_RANK: Record<VersionDiff, number> = { equal: 0, build: 1, prerelease: 2, revision: 3, patch: 4, minor: 5, major: 6 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

const maxSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/**
 * Severity of a version distance: thresholds on the build lag; a major difference is high, a minor
 * difference medium, and a patch, revision, or prerelease-label difference low.
 */
export function severityFor(diff: VersionDiff, lag: number | null, t: SkewSettings['thresholds']): Severity {
  switch (diff) {
    case 'equal':
      return 'none';
    case 'major':
      return 'high';
    case 'minor':
      return 'medium';
    case 'build': {
      const n = lag ?? 0;
      return n >= t.high ? 'high' : n >= t.medium ? 'medium' : n >= t.low ? 'low' : 'none';
    }
    default:
      return 'low';
  }
}

const isInternal = (o: Origin | undefined) => o !== undefined && isInternalOrigin(o);

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface EdgeCollection {
  edges: SkewEdge[];
  /** childKey → spelling → where it was seen. */
  spellings: Map<IdKey, Map<string, Set<string>>>;
  skippedProjectChildren: number;
}

/** Direct references of a target: project.frameworks[tfm].dependencies, else the PackageReference roots. */
function directRefs(target: TargetGraph): { id: string; range: string }[] {
  if (target.declared.length > 0) return target.declared.map((d) => ({ id: d.id, range: d.range }));
  return target.roots.filter((r) => r.kind === 'packageReference').map((r) => ({ id: r.id, range: r.range }));
}

/**
 * Every parent → child edge in the non-RID targets of `models`, deduplicated across projects. Build
 * lags are computed only for internal children; public children use SemVer distance.
 */
export function collectSkewEdges(models: ProjectModel[], originOf: (key: IdKey) => Origin | undefined, re: RegExp, thresholds: SkewSettings['thresholds']): EdgeCollection {
  const byKey = new Map<string, SkewEdge>();
  const spellings = new Map<IdKey, Map<string, Set<string>>>();
  let skippedProjectChildren = 0;
  const spell = (key: IdKey, spelling: string, seenIn: string) => {
    const m = spellings.get(key) ?? new Map<string, Set<string>>();
    const set = m.get(spelling) ?? new Set<string>();
    set.add(seenIn);
    m.set(spelling, set);
    spellings.set(key, m);
  };

  for (const model of models) {
    for (const target of model.targets) {
      if (target.rid) continue;
      for (const node of Object.values(target.nodes)) spell(node.id.toLowerCase(), node.id, 'resolved');
      const add = (parent: string, parentVersion: string, childId: string, range: string, isDirect: boolean) => {
        const childKey = childId.toLowerCase();
        const child = target.nodes[childKey];
        if (!child) return; // pruned or not restored for this target
        spell(childKey, childId, parent);
        if (child.type === 'project') {
          skippedProjectChildren++;
          return;
        }
        const parentKey = parent.toLowerCase();
        const k = [target.key, childKey, child.version, parentKey, parentVersion, range, isDirect ? 'd' : 't'].join('\u0000');
        const existing = byKey.get(k);
        if (existing) {
          if (!existing.projects.includes(model.label)) existing.projects.push(model.label);
          return;
        }
        const childOrigin = originOf(childKey);
        const buildRe = isInternal(childOrigin) ? re : null;
        const requested = requestedVersion(range, child.version);
        const { diff, lag } = requested ? versionDiff(requested, child.version, buildRe) : { diff: 'equal' as VersionDiff, lag: null };
        const stale = requested !== undefined && compareVersionStrings(requested, child.version) < 0;
        byKey.set(k, {
          target: target.key,
          tfm: target.tfm,
          childKey,
          child: child.id,
          resolvedVersion: child.version,
          childOrigin,
          parentKey,
          parent,
          parentVersion,
          parentOrigin: originOf(parentKey),
          requestedRange: range,
          requestedVersion: requested,
          requestedBuild: requested && buildRe ? extractBuildNumber(requested, buildRe) : null,
          resolvedBuild: buildRe ? extractBuildNumber(child.version, buildRe) : null,
          diff,
          lag: stale ? lag : requested && diff === 'equal' ? 0 : null,
          stale,
          severity: stale ? severityFor(diff, lag, thresholds) : 'none',
          isDirect,
          isFloating: range.includes('*'),
          projects: [model.label],
        });
      };
      for (const node of Object.values(target.nodes)) {
        for (const [childId, range] of Object.entries(node.dependencies)) add(node.id, node.version, childId, range, false);
      }
      for (const d of directRefs(target)) {
        if (d.range.trim() !== '') add(model.projectName, model.projectVersion, d.id, d.range, true);
      }
    }
  }
  return { edges: [...byKey.values()], spellings, skippedProjectChildren };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** "<target>\0<childKey>" → resolved version → projects. */
type ResolvedBy = Map<string, Map<string, Set<string>>>;

function resolvedByProject(models: ProjectModel[]): ResolvedBy {
  const map: ResolvedBy = new Map();
  for (const m of models) {
    for (const t of m.targets) {
      if (t.rid) continue;
      for (const [key, node] of Object.entries(t.nodes)) {
        const k = `${t.key}\u0000${key}`;
        const versions = map.get(k) ?? new Map<string, Set<string>>();
        const projects = versions.get(node.version) ?? new Set<string>();
        projects.add(m.label);
        versions.set(node.version, projects);
        map.set(k, versions);
      }
    }
  }
  return map;
}

export const skewRowId = (target: string, childKey: IdKey, resolved: string) => `${target}|${childKey}|${resolved}`;

/** One row per (target, child, resolved version) with at least one stale edge, sorted by spread. */
export function buildSkewRows(edges: SkewEdge[], resolvedBy: ResolvedBy, re: RegExp | null, thresholds: SkewSettings['thresholds']): SkewRow[] {
  const groups = new Map<string, SkewEdge[]>();
  for (const e of edges) {
    const k = skewRowId(e.target, e.childKey, e.resolvedVersion);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  const rows: SkewRow[] = [];
  for (const [rowId, list] of groups) {
    const stale = list.filter((e) => e.stale);
    if (stale.length === 0) continue;
    const first = list[0] as SkewEdge;

    const byRequested = new Map<string, RequestedGroup>();
    for (const e of list) {
      const req = e.requestedVersion ?? '';
      const g = byRequested.get(req) ?? { requestedVersion: req, build: req && re ? extractBuildNumber(req, re) : null, requesters: [] };
      if (!g.requesters.some((r) => r.parentKey === e.parentKey && r.isDirect === e.isDirect && r.range === e.requestedRange)) {
        g.requesters.push({ parent: e.parent, parentKey: e.parentKey, isDirect: e.isDirect, range: e.requestedRange });
      }
      byRequested.set(req, g);
    }
    const sortedGroups = [...byRequested.values()].sort((a, b) => (a.requestedVersion === '' ? 1 : b.requestedVersion === '' ? -1 : compareVersionStrings(a.requestedVersion, b.requestedVersion)));
    for (const g of sortedGroups) g.requesters.sort((a, b) => Number(a.isDirect) - Number(b.isDirect) || a.parent.localeCompare(b.parent));

    const oldest = stale.map((e) => e.requestedVersion as string).sort(compareVersionStrings)[0] as string;
    const oldestEdges = stale.filter((e) => normalizeVersion(e.requestedVersion as string) === normalizeVersion(oldest));
    const { diff: spreadDiff, lag } = versionDiff(oldest, first.resolvedVersion, re);
    const spread = spreadDiff === 'build' ? lag : null;
    let severity = severityFor(spreadDiff, spread, thresholds);
    for (const e of stale) severity = maxSeverity(severity, e.severity);

    const versions = resolvedBy.get(`${first.target}\u0000${first.childKey}`) ?? new Map<string, Set<string>>();
    rows.push({
      rowId,
      target: first.target,
      tfm: first.tfm,
      childKey: first.childKey,
      child: first.child,
      origin: first.childOrigin,
      resolvedVersion: first.resolvedVersion,
      resolvedBuild: re ? extractBuildNumber(first.resolvedVersion, re) : null,
      groups: sortedGroups,
      edges: [...list].sort((a, b) => compareVersionStrings(a.requestedVersion ?? '', b.requestedVersion ?? '') || a.parent.localeCompare(b.parent)),
      oldestRequested: oldest,
      oldestRequesters: [...new Set(oldestEdges.map((e) => e.parent))].sort(),
      oldestRequesterKeys: [...new Set(oldestEdges.map((e) => e.parentKey))].sort(),
      spread,
      spreadDiff,
      severity,
      shippedBy: [...(versions.get(first.resolvedVersion) ?? [])].sort(),
      drift: [...versions.keys()].filter((v) => v !== first.resolvedVersion).sort(compareVersionStrings),
    });
  }
  // Spread descending; rows without a computable spread follow, major differences first.
  const sortKey = (r: SkewRow) => r.spread ?? (r.spreadDiff === 'major' ? Number.MAX_SAFE_INTEGER : -1);
  return rows.sort((a, b) => sortKey(b) - sortKey(a) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.child.localeCompare(b.child) || a.target.localeCompare(b.target));
}

// ---------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** One row per internal parent with at least one stale edge, ranked by oldest-in-row count, then max lag. */
export function rankConsumers(rows: SkewRow[], rootKeys: Set<IdKey>, settings: SkewSettings): ConsumerRow[] {
  interface Acc {
    parent: string;
    origin?: Origin;
    versions: Set<string>;
    stale: number;
    oldestInRow: number;
    lags: number[];
    worstDiff: VersionDiff;
    severity: Severity;
    children: { child: string; resolved: string; lag: number | null; diff: VersionDiff }[];
  }
  const acc = new Map<IdKey, Acc>();
  const get = (e: SkewEdge): Acc => {
    let a = acc.get(e.parentKey);
    if (!a) {
      a = { parent: e.parent, origin: e.parentOrigin, versions: new Set(), stale: 0, oldestInRow: 0, lags: [], worstDiff: 'equal', severity: 'none', children: [] };
      acc.set(e.parentKey, a);
    }
    return a;
  };
  for (const row of rows) {
    for (const e of row.edges) {
      if (!e.stale) continue;
      const a = get(e);
      a.versions.add(e.parentVersion);
      a.stale++;
      if (e.lag !== null) a.lags.push(e.lag);
      if (DIFF_RANK[e.diff] > DIFF_RANK[a.worstDiff]) a.worstDiff = e.diff;
      a.severity = maxSeverity(a.severity, e.severity);
      a.children.push({ child: e.child, resolved: e.resolvedVersion, lag: e.lag, diff: e.diff });
    }
    for (const key of row.oldestRequesterKeys) {
      const a = acc.get(key);
      if (a) a.oldestInRow++;
    }
  }

  const minRank = SEVERITY_RANK[settings.rebuildMinSeverity];
  const result: ConsumerRow[] = [];
  for (const [parentKey, a] of acc) {
    const isRootProject = rootKeys.has(parentKey);
    const top = [...a.children].sort((x, y) => (y.lag ?? -1) - (x.lag ?? -1) || DIFF_RANK[y.diff] - DIFF_RANK[x.diff]);
    const unique = top.filter((c, i) => top.findIndex((o) => o.child === c.child) === i);
    const list = unique
      .slice(0, 3)
      .map((c) => `${c.child} ${c.resolved}${c.lag !== null ? ` (+${c.lag})` : ` (${c.diff})`}`)
      .join(', ');
    const more = unique.length > 3 ? `, and ${unique.length - 3} more` : '';
    let action: string;
    if (SEVERITY_RANK[a.severity] < minRank) action = `Monitor: every stale edge is below the ${settings.rebuildMinSeverity} threshold.`;
    else if (isRootProject) action = `Raise the PackageReference versions in ${a.parent} to what ships (${list}${more}), or pin them centrally, then rebuild.`;
    else if (a.origin === 'Project') action = `Update ${a.parent}'s package references (${list}${more}) and rebuild.`;
    else action = `Rebuild against ${list}${more}, then republish ${a.parent}.`;
    result.push({
      parentKey,
      parent: a.parent,
      versions: [...a.versions].sort(compareVersionStrings),
      origin: a.origin,
      isRootProject,
      staleEdges: a.stale,
      oldestInRow: a.oldestInRow,
      maxLag: a.lags.length > 0 ? Math.max(...a.lags) : null,
      medianLag: median(a.lags),
      worstDiff: a.worstDiff,
      severity: a.severity,
      action,
    });
  }
  return result.sort(
    (x, y) => y.oldestInRow - x.oldestInRow || (y.maxLag ?? -1) - (x.maxLag ?? -1) || DIFF_RANK[y.worstDiff] - DIFF_RANK[x.worstDiff] || y.staleEdges - x.staleEdges || x.parent.localeCompare(y.parent),
  );
}

export function outlierMessage(c: ConsumerRow): string {
  const distance = c.maxLag !== null ? `${c.maxLag} builds` : `a ${c.worstDiff} version`;
  return `${c.parent} is the oldest requester in ${c.oldestInRow} package${c.oldestInRow === 1 ? '' : 's'}; compiled against a stack up to ${distance} older than what ships. Most likely source of runtime binding failures (MissingMethodException / TypeLoadException).`;
}

// ---------------------------------------------------------------------------
// Rebuild plan
// ---------------------------------------------------------------------------

/**
 * Rebuild set: internal parents with a stale edge at or above the minimum severity. With cascade, their
 * internal consumers (transitively) are added, since a republished package has a new version that its
 * consumers must pick up. Ordered in waves by the collapsed-graph topological sort.
 */
export function planRebuild(rows: SkewRow[], graph: MergedGraph, isInternalKey: (key: IdKey) => boolean, settings: SkewSettings, originOf: (key: IdKey) => Origin | undefined): RebuildPlan {
  const minRank = SEVERITY_RANK[settings.rebuildMinSeverity];
  const display = (k: IdKey) => graph.nodes[k]?.spellings[0] ?? k;
  const because = new Map<IdKey, Set<string>>();
  const reason = new Map<IdKey, RebuildStep['reason']>();
  for (const row of rows) {
    for (const e of row.edges) {
      if (!e.stale || SEVERITY_RANK[e.severity] < minRank) continue;
      const set = because.get(e.parentKey) ?? new Set<string>();
      set.add(`${e.child} ${e.requestedVersion} → ${e.resolvedVersion}`);
      because.set(e.parentKey, set);
      reason.set(e.parentKey, 'stale');
    }
  }
  if (settings.cascade && reason.size > 0) {
    const collapsed = collapseToInternal(graph, isInternalKey);
    const consumers = new Map<IdKey, IdKey[]>();
    for (const e of collapsed.edges) {
      const list = consumers.get(e.to);
      if (list) list.push(e.from);
      else consumers.set(e.to, [e.from]);
    }
    const queue = [...reason.keys()];
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i] as IdKey;
      for (const c of consumers.get(n) ?? []) {
        if (!reason.has(c)) {
          reason.set(c, 'cascade');
          queue.push(c);
        }
        if (reason.get(c) === 'cascade') {
          const set = because.get(c) ?? new Set<string>();
          set.add(display(n));
          because.set(c, set);
        }
      }
    }
  }
  const members = new Set(reason.keys());
  const { order } = computeBuildOrder(graph, (k) => members.has(k));
  const waves = order.ok ? order.waves : order.partialWaves;
  const steps: RebuildStep[] = [];
  const step = (key: IdKey, wave: number): RebuildStep => ({
    wave,
    key,
    id: display(key),
    origin: originOf(key),
    reason: reason.get(key) ?? 'cascade',
    because: [...(because.get(key) ?? [])].sort(),
  });
  waves.forEach((w, i) => {
    for (const key of w) steps.push(step(key, i + 1));
  });
  if (!order.ok) for (const key of order.blocked) steps.push(step(key, 0));
  return { minSeverity: settings.rebuildMinSeverity, cascade: settings.cascade, steps, cycles: order.ok ? [] : order.cycles, blocked: order.ok ? [] : order.blocked };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SkewInput {
  models: ProjectModel[];
  graph: MergedGraph;
  originOf: (key: IdKey) => Origin | undefined;
  settings: SkewSettings;
}

function casingNotes(spellings: EdgeCollection['spellings'], keep: (key: IdKey) => boolean): CasingNote[] {
  const notes: CasingNote[] = [];
  for (const [key, map] of spellings) {
    if (map.size < 2 || !keep(key)) continue;
    const display = [...map.entries()].find(([, seen]) => seen.has('resolved'))?.[0] ?? [...map.keys()][0] ?? key;
    notes.push({
      key,
      display,
      // The resolved spelling first, then the others.
      variants: [...map.entries()]
        .sort(([a], [b]) => Number(b === display) - Number(a === display) || a.localeCompare(b))
        .map(([spelling, seen]) => ({ spelling, seenIn: [...seen].sort((a, b) => (a === 'resolved' ? -1 : b === 'resolved' ? 1 : a.localeCompare(b))) })),
    });
  }
  return notes.sort((a, b) => a.key.localeCompare(b.key));
}

export function analyzeVersionSkew(input: SkewInput): { skew: SkewReport; floating: FloatingReport } {
  const { models, graph, originOf, settings } = input;
  const warnings: string[] = [];
  const compiled = compileBuildPattern(settings.buildNumberPattern);
  if (!compiled.ok) warnings.push(`Invalid build-number pattern (${compiled.error}); used the default.`);
  const re = compiled.ok ? compiled.re : new RegExp(DEFAULT_BUILD_PATTERN);

  const collected = collectSkewEdges(models, originOf, re, settings.thresholds);
  if (collected.skippedProjectChildren > 0) {
    warnings.push(`${collected.skippedProjectChildren} edge${collected.skippedProjectChildren === 1 ? '' : 's'} point to project references; their versions are not package versions and were skipped.`);
  }
  const resolvedBy = resolvedByProject(models);
  const internalEdges = collected.edges.filter((e) => isInternal(e.parentOrigin) && isInternal(e.childOrigin));
  const internal = buildSkewRows(internalEdges, resolvedBy, re, settings.thresholds);
  const publicRows = settings.includePublic ? buildSkewRows(collected.edges.filter((e) => !isInternal(e.childOrigin)), resolvedBy, null, settings.thresholds) : [];

  const rootKeys = new Set(models.map((m) => m.projectName.toLowerCase()));
  const consumers = rankConsumers(internal, rootKeys, settings);
  const top = consumers[0];
  const isInternalKey = (k: IdKey) => isInternal(originOf(k));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of internal) if (r.severity === 'high' || r.severity === 'medium' || r.severity === 'low') counts[r.severity]++;

  const skew: SkewReport = {
    internal,
    public: publicRows,
    consumers,
    outlier: top && top.oldestInRow > 0 ? { consumer: top, message: outlierMessage(top) } : undefined,
    rebuild: planRebuild(internal, graph, isInternalKey, settings, originOf),
    casing: casingNotes(collected.spellings, (k) => settings.includePublic || isInternalKey(k)),
    counts,
    warnings,
  };
  const rowIds = new Set([...internal, ...publicRows].map((r) => r.rowId));
  const floating = analyzeFloating(models, collected.edges, rowIds, originOf, re);
  return { skew, floating };
}
