// Fix Planner: turns an assembly-load failure into a concrete fix.
//
//   A. Failure summary: every requester of the target assembly T, the deployed version, and the
//      required minimum (max of the referenced versions). The runtime reports only the first failure,
//      so the fix has to satisfy all requesters at once.
//   B. AssemblyVersion stamping: internal assemblies referenced at many build-specific versions.
//   C. Option 1: pin an existing package whose assembly is new enough (and that NuGet accepts).
//   D. Option 2: rebuild T and every internal package downstream of it, in topological waves.
//
// Assembly versions are compared with lib/binding's AssemblyVersion and package versions with
// lib/versions; the two are never compared with each other.

import { compareAssemblyVersions, parseAssemblyVersion, type AssemblyVersion } from './assemblyVersion';
import { looksLikeFramework } from './binding';

export { parsePackageAssemblyMap, parseReferencerScan } from './bindingInputs';
import { collapseToInternal, computeBuildOrder } from './graph';
import type {
  AssemblyManifest,
  BindingResult,
  CascadePlan,
  CascadeRow,
  FailureRequester,
  FailureSummary,
  IdKey,
  MergedGraph,
  MergedNode,
  OwnerLink,
  PackageAssemblyEntry,
  PinCandidate,
  PinPlan,
  ProjectModel,
  ReferencerRow,
  ReferencerScan,
  StampedAssembly,
  StampingReport,
} from './types';
import { compareVersionStrings, formatVersion, rangeMin } from './versions';

export const FEED_URL = 'https://pkgs.dev.azure.com/inscriptrx/_packaging/org/nuget/v3/index.json';

/** Highest AssemblyVersion revision the compiler accepts (65535 is error CS7034; verified on .NET 10). */
export const MAX_REVISION = 65534;

const ZERO: AssemblyVersion = { kind: 'assembly', parts: [0, 0, 0, 0] };
const av = (s: string | undefined | null) => parseAssemblyVersion(s) ?? ZERO;
const byAssemblyVersion = (a: string, b: string) => compareAssemblyVersions(av(a), av(b));

