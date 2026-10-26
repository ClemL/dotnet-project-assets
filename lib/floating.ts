// Floating and unpinned references: classifies each direct dependency's declared range, links
// floating references to the internal consumers that still expect an older version, and reports the
// project-level lock-file and Central Package Management settings.

import { isInternalOrigin } from './classify';
import type { FloatingRef, FloatingReport, IdKey, Origin, ProjectModel, RangeKind, Severity, SkewEdge } from './types';
import { compareVersionStrings, extractBuildNumber, parseVersion, rangeKind } from './versions';

export const RANGE_KIND_SEVERITY: Record<RangeKind, Severity> = {
  floatingPrerelease: 'medium',
  floatingStable: 'medium',
  openEnded: 'info',
  bounded: 'none',
  pinned: 'none',
  unknown: 'info',
};

export const RANGE_KIND_LABEL: Record<RangeKind, string> = {
  floatingPrerelease: 'Floating prerelease',
  floatingStable: 'Floating stable',
  openEnded: 'Open-ended',
  bounded: 'Bounded',
  pinned: 'Pinned',
  unknown: 'Unparsed',
};

export const isFloatingKind = (k: RangeKind) => k === 'floatingPrerelease' || k === 'floatingStable';

/** Short label for a version: its build number when both sides share major.minor.patch, else the full version. */
function versionLabel(version: string, reference: string, re: RegExp): string {
  const a = parseVersion(version);
  const b = parseVersion(reference);
  const build = extractBuildNumber(version, re);
  if (a && b && build !== null && a.major === b.major && a.minor === b.minor && a.patch === b.patch && extractBuildNumber(reference, re) !== null) return String(build);
  return version;
}

export function lockFileSnippet(): string {
  return `<!-- Directory.Build.props at the repository root -->
<Project>
  <PropertyGroup>
    <!-- Write packages.lock.json on every restore; commit it. -->
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- In CI, fail the restore instead of silently updating the lock file.
         TF_BUILD is set by Azure Pipelines; CI by GitHub Actions and most other servers. -->
    <RestoreLockedMode Condition="'$(TF_BUILD)' == 'True' Or '$(CI)' == 'true'">true</RestoreLockedMode>
  </PropertyGroup>
</Project>

# Locally: generate or refresh the lock files (floating ranges are re-evaluated only here), then commit them
dotnet restore --force-evaluate

# CI step (Azure Pipelines script or GitHub Actions run)
dotnet restore --locked-mode`;
}

export function cpmSnippet(versions: { id: string; version: string }[]): string {
  const items = versions.length > 0 ? versions.map((v) => `    <PackageVersion Include="${v.id}" Version="${v.version}" />`).join('\n') : '    <PackageVersion Include="Model.Import" Version="10.0.0-13615" />';
  return `<!-- Directory.Packages.props at the repository root -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <!-- Also pins transitive packages that have a PackageVersion entry (e.g. internal packages pulled in by other packages). -->
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>
  <ItemGroup>
${items}
  </ItemGroup>
</Project>

<!-- In each .csproj, remove the Version attribute: -->
<PackageReference Include="${versions[0]?.id ?? 'Model.Import'}" />`;
}

/**
 * Classifies every direct dependency (project.frameworks[tfm].dependencies) of the non-RID targets of
 * `models`. `edges` are the skew edges of the same models; `rowIds` are the skew rows to link to.
 */
export function analyzeFloating(models: ProjectModel[], edges: SkewEdge[], rowIds: Set<string>, originOf: (key: IdKey) => Origin | undefined, re: RegExp): FloatingReport {
  const refs: FloatingRef[] = [];
  for (const model of models) {
    for (const target of model.targets) {
      if (target.rid) continue;
      const declared =
        target.declared.length > 0
          ? target.declared
          : target.roots.filter((r) => r.kind === 'packageReference').map((r) => ({ id: r.id, range: r.range, centrallyManaged: false, autoReferenced: false, versionOverride: undefined }));
      for (const d of declared) {
        const key = d.id.toLowerCase();
        if (target.nodes[key]?.type === 'project') continue;
        const kind = rangeKind(d.range, d.centrallyManaged);
        const node = target.nodes[key];
        const ref: FloatingRef = {
          project: model.label,
          target: target.key,
          key,
          id: node?.id ?? d.id,
          range: d.range,
          kind,
          severity: RANGE_KIND_SEVERITY[kind],
          centrallyManaged: d.centrallyManaged,
          autoReferenced: d.autoReferenced,
          versionOverride: d.versionOverride,
          resolvedVersion: node?.version,
          origin: originOf(key),
        };
        if (isFloatingKind(kind) && node) {
          const older = edges.filter((e) => e.target === target.key && e.childKey === key && !e.isDirect && e.stale && e.parentOrigin !== undefined && isInternalOrigin(e.parentOrigin));
          if (older.length > 0) {
            const versions = older.map((e) => e.requestedVersion as string).sort(compareVersionStrings);
            const min = versions[0] as string;
            const max = versions[versions.length - 1] as string;
            const rowId = `${target.key}|${key}|${node.version}`;
            ref.olderConsumers = { min, max, parents: [...new Set(older.map((e) => e.parent))].sort(), rowId: rowIds.has(rowId) ? rowId : undefined };
            const lo = versionLabel(min, node.version, re);
            const hi = versionLabel(max, node.version, re);
            ref.note = `${ref.id} floated to ${versionLabel(node.version, min, re)} while consumers expect ${lo === hi ? lo : `${lo}–${hi}`}.`;
          }
        }
        refs.push(ref);
      }
    }
  }
  refs.sort((a, b) => Number(isFloatingKind(b.kind)) - Number(isFloatingKind(a.kind)) || a.id.localeCompare(b.id) || a.project.localeCompare(b.project));

  const floatingRefs = refs.filter((r) => isFloatingKind(r.kind));
  const floatingProjects = new Set(floatingRefs.map((r) => r.project));
  const restore = models.map((m) => ({ project: m.label, flags: m.restoreFlags }));
  const recommend = floatingRefs.length > 0 && restore.some((r) => floatingProjects.has(r.project) && r.flags.lockFile !== 'enabled');

  // Pin internal direct references at the versions that resolve today (highest when projects differ).
  const pins = new Map<IdKey, { id: string; version: string }>();
  for (const r of refs) {
    if (!r.resolvedVersion || r.autoReferenced) continue;
    if (!(r.origin && isInternalOrigin(r.origin)) && !isFloatingKind(r.kind)) continue;
    const current = pins.get(r.key);
    if (!current || compareVersionStrings(r.resolvedVersion, current.version) > 0) pins.set(r.key, { id: r.id, version: r.resolvedVersion });
  }
  const pinList = [...pins.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { refs, restore, floatingCount: floatingRefs.length, recommend, snippets: { lockFile: lockFileSnippet(), cpm: cpmSnippet(pinList) } };
}
