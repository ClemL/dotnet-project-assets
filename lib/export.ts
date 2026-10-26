// Report builders (Markdown, JSON, CSV) and export file names.

import type { BuildOrderOptions } from './analyze';
import { ORIGIN_LABELS } from './classify';
import { RANGE_KIND_LABEL } from './floating';
import type {
  AnalyzeOptions,
  BuildOrderView,
  ClassifyOutput,
  ClassifySettings,
  DependencyRow,
  FloatingReport,
  IdKey,
  MergedGraph,
  ParseError,
  ProjectModel,
  RequestedGroup,
  ScopeAnalysis,
  SkewReport,
  SkewRow,
  SkewSettings,
} from './types';
import { describeRange } from './versions';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as yyyyMMdd_HHmm. */
export function formatTimestamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function sanitizeName(name: string): string {
  const s = name.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return s || 'Merged';
}

/** AssetsGraph_<ProjectNameOrMerged>[-<Suffix>]_yyyyMMdd_HHmm.<ext> */
export function buildFileName(name: string, ext: string, date: Date, suffix?: string): string {
  return `AssetsGraph_${sanitizeName(name)}${suffix ? `-${suffix}` : ''}_${formatTimestamp(date)}.${ext}`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 CSV with CRLF line endings and a UTF-8 BOM so Excel opens it correctly. */
export function toCsv(rows: string[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function originOf(classification: ClassifyOutput | undefined, key: IdKey): { origin: string; reason: string } {
  const c = classification?.byId[key];
  if (!c) return { origin: '', reason: '' };
  return { origin: ORIGIN_LABELS[c.origin] + (c.mixed ? ' (mixed)' : ''), reason: c.reasons.join(' | ') };
}

export function dependencyTable(rows: DependencyRow[], classification: ClassifyOutput | undefined): string[][] {
  return [
    ['Id', 'ResolvedVersions', 'Type', 'DirectTransitive', 'Origin', 'Reason', 'Projects', 'DirectIn'],
    ...rows.map((r) => {
      const o = originOf(classification, r.key);
      return [r.id, r.versions.join('; '), r.types.join('; '), r.directness, o.origin, o.reason, r.projects.join('; '), r.directIn.join('; ')];
    }),
  ];
}

export function dependenciesCsv(rows: DependencyRow[], classification: ClassifyOutput | undefined): string {
  return toCsv(dependencyTable(rows, classification));
}

export function displayId(graph: MergedGraph, key: IdKey): string {
  return graph.nodes[key]?.spellings[0] ?? key;
}

export function buildOrderTable(view: BuildOrderView, graph: MergedGraph, classification: ClassifyOutput | undefined): string[][] {
  const deps = new Map<IdKey, string[]>();
  for (const e of view.graph.edges) {
    const list = deps.get(e.from) ?? [];
    list.push(displayId(graph, e.to));
    deps.set(e.from, list);
  }
  const rows: string[][] = [['Wave', 'Id', 'Origin', 'DependsOn', 'Status']];
  const waves = view.order.ok ? view.order.waves : view.order.partialWaves;
  waves.forEach((wave, i) => {
    for (const key of wave) rows.push([String(i + 1), displayId(graph, key), originOf(classification, key).origin, (deps.get(key) ?? []).join('; '), 'ok']);
  });
  if (!view.order.ok) {
    const onCycle = new Set(view.order.cycles.flat());
    for (const key of view.order.blocked) {
      rows.push(['', displayId(graph, key), originOf(classification, key).origin, (deps.get(key) ?? []).join('; '), onCycle.has(key) ? 'cycle' : 'blocked by cycle']);
    }
  }
  return rows;
}

export function buildOrderCsv(view: BuildOrderView, graph: MergedGraph, classification: ClassifyOutput | undefined): string {
  return toCsv(buildOrderTable(view, graph, classification));
}

/** One row per stale edge, internal rows first, then public ones (when included). */
export function skewEdgeTable(skew: SkewReport): string[][] {
  const rows: string[][] = [['tfm', 'child', 'resolvedVersion', 'parent', 'parentVersion', 'requestedRange', 'requestedVersion', 'lag', 'severity', 'isDirect', 'isFloating', 'projects']];
  for (const row of [...skew.internal, ...skew.public]) {
    for (const e of row.edges) {
      if (!e.stale) continue;
      rows.push([
        e.tfm,
        e.child,
        e.resolvedVersion,
        e.parent,
        e.parentVersion,
        e.requestedRange,
        e.requestedVersion ?? '',
        e.lag !== null ? String(e.lag) : 'n/a (semver)',
        e.severity,
        String(e.isDirect),
        String(e.isFloating),
        e.projects.join('; '),
      ]);
    }
  }
  return rows;
}

export function skewCsv(skew: SkewReport): string {
  return toCsv(skewEdgeTable(skew));
}

/** "13018 → Model.PBM" or "13615 ← direct ref [10.0.*-*, )"; full versions when no build number parses. */
export function formatRequestedGroup(g: RequestedGroup): string {
  const label = g.build !== null ? String(g.build) : g.requestedVersion || '(no lower bound)';
  const parents = g.requesters.filter((r) => !r.isDirect).map((r) => r.parent);
  const direct = g.requesters.filter((r) => r.isDirect).map((r) => `${label} ← direct ref ${r.range}`);
  return [...(parents.length > 0 ? [`${label} → ${parents.join(', ')}`] : []), ...direct].join('; ');
}

export function formatSpread(r: Pick<SkewRow, 'spread' | 'spreadDiff'>): string {
  return r.spread !== null ? String(r.spread) : `n/a (semver, ${r.spreadDiff})`;
}

// ---------------------------------------------------------------------------
// Markdown / JSON
// ---------------------------------------------------------------------------

export interface ReportInput {
  generatedAt: Date;
  scope: ScopeAnalysis;
  models: ProjectModel[];
  errors: ParseError[];
  classification?: ClassifyOutput;
  buildOrder?: BuildOrderView;
  settings: ClassifySettings;
  options: AnalyzeOptions & BuildOrderOptions;
  skew?: SkewReport;
  floating?: FloatingReport;
  skewSettings?: SkewSettings;
}

function md(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const [head, ...body] = rows as [string[], ...string[][]];
  const line = (r: string[]) => `| ${r.map(md).join(' | ')} |`;
  return [line(head), `| ${head.map(() => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

function cyclePath(graph: MergedGraph, cycle: IdKey[]): string {
  return cycle.map((k) => displayId(graph, k)).join(' → ');
}

export function markdownReport(input: ReportInput): string {
  const { scope, classification, buildOrder, settings } = input;
  const g = scope.graph;
  const d = scope.duplicates;
  const out: string[] = [];
  const ts = input.generatedAt;
  out.push(`# AssetsGraph report: ${scope.label}`);
  out.push('');
  out.push(`Generated ${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())} (local time). All analysis ran in the browser.`);
  out.push('');

  out.push('## Inputs');
  out.push('');
  out.push(
    mdTable([
      ['Project', 'File', 'Targets', 'Direct deps (first target)', 'Warnings'],
      ...input.models.map((m) => [m.label, m.fileName, m.targets.map((t) => t.key).join(', '), String(m.targets[0]?.roots.length ?? 0), String(m.warnings.length)]),
    ]),
  );
  if (input.errors.length > 0) {
    out.push('');
    out.push('### Parse errors');
    out.push('');
    for (const e of input.errors) out.push(`- **${md(e.fileName)}**: ${md(e.message)}`);
  }
  out.push('');

  out.push('## Classification');
  out.push('');
  out.push(`- Network lookups: ${settings.offline ? 'off (offline mode)' : 'nuget.org flat container'}`);
  out.push(`- System prefixes: ${settings.systemPrefixes.join(', ') || '(none)'}`);
  out.push(`- Internal prefixes: ${settings.internalPrefixes.join(', ') || '(none)'}`);
  out.push(`- Internal feeds: ${settings.internalFeeds.join(', ') || '(none)'}`);
  if (classification) {
    out.push(`- Source metadata coverage: ${classification.coverage.withMetadata} of ${classification.coverage.total} packages`);
    const counts = new Map<string, number>();
    for (const r of scope.rows) {
      const o = originOf(classification, r.key).origin || 'Unknown';
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    out.push(`- Origins: ${[...counts.entries()].sort().map(([o, n]) => `${o} ${n}`).join(', ')}`);
    if (classification.proxyWarning) {
      out.push('');
      out.push(
        `> **Warning:** all ${classification.proxyWarning.publicLookingCount} public-looking packages with source metadata report ${md(classification.proxyWarning.feed)}. ` +
          'The feed proxies nuget.org, so source metadata cannot separate internal from public packages.' +
          (classification.proxyWarning.ignored ? ' Metadata from this feed was ignored.' : ''),
      );
    }
  }
  out.push('');

  out.push('## Build order');
  out.push('');
  out.push(`Internal nodes only (Project${input.options.includeProjects ? '' : ' excluded'}, Private, Private (inferred)), computed with Kahn's algorithm on this scope's graph.`);
  out.push('');
  if (!buildOrder) {
    out.push('_Not computed._');
  } else if (buildOrder.order.ok) {
    if (buildOrder.order.waves.length === 0) out.push('_No internal nodes._');
    buildOrder.order.waves.forEach((w, i) => out.push(`${i + 1}. Wave ${i + 1}: ${w.map((k) => displayId(g, k)).join(', ')}`));
  } else {
    out.push('**Cycle detected; no complete build order exists.**');
    out.push('');
    for (const c of buildOrder.order.cycles) out.push(`- ${cyclePath(g, c)}`);
    if (buildOrder.order.partialWaves.length > 0) {
      out.push('');
      out.push('Waves before the cycle:');
      out.push('');
      buildOrder.order.partialWaves.forEach((w, i) => out.push(`${i + 1}. Wave ${i + 1}: ${w.map((k) => displayId(g, k)).join(', ')}`));
    }
  }
  out.push('');

  if (input.skew) out.push(...skewMarkdown(input.skew, input.floating, input.skewSettings), '');

  out.push('## Duplicates');
  out.push('');
  out.push(`### Different versions across target frameworks (${d.tfm.length})`);
  out.push('');
  out.push(d.tfm.length ? mdTable([['Project', 'Id', 'Versions by target'], ...d.tfm.map((x) => [x.project, x.id, x.byTarget.map((t) => `${t.target}: ${t.version}`).join('; ')])]) : '_None._');
  out.push('');
  out.push(`### Version drift across projects (${d.drift.length})`);
  out.push('');
  out.push(
    d.drift.length
      ? mdTable([['Id', 'Version', 'Projects'], ...d.drift.flatMap((x) => x.versions.map((v) => [x.id, v.version, v.projects.map((p) => `${p.project} (${p.tfms.join(', ')})`).join('; ')]))])
      : '_None._',
  );
  out.push('');
  const conflicts = d.ranges.filter((r) => r.hasConflict);
  out.push(`### Requested ranges not satisfied by the resolved version (${conflicts.length})`);
  out.push('');
  out.push(
    conflicts.length
      ? mdTable([
          ['Project', 'Target', 'Id', 'Resolved', 'Parents (range)'],
          ...conflicts.map((x) => [
            x.project,
            x.target,
            x.id,
            x.resolved,
            x.parents.map((p) => `${p.parent}${p.parentVersion ? ` ${p.parentVersion}` : ''}: ${describeRange(p.range) || 'any'}${p.satisfied === false ? ' ✗' : ''}`).join('; '),
          ]),
        ])
      : '_None._',
  );
  out.push('');
  out.push(`### Redundant direct references (${d.redundant.length})`);
  out.push('');
  out.push(
    d.redundant.length
      ? mdTable([
          ['Project', 'Target', 'Id', 'Direct range', 'Resolved', 'Also via', 'Likely pin'],
          ...d.redundant.map((x) => [x.project, x.target, x.id, describeRange(x.directRange) || 'project', x.resolved, x.via.map((p) => p.join(' → ')).join('; '), x.likelyPin ? 'yes' : 'no']),
        ])
      : '_None._',
  );
  out.push('');
  out.push(`### Ids that differ only by case (${d.caseCollisions.length})`);
  out.push('');
  out.push(
    d.caseCollisions.length
      ? mdTable([['Spellings', 'Projects'], ...d.caseCollisions.map((x) => [x.spellings.map((s) => s.id).join(' / '), x.spellings.map((s) => `${s.id}: ${s.projects.join(', ')}`).join('; ')])])
      : '_None._',
  );
  out.push('');

  out.push(`## Dependencies (${scope.rows.length})`);
  out.push('');
  out.push(mdTable(dependencyTable(scope.rows, classification)));
  out.push('');
  return out.join('\n');
}

function skewRowsTable(rows: SkewRow[], merged: boolean): string[][] {
  return [
    ['Target', 'Package (resolved version)', 'Requested versions', 'Spread', 'Oldest requester', 'Severity', ...(merged ? ['Shipped by', 'Cross-project drift'] : [])],
    ...rows.map((r) => [
      r.target,
      `${r.child} (${r.resolvedVersion})`,
      r.groups.map(formatRequestedGroup).join('; '),
      formatSpread(r),
      r.oldestRequesters.join(', '),
      r.severity,
      ...(merged ? [r.shippedBy.join(', '), r.drift.length > 0 ? `also ${r.drift.join(', ')}` : ''] : []),
    ]),
  ];
}

export function skewMarkdown(skew: SkewReport, floating: FloatingReport | undefined, settings: SkewSettings | undefined): string[] {
  const out: string[] = [];
  const merged = skew.internal.some((r) => r.shippedBy.length > 1 || r.drift.length > 0);
  out.push('## Version skew');
  out.push('');
  if (settings) {
    out.push(
      `Build-number pattern \`${settings.buildNumberPattern}\`; severity thresholds low ≥ ${settings.thresholds.low}, medium ≥ ${settings.thresholds.medium}, high ≥ ${settings.thresholds.high}; rebuild minimum ${settings.rebuildMinSeverity}; cascade ${settings.cascade ? 'on' : 'off'}; public packages ${settings.includePublic ? 'included' : 'excluded'}.`,
    );
    out.push('');
  }
  out.push('### Summary');
  out.push('');
  const lock = floating?.restore.map((r) => `${r.project}: lock file ${r.flags.lockFile}, CPM ${r.flags.cpm}`).join('; ') ?? 'n/a';
  out.push(
    mdTable([
      ['High', 'Medium', 'Low', 'Outlier', 'Floating refs', 'Restore settings'],
      [String(skew.counts.high), String(skew.counts.medium), String(skew.counts.low), skew.outlier?.consumer.parent ?? '(none)', String(floating?.floatingCount ?? 0), lock],
    ]),
  );
  if (skew.outlier) {
    out.push('');
    out.push(`> **Outlier:** ${md(skew.outlier.message)}`);
  }
  out.push('');
  out.push(`### Per-package skew (${skew.internal.length})`);
  out.push('');
  out.push(skew.internal.length > 0 ? mdTable(skewRowsTable(skew.internal, merged)) : '_No stale internal edges._');
  out.push('');
  if (settings?.includePublic) {
    out.push(`### Public and system packages (${skew.public.length})`);
    out.push('');
    out.push(skew.public.length > 0 ? mdTable(skewRowsTable(skew.public, merged)) : '_None._');
    out.push('');
  }
  out.push(`### Consumer staleness ranking (${skew.consumers.length})`);
  out.push('');
  out.push(
    skew.consumers.length > 0
      ? mdTable([
          ['Package (version)', 'Stale edges', 'Oldest-in-row count', 'Max lag', 'Median lag', 'Recommended action'],
          ...skew.consumers.map((c) => [`${c.parent} (${c.versions.join(', ')})`, String(c.staleEdges), String(c.oldestInRow), c.maxLag !== null ? String(c.maxLag) : `n/a (${c.worstDiff})`, c.medianLag !== null ? String(c.medianLag) : 'n/a', c.action]),
        ])
      : '_None._',
  );
  out.push('');
  out.push(`### Rebuild plan (${skew.rebuild.steps.length})`);
  out.push('');
  out.push(
    skew.rebuild.steps.length > 0
      ? mdTable([['Wave', 'Package', 'Reason', 'Because'], ...skew.rebuild.steps.map((st) => [st.wave > 0 ? String(st.wave) : 'blocked', st.id, st.reason, st.because.join('; ')])])
      : '_Nothing to rebuild at this minimum severity._',
  );
  if (skew.rebuild.cycles.length > 0) {
    out.push('');
    out.push(`**Cycle in the rebuild set:** ${skew.rebuild.cycles.map((c) => c.join(' → ')).join('; ')}`);
  }
  out.push('');
  if (floating) {
    out.push(`### Floating and unpinned references (${floating.floatingCount} floating)`);
    out.push('');
    out.push(
      floating.refs.length > 0
        ? mdTable([
            ['Project', 'Target', 'Id', 'Range', 'Kind', 'Severity', 'Resolved', 'Note'],
            ...floating.refs.map((r) => [r.project, r.target, r.id, r.range, RANGE_KIND_LABEL[r.kind] + (r.centrallyManaged ? ' (central)' : ''), r.severity, r.resolvedVersion ?? '', r.note ?? '']),
          ])
        : '_No direct package references._',
    );
    out.push('');
    out.push(mdTable([['Project', 'Lock file', 'Locked mode', 'Central Package Management', 'Transitive pinning'], ...floating.restore.map((r) => [r.project, r.flags.lockFile, r.flags.lockedMode, `${r.flags.cpm}${r.flags.cpmEvidence === 'dependency' ? ' (from versionCentrallyManaged)' : ''}`, r.flags.transitivePinning])]));
    out.push('');
    out.push('"unknown" means the property is absent from project.assets.json; NuGet writes these flags only when they are set.');
    if (floating.recommend) {
      out.push('');
      out.push('**Recommendation:** floating references exist and no lock file was detected. Enable packages.lock.json with RestoreLockedMode in CI, and pin internal versions with Central Package Management.');
    }
    out.push('');
  }
  if (skew.casing.length > 0) {
    out.push(`Casing variants: ${skew.casing.map((c) => c.variants.map((v) => v.spelling).join(' / ')).join('; ')}.`);
  }
  return out;
}

export function jsonReport(input: ReportInput): string {
  const { scope, classification, buildOrder } = input;
  const report = {
    tool: 'assets-graph',
    generatedAt: input.generatedAt.toISOString(),
    scope: { id: scope.scopeId, label: scope.label },
    options: input.options,
    settings: input.settings,
    inputs: input.models.map((m) => ({
      project: m.label,
      fileName: m.fileName,
      projectPath: m.projectPath,
      projectVersion: m.projectVersion,
      sources: m.sources,
      targets: m.targets.map((t) => ({ key: t.key, tfm: t.tfm, rid: t.rid, nodeCount: Object.keys(t.nodes).length, roots: t.roots })),
      warnings: m.warnings,
    })),
    errors: input.errors,
    dependencies: scope.rows.map((r) => ({ ...r, classification: classification?.byId[r.key] })),
    duplicates: scope.duplicates,
    buildOrder,
    versionSkew: input.skew && { settings: input.skewSettings, skew: input.skew, floating: input.floating },
    classification: classification && {
      byPackage: classification.byPackage,
      proxyWarning: classification.proxyWarning,
      coverage: classification.coverage,
    },
    graph: scope.graph,
  };
  return JSON.stringify(report, null, 2);
}