export function feedSearchCommand(packageId: string): string {
  return `dotnet package search ${packageId} --source '${FEED_URL}' --prerelease --exact-match --format table`;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A scan derived from the Binding Check: every reference to `target`, resolved the way the runtime would. */
export function scanFromBinding(result: BindingResult, target: string): ReferencerScan | null {
  const key = target.toLowerCase();
  const issues = result.issues.filter((i) => i.reference.name.toLowerCase() === key);
  if (issues.length === 0) return null;
  const rows: ReferencerRow[] = issues.map((i) => ({
    kind: 'REFERENCER',
    dll: i.requester.path.replace(/^.*[\\/]/, ''),
    assembly: i.requester.name,
    version: i.requester.version,
    refersTo: i.reference.version,
    path: i.requester.path,
  }));
  const deployed = issues.find((i) => i.target?.version)?.target;
  if (deployed?.version) rows.push({ kind: 'DEPLOYED', dll: `${deployed.name}.dll`, assembly: deployed.name, version: deployed.version, path: deployed.path });
  return { source: 'binding', fileName: 'Binding Check', target: deployed?.name ?? target, rows, warnings: [] };
}

/** A scan derived from an assembly manifest alone (no deps.json): references to `target` and its copies in the app folder. */
export function scanFromManifest(manifest: AssemblyManifest, target: string): ReferencerScan | null {
  const key = target.toLowerCase();
  const rows: ReferencerRow[] = [];
  for (const a of manifest.assemblies) {
    if (a.culture && a.culture.toLowerCase() !== 'neutral') continue;
    for (const r of a.references) {
      if (r.name.toLowerCase() === key) rows.push({ kind: 'REFERENCER', dll: a.path.replace(/^.*[\\/]/, ''), assembly: a.name, version: a.version, refersTo: r.version, path: a.path });
    }
  }
  for (const a of manifest.assemblies) {
    if (a.name.toLowerCase() === key && a.root === 0) rows.push({ kind: 'DEPLOYED', dll: a.path.replace(/^.*[\\/]/, ''), assembly: a.name, version: a.version, path: a.path });
  }
  return rows.some((r) => r.kind === 'REFERENCER') ? { source: 'manifest', fileName: manifest.fileNames.join(', '), target, rows, warnings: [] } : null;
}

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

/** Owning package of an assembly: deps.json when available, else a package in the graph with the same Id ("by name"). */
export function ownerResolver(binding: BindingResult | null | undefined, graph: MergedGraph | undefined): (assembly: string) => OwnerLink | undefined {
  const primary = binding?.deps.find((d) => d.primary) ?? binding?.deps[0];
  return (assembly) => {
    const key = assembly.toLowerCase();
    const owner = primary?.byAssembly[key]?.[0];
    if (owner) return { packageId: owner.packageId, packageVersion: owner.packageVersion, match: 'deps.json' };
    const node = graph?.nodes[key];
    if (node && node.types.includes('package')) return { packageId: node.spellings[0] ?? assembly, packageVersion: node.versions[0]?.version, match: 'by name' };
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// A. Failure summary
// ---------------------------------------------------------------------------

export interface FailureInput {
  target: string;
  rows: ReferencerRow[];
  /** Deployed version when the rows have no DEPLOYED entry (manifest or deps.json). */
  deployedFallback?: { version: string; source: 'manifest' | 'deps.json' };
  owner?: (assembly: string) => OwnerLink | undefined;
  errorVersion?: string;
}

export function summarizeFailure(input: FailureInput): FailureSummary {
  // The copy closest to the scanned folder is the one the app loads (plugin subfolders hold their own);
  // without paths, the lowest version is the conservative choice.
  const depth = (p: string | undefined) => (p ? p.split(/[\\/]/).length : 0);
  const deployedRows = input.rows
    .filter((r) => r.kind === 'DEPLOYED')
    .sort((a, b) => depth(a.path) - depth(b.path) || byAssemblyVersion(a.version, b.version))
    .map((r) => r.version);
  const distinctDeployed = [...new Set(deployedRows)];
  const deployed =
    distinctDeployed.length > 0
      ? { version: distinctDeployed[0] as string, source: 'scan' as const, others: distinctDeployed.slice(1) }
      : input.deployedFallback
        ? { ...input.deployedFallback, others: [] }
        : undefined;
  const dv = deployed ? av(deployed.version) : undefined;

  const requesters: FailureRequester[] = input.rows
    .filter((r) => r.kind === 'REFERENCER' && r.refersTo)
    .map((r) => {
      const rv = av(r.refersTo);
      const fail = !dv || compareAssemblyVersions(dv, rv) < 0;
      const sameBase = dv && dv.parts[0] === rv.parts[0] && dv.parts[1] === rv.parts[1] && dv.parts[2] === rv.parts[2];
      return {
        assembly: r.assembly,
        dll: r.dll,
        version: r.version,
        refersTo: r.refersTo as string,
        status: fail ? 'FAIL' : 'OK',
        delta: dv && sameBase ? rv.parts[3] - dv.parts[3] : null,
        owner: input.owner?.(r.assembly),
        path: r.path,
      };
    });
  requesters.sort((a, b) => (a.status === b.status ? 0 : a.status === 'FAIL' ? -1 : 1) || byAssemblyVersion(b.refersTo, a.refersTo) || a.assembly.localeCompare(b.assembly));
  const requiredMinimum = requesters.map((r) => r.refersTo).sort(byAssemblyVersion).pop() ?? deployed?.version ?? '0.0.0.0';
  return {
    target: input.target,
    targetOwner: input.owner?.(input.target),
    deployed,
    requiredMinimum,
    requesters,
    failCount: requesters.filter((r) => r.status === 'FAIL').length,
    okCount: requesters.filter((r) => r.status === 'OK').length,
    errorVersion: input.errorVersion,
  };
}

// ---------------------------------------------------------------------------
// B. AssemblyVersion stamping
// ---------------------------------------------------------------------------

export interface VersionObservations {
  /** Assembly name → versions other assemblies reference it at. */
  referenced: Map<string, Set<string>>;
  /** Assembly name → its own AssemblyVersion(s). */
  own: Map<string, Set<string>>;
  /** Display casing. */
  names: Map<string, string>;
}

export function emptyObservations(): VersionObservations {
  return { referenced: new Map(), own: new Map(), names: new Map() };
}

function observe(map: Map<string, Set<string>>, names: Map<string, string>, name: string, version: string | undefined) {
  if (!version || !parseAssemblyVersion(version)) return;
  const k = name.toLowerCase();
  if (!names.has(k)) names.set(k, name);
  const set = map.get(k) ?? new Set<string>();
  set.add(version);
  map.set(k, set);
}

/** Adds a scan: requester versions, and the target's referenced and deployed versions. */
export function observeScan(obs: VersionObservations, scan: ReferencerScan, target: string): void {
  for (const r of scan.rows) {
    if (r.kind === 'REFERENCER') {
      observe(obs.own, obs.names, r.assembly, r.version);
      observe(obs.referenced, obs.names, target, r.refersTo);
    } else observe(obs.own, obs.names, r.assembly, r.version);
  }
}

/** Adds every assembly and reference in a manifest (framework assemblies excluded). */
export function observeManifest(obs: VersionObservations, manifest: AssemblyManifest): void {
  for (const a of manifest.assemblies) {
    if (a.culture && a.culture.toLowerCase() !== 'neutral') continue;
    observe(obs.own, obs.names, a.name, a.version);
    for (const r of a.references) if (!looksLikeFramework(r.name)) observe(obs.referenced, obs.names, r.name, r.version);
  }
}

/**
 * An internal assembly is per-build stamped when references to it carry two or more distinct versions,
 * or any observed version has a non-zero revision. The mode says whether that is an outlier (most other
 * internal assemblies sit at one x.y.z.0 version) or the norm across the codebase.
 */
export function detectStamping(obs: VersionObservations, isInternal: (assembly: string) => boolean = (a) => !looksLikeFramework(a)): StampingReport {
  const stamped: StampedAssembly[] = [];
  let fixed = 0;
  let total = 0;
  const keys = new Set([...obs.referenced.keys(), ...obs.own.keys()]);
  for (const k of keys) {
    const name = obs.names.get(k) ?? k;
    if (!isInternal(name)) continue;
    const refs = obs.referenced.get(k) ?? new Set<string>();
    const all = [...new Set([...refs, ...(obs.own.get(k) ?? [])])].sort(byAssemblyVersion);
    const revisions = all.map((v) => av(v).parts[3]);
    const nonZeroRevision = revisions.some((r) => r !== 0);
    total++;
    if (refs.size >= 2 || nonZeroRevision) {
      stamped.push({ assembly: name, versions: all, referencedVersions: refs.size, nonZeroRevision, maxRevision: Math.max(...revisions) });
    } else fixed++;
  }
  stamped.sort((a, b) => b.referencedVersions - a.referencedVersions || a.assembly.localeCompare(b.assembly));
  const mode: StampingReport['mode'] = stamped.length === 0 ? 'none' : fixed > stamped.length ? 'outlier' : 'codebase-wide';
  return { stamped, fixedBaseline: fixed, baselineTotal: total, mode };
}

export const STAMPING_FIX_SNIPPET = `<!-- Example: in the producing project's .csproj or in Directory.Build.props.
     Property and variable names are examples; the build id variable depends on the pipeline. In Azure
     Pipelines MSBuild sees $(BUILD_BUILDID), or pass -p:BuildId=$(Build.BuildId). -->
<PropertyGroup>
  <AssemblyVersion>10.0.0.0</AssemblyVersion>
  <FileVersion>10.0.0.$(BuildId)</FileVersion>
  <InformationalVersion>$(PackageVersion)</InformationalVersion>
</PropertyGroup>`;

// ---------------------------------------------------------------------------
// C. Pin an existing package
// ---------------------------------------------------------------------------

/**
 * The highest package-level minimum any package in the graph requests for `packageKey`. Pinning below it
 * is a downgrade (NU1605). The root projects' own references are excluded: they are what the pin edits.
 */
export function nugetMinimum(models: ProjectModel[], packageKey: IdKey): { version: string; requestedBy: string[] } | undefined {
  let best: string | undefined;
  const by = new Map<string, Set<string>>();
  for (const m of models) {
    for (const t of m.targets) {
      if (t.rid) continue;
      for (const node of Object.values(t.nodes)) {
        for (const [childId, range] of Object.entries(node.dependencies)) {
          if (childId.toLowerCase() !== packageKey) continue;
          const min = rangeMin(range);
          if (!min) continue;
          const v = formatVersion(min);
          const set = by.get(v) ?? new Set<string>();
          set.add(node.id);
          by.set(v, set);
          if (!best || compareVersionStrings(v, best) > 0) best = v;
        }
      }
    }
  }
  return best ? { version: best, requestedBy: [...(by.get(best) ?? [])].sort() } : undefined;
}

export interface PinInput {
  packageId: string;
  /** Assembly simple name of the target (the DLL inside the package). */
  assembly: string;
  requiredMinimum: string;
  map: PackageAssemblyEntry[];
  nugetMinimum?: { version: string; requestedBy: string[] };
  requesters: FailureRequester[];
  /** Preferred target framework of the map entries (the app's), e.g. "net10.0". */
  tfm?: string;
  cpm?: boolean;
}

export function planPin(input: PinInput): PinPlan {
  const base: PinPlan = { packageId: input.packageId, candidates: [], rollForward: [], feedSearch: feedSearchCommand(input.packageId), nugetMinimum: input.nugetMinimum };
  const id = input.packageId.toLowerCase();
  const dll = `${input.assembly}.dll`.toLowerCase();
  let entries = input.map.filter((e) => e.id.toLowerCase() === id && e.dll.replace(/^.*[\\/]/, '').toLowerCase() === dll);
  if (entries.length === 0) entries = input.map.filter((e) => e.id.toLowerCase() === id);
  if (input.map.length === 0) return { ...base, noneReason: 'No package → assembly map loaded. Run Export-PackageAssemblyMap.ps1 and load its JSON.' };
  if (entries.length === 0) return { ...base, noneReason: `The package → assembly map has no ${input.packageId} versions. Restore more versions locally, or search the feed.` };

  // One candidate per package version: the preferred TFM's entry, else the first.
  const byVersion = new Map<string, PackageAssemblyEntry>();
  for (const e of entries) {
    const k = e.packageVersion.toLowerCase();
    const cur = byVersion.get(k);
    if (!cur || (input.tfm && e.tfm.toLowerCase() === input.tfm.toLowerCase() && cur.tfm.toLowerCase() !== input.tfm.toLowerCase())) byVersion.set(k, e);
  }
  const required = av(input.requiredMinimum);
  const candidates: PinCandidate[] = [...byVersion.values()]
    .map((e) => ({
      packageVersion: e.packageVersion,
      assemblyVersion: e.assemblyVersion,
      fileVersion: e.fileVersion,
      tfm: e.tfm,
      bindsAll: compareAssemblyVersions(av(e.assemblyVersion), required) >= 0,
      meetsNuGetMinimum: !input.nugetMinimum || compareVersionStrings(e.packageVersion, input.nugetMinimum.version) >= 0,
    }))
    .sort((a, b) => compareVersionStrings(a.packageVersion, b.packageVersion));
  const recommended = candidates.find((c) => c.bindsAll && c.meetsNuGetMinimum);
  if (!recommended) {
    const binding = candidates.filter((c) => c.bindsAll);
    const noneReason =
      binding.length === 0
        ? `No cached ${input.packageId} version ships assembly ≥ ${input.requiredMinimum} (highest: ${[...candidates].sort((a, b) => byAssemblyVersion(a.assemblyVersion, b.assemblyVersion)).pop()?.assemblyVersion ?? 'none'}).`
        : `The versions that bind (${binding.map((c) => c.packageVersion).join(', ')}) are below the NuGet minimum ${input.nugetMinimum?.version} requested by ${input.nugetMinimum?.requestedBy.join(', ')} (NU1605).`;
    return { ...base, candidates, noneReason };
  }
  return {
    ...base,
    candidates,
    recommended,
    snippet: `<PackageReference Include="${input.packageId}" Version="[${recommended.packageVersion}]" />`,
    cpmSnippet: input.cpm ? `<PackageVersion Include="${input.packageId}" Version="[${recommended.packageVersion}]" />` : undefined,
    rollForward: input.requesters.filter((r) => compareAssemblyVersions(av(r.refersTo), av(recommended.assemblyVersion)) < 0),
  };
}

// ---------------------------------------------------------------------------
// D. Rebuild cascade
// ---------------------------------------------------------------------------

export interface FixGraph {
  graph: MergedGraph;
  /** Nodes placed only from DLL references (not in any assets file). */
  placed: Set<IdKey>;
}

/**
 * The assets graph plus nodes for assemblies that appear in no assets file (e.g. Model.CQE.Landing.*),
 * placed by their references to known assemblies: manifest AssemblyRefs, and scan rows (a REFERENCER of
 * the target depends on the target). Edges are mapped from assembly names to owning packages.
 */
export function buildFixGraph(base: MergedGraph, opts: { manifest?: AssemblyManifest; scans?: { scan: ReferencerScan; target: string }[]; owner?: (assembly: string) => OwnerLink | undefined }): FixGraph {
  const nodes: Record<IdKey, MergedNode> = { ...base.nodes };
  const edges = [...base.edges];
  const edgeKeys = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
  const placed = new Set<IdKey>();
  const keyOf = (assembly: string): IdKey | undefined => {
    const owner = opts.owner?.(assembly);
    const k = (owner?.packageId ?? assembly).toLowerCase();
    return nodes[k] ? k : undefined;
  };
  const place = (name: string): IdKey | undefined => {
    if (looksLikeFramework(name)) return undefined;
    const existing = keyOf(name);
    if (existing) return existing;
    const k = name.toLowerCase();
    nodes[k] = { key: k, spellings: [name], types: ['package'], versions: [], directIn: [], isRootProject: false };
    placed.add(k);
    return k;
  };
  const link = (from: IdKey, to: IdKey, fromVersion: string, range: string) => {
    if (from === to || edgeKeys.has(`${from}\u0000${to}`)) return;
    edgeKeys.add(`${from}\u0000${to}`);
    edges.push({ from, to, usages: [{ project: 'DLL references', tfm: '', fromVersion, range }] });
  };

  const manifestAssemblies = (opts.manifest?.assemblies ?? []).filter((a) => !a.culture || a.culture.toLowerCase() === 'neutral');
  // Pass 1: create nodes for unknown assemblies that reference a known internal assembly or another unknown one.
  const unknown = manifestAssemblies.filter((a) => !keyOf(a.name) && !looksLikeFramework(a.name));
  const unknownNames = new Set(unknown.map((a) => a.name.toLowerCase()));
  for (const a of unknown) {
    if (a.references.some((r) => keyOf(r.name) || unknownNames.has(r.name.toLowerCase()))) place(a.name);
  }
  for (const a of unknown) {
    const from = keyOf(a.name);
    if (!from || !placed.has(from)) continue;
    for (const r of a.references) {
      const to = keyOf(r.name);
      if (to) link(from, to, a.version, r.version);
    }
  }
  for (const { scan, target } of opts.scans ?? []) {
    const to = keyOf(target);
    if (!to) continue;
    for (const r of scan.rows) {
      if (r.kind !== 'REFERENCER') continue;
      const from = place(r.assembly);
      if (from && placed.has(from)) link(from, to, r.version, r.refersTo ?? '');
    }
  }
  return { graph: { nodes, edges: edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0)), projects: base.projects }, placed };
}

/**
 * The target's owning package plus every internal package downstream of it, in the global topological
 * waves of the fix graph (so wave numbers match the full build order). Cycles that touch the cascade are
 * reported instead of an order.
 */
export function planCascade(fix: FixGraph, startKey: IdKey | undefined, isInternal: (key: IdKey) => boolean, failKeys: Set<IdKey> = new Set()): CascadePlan {
  if (!startKey || !fix.graph.nodes[startKey]) return { rows: [], cycles: [], unavailable: startKey ? `${startKey} is not in the loaded project.assets.json graph.` : 'The target has no owning package.' };
  const internal = (k: IdKey) => k === startKey || fix.placed.has(k) || isInternal(k);
  const collapsed = collapseToInternal(fix.graph, internal);
  const consumers = new Map<IdKey, IdKey[]>();
  for (const e of collapsed.edges) {
    const list = consumers.get(e.to);
    if (list) list.push(e.from);
    else consumers.set(e.to, [e.from]);
  }
  const members = new Set<IdKey>([startKey]);
  const queue = [startKey];
  for (let i = 0; i < queue.length; i++) {
    for (const c of consumers.get(queue[i] as IdKey) ?? []) {
      if (!members.has(c)) {
        members.add(c);
        queue.push(c);
      }
    }
  }
  // Root projects (the apps) consume everything; the cascade lists packages to republish.
  for (const k of [...members]) if (fix.graph.nodes[k]?.isRootProject) members.delete(k);

  const { order } = computeBuildOrder(fix.graph, (k) => internal(k) && !fix.graph.nodes[k]?.isRootProject);
  const display = (k: IdKey) => fix.graph.nodes[k]?.spellings[0] ?? k;
  const startId = display(startKey);
  if (!order.ok) {
    const cycles = order.cycles.filter((c) => c.some((k) => members.has(k)));
    if (cycles.length > 0) return { start: startKey, startId, rows: [], cycles };
  }
  const waves = order.ok ? order.waves : order.partialWaves;
  const deps = new Map<IdKey, IdKey[]>();
  for (const e of collapsed.edges) {
    if (!members.has(e.from) || !members.has(e.to)) continue;
    const list = deps.get(e.from);
    if (list) list.push(e.to);
    else deps.set(e.from, [e.to]);
  }
  const rows: CascadeRow[] = [];
  waves.forEach((wave, i) => {
    for (const k of wave) {
      if (!members.has(k)) continue;
      rows.push({
        wave: i,
        key: k,
        id: display(k),
        reason: k === startKey ? { kind: 'target' } : { kind: 'dependsOn', on: (deps.get(k) ?? []).map(display).sort() },
        failRequester: failKeys.has(k),
        placement: fix.placed.has(k) ? 'dll-references' : 'assets',
      });
    }
  });
  return { start: startKey, startId, rows, cycles: [] };
}
