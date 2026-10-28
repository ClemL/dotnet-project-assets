// Binding check: resolves every assembly reference in the manifest to the assembly that would load
// at runtime and classifies the result.
//
// Rules for the .NET default load context (verified on .NET 10.0.13):
//   - A reference binds when the deployed assembly with the same simple name has a version >= the
//     referenced version. A lower version, a missing file, and a file that is in bin\ but not listed
//     in <App>.deps.json all fail the same way: FileNotFoundException "The system cannot find the
//     file specified".
//   - The public key token is not checked: a different or missing token still binds.
//   - When the app's deps.json and the shared framework both provide an assembly, the higher version
//     wins, using the assemblyVersion recorded in deps.json; without one, the framework copy wins.
// Plugin folders (manifest roots after the first) resolve from their own folder first, then the app.
//
// Package versions (10.0.0-13615) and assembly versions (10.0.0.34377) come from different counters
// and are never compared with each other: assembly versions use their own AssemblyVersion type.

import { compareAssemblyVersions, parseAssemblyVersion, type AssemblyVersion } from './assemblyVersion';
import { mergeManifests, parseBindingInput, ridRank, type BindingInputText } from './bindingInputs';
import { isInternalOrigin, matchPrefix } from './classify';
import type {
  AssemblyCopies,
  AssemblyCopy,
  AssemblyManifest,
  AssemblyOwner,
  AssemblyRefInfo,
  BindingClass,
  BindingInputKind,
  BindingInputSummary,
  BindingIssue,
  BindingResult,
  BindingSeverity,
  BindingTarget,
  ClassifyOutput,
  ClassifySettings,
  CorrelationRow,
  DeployedInfo,
  DepsModel,
  ErrorLookupResult,
  FrameworkAssembly,
  IdKey,
  ManifestAssembly,
  Origin,
  PackageAssemblyEntry,
  PackageLink,
  ParsedLoadError,
  ReferencerScan,
  RuntimeConfigInfo,
} from './types';
import { compareVersionStrings } from './versions';

export { compareAssemblyVersions, parseAssemblyVersion, type AssemblyVersion } from './assemblyVersion';

function sameAssemblyVersion(a: string, b: string): boolean {
  const x = parseAssemblyVersion(a);
  const y = parseAssemblyVersion(b);
  return x && y ? compareAssemblyVersions(x, y) === 0 : a.trim() === b.trim();
}

const ZERO: AssemblyVersion = { kind: 'assembly', parts: [0, 0, 0, 0] };

// ---------------------------------------------------------------------------
// Framework heuristic
// ---------------------------------------------------------------------------

const FRAMEWORK_SIMPLE_NAMES = new Set(['system', 'netstandard', 'mscorlib', 'windowsbase']);

/** Name heuristic for shared-framework assemblies, used only when no framework list covers the name. */
export function looksLikeFramework(name: string): boolean {
  const l = name.toLowerCase();
  return l.startsWith('system.') || l.startsWith('microsoft.') || FRAMEWORK_SIMPLE_NAMES.has(l);
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface Index {
  manifest: AssemblyManifest;
  copiesByName: Map<string, ManifestAssembly[]>;
  frameworkByName: Map<string, FrameworkAssembly>;
  primary?: DepsModel;
  deps: DepsModel[];
  heuristicAllowed: boolean;
}

const isNeutral = (culture: string | null | undefined) => !culture || culture.toLowerCase() === 'neutral';

function buildIndex(manifest: AssemblyManifest, deps: DepsModel[], runtimeConfig: RuntimeConfigInfo | undefined): Index {
  const copiesByName = new Map<string, ManifestAssembly[]>();
  for (const a of manifest.assemblies) {
    if (!isNeutral(a.culture)) continue;
    const k = a.name.toLowerCase();
    const list = copiesByName.get(k);
    if (list) list.push(a);
    else copiesByName.set(k, [a]);
  }
  const frameworkByName = new Map<string, FrameworkAssembly>();
  for (const f of manifest.framework) if (!frameworkByName.has(f.name.toLowerCase())) frameworkByName.set(f.name.toLowerCase(), f);
  // The heuristic stays on when no framework list was given or a requested framework was not enumerated.
  const listed = new Set(manifest.framework.map((f) => f.framework.toLowerCase()));
  const heuristicAllowed =
    manifest.framework.length === 0 ||
    (manifest.frameworks ?? []).some((f) => f.usedVersion === null) ||
    (runtimeConfig?.frameworks ?? []).some((f) => !listed.has(f.name.toLowerCase()));
  return { manifest, copiesByName, frameworkByName, primary: deps.find((d) => d.primary), deps, heuristicAllowed };
}

function toCopy(a: ManifestAssembly, manifest: AssemblyManifest): AssemblyCopy {
  return { path: a.path, root: a.root, rootPath: manifest.roots[a.root] ?? `root ${a.root}`, version: a.version, fileVersion: a.fileVersion, rid: a.rid };
}

function rootLabel(idx: Index, root: number): string {
  const path = idx.manifest.roots[root];
  return root === 0 ? `the app folder${path ? ` (${path})` : ''}` : path || `root ${root}`;
}

/** The copy the host would use from one root: the best Windows RID asset, else the plain one. */
function bestInRoot(copies: ManifestAssembly[], root: number): ManifestAssembly | undefined {
  let best: ManifestAssembly | undefined;
  for (const c of copies) {
    if (c.root !== root || ridRank(c.rid) < 0) continue;
    if (!best || ridRank(c.rid) > ridRank(best.rid)) best = c;
  }
  return best;
}

function ownersOf(idx: Index, name: string, root: number): AssemblyOwner[] {
  const key = name.toLowerCase();
  const primary = idx.primary?.byAssembly[key] ?? [];
  const others = idx.deps.filter((d) => !d.primary).flatMap((d) => d.byAssembly[key] ?? []);
  return root === 0 ? [...primary, ...others] : [...others, ...primary];
}

function packageFor(idx: Index, name: string, version: string | undefined, root: number): PackageLink | undefined {
  const owners = ownersOf(idx, name, root);
  if (owners.length === 0) return undefined;
  const owner = (version ? owners.find((o) => o.assemblyVersion !== null && sameAssemblyVersion(o.assemblyVersion, version)) : undefined) ?? owners[0];
  if (!owner) return undefined;
  return { packageId: owner.packageId, packageVersion: owner.packageVersion, packageType: owner.packageType, depsFile: owner.depsFile, assemblyVersionInDeps: owner.assemblyVersion };
}

// ---------------------------------------------------------------------------
// Resolution and classification
// ---------------------------------------------------------------------------

interface Resolution {
  target?: BindingTarget;
  isFramework: boolean;
  notes: string[];
  /** Why there is no target, for the MISSING hint. */
  missingReason?: 'notInDeps' | 'otherRoot' | 'absent';
  missingCopy?: ManifestAssembly;
}

export function resolveTarget(requester: ManifestAssembly, ref: AssemblyRefInfo, idx: Index): Resolution {
  const notes: string[] = [];
  const key = ref.name.toLowerCase();
  const copies = idx.copiesByName.get(key) ?? [];
  const fw = idx.frameworkByName.get(key);

  // Plugin roots resolve locally first, then from the app folder; other plugin folders are not probed.
  let copy = requester.root !== 0 ? bestInRoot(copies, requester.root) : undefined;
  copy ??= bestInRoot(copies, 0);

  // A root-0 copy is loadable by the default context only when the app's deps.json lists it.
  let notInDeps: ManifestAssembly | undefined;
  if (copy && copy.root === 0 && idx.primary && !idx.primary.byAssembly[key]) {
    notInDeps = copy;
    copy = undefined;
  }

  if (copy && fw) {
    const fwVersion = parseAssemblyVersion(fw.version) ?? ZERO;
    const declaredText = copy.root === 0 && idx.primary ? (idx.primary.byAssembly[key]?.[0]?.assemblyVersion ?? null) : copy.version;
    const declared = parseAssemblyVersion(declaredText);
    if (declared && compareAssemblyVersions(declared, fwVersion) > 0) {
      notes.push(`App-local ${copy.version} overrides the shared framework's ${fw.version}.`);
    } else {
      notes.push(
        declared
          ? `The shared framework's ${fw.version} wins over the app-local ${copy.version} (higher or equal version).`
          : `The shared framework's ${fw.version} wins: deps.json records no assemblyVersion for the app-local copy (${copy.version}).`,
      );
      copy = undefined;
    }
  }

  if (copy) {
    if (copy.root !== requester.root && requester.root !== 0) notes.push(`Not in the requester's folder; resolved from ${rootLabel(idx, copy.root)}.`);
    return { target: { name: copy.name, version: copy.version, publicKeyToken: copy.publicKeyToken, source: 'manifest', path: copy.path, root: copy.root }, isFramework: false, notes };
  }
  if (fw) return { target: { name: fw.name, version: fw.version, publicKeyToken: fw.publicKeyToken ?? null, source: 'framework', framework: fw.framework }, isFramework: true, notes };
  if (notInDeps) return { isFramework: false, notes, missingReason: 'notInDeps', missingCopy: notInDeps };
  if (idx.heuristicAllowed && looksLikeFramework(ref.name)) {
    return { target: { name: ref.name, publicKeyToken: null, source: 'framework-assumed' }, isFramework: true, notes };
  }
  const elsewhere = copies.find((c) => c.root !== 0 && c.root !== requester.root);
  if (elsewhere) return { isFramework: false, notes, missingReason: 'otherRoot', missingCopy: elsewhere };
  return { isFramework: false, notes, missingReason: 'absent' };
}

export const CLASS_SEVERITY: Record<BindingClass, BindingSeverity> = {
  MISSING: 'error',
  TOO_OLD: 'error',
  // Binds on .NET (verified on 10.0.13); fails on .NET Framework.
  TOKEN_MISMATCH: 'warning',
  ROLL_FORWARD_MAJOR: 'warning',
  ROLL_FORWARD: 'info',
  EXACT: 'ok',
  FRAMEWORK_ASSUMED: 'info',
};

/** Precedence: MISSING > TOO_OLD > TOKEN_MISMATCH > ROLL_FORWARD_MAJOR > ROLL_FORWARD > EXACT. */
export function classifyReference(ref: AssemblyRefInfo, target: BindingTarget | undefined, isFramework: boolean): BindingClass {
  if (!target) return 'MISSING';
  if (target.source === 'framework-assumed') return 'FRAMEWORK_ASSUMED';
  const requested = parseAssemblyVersion(ref.version) ?? ZERO;
  const deployed = parseAssemblyVersion(target.version) ?? ZERO;
  const c = compareAssemblyVersions(deployed, requested);
  if (c < 0) return 'TOO_OLD';
  if (ref.publicKeyToken && target.publicKeyToken && ref.publicKeyToken !== target.publicKeyToken) return 'TOKEN_MISMATCH';
  if (c > 0) {
    // Framework assemblies roll forward across majors by design (System.Runtime 8.0.0.0 → 10.0.0.0).
    return deployed.parts[0] > requested.parts[0] && !isFramework ? 'ROLL_FORWARD_MAJOR' : 'ROLL_FORWARD';
  }
  return 'EXACT';
}

function describePackage(link: PackageLink | undefined, outside: string): string {
  if (!link) return outside;
  return `${link.packageType} ${link.packageVersion}`;
}

function hintFor(idx: Index, issue: Omit<BindingIssue, 'hint'>, res: Resolution): string | undefined {
  const req = issue.requester.name;
  const reqPkg = describePackage(issue.requesterPackage, 'outside deps.json');
  const ref = issue.reference;
  if (issue.classification === 'TOO_OLD' && issue.target) {
    const t = issue.target;
    if (t.source === 'framework') {
      return `${req} (${reqPkg}) was compiled against ${ref.name} ${ref.version}, newer than the ${t.framework || 'shared'} framework provides (${t.version}). Run on a newer .NET runtime, or rebuild ${req} for this one.`;
    }
    const shipped = issue.targetPackage
      ? `the deployed ${t.name} ${issue.targetPackage.packageType === 'package' ? 'package' : issue.targetPackage.packageType} ${issue.targetPackage.packageVersion} ships assembly ${t.version}`
      : `the deployed ${t.name} (outside deps.json) is assembly ${t.version}`;
    return `${req} (${reqPkg}) was compiled against ${ref.name} assembly ${ref.version}; ${shipped}. Either ${req} was built against a newer ${ref.name} than any published package, or this deployment is missing a newer ${ref.name}.`;
  }
  if (issue.classification === 'ROLL_FORWARD_MAJOR' && issue.target) {
    return `${req} was compiled against ${ref.name} ${ref.version}; ${issue.target.version} is deployed. It binds, but a new major version may have removed or changed APIs, which fails at first call with MissingMethodException or TypeLoadException.`;
  }
  if (issue.classification === 'TOKEN_MISMATCH' && issue.target) {
    return `${ref.name} is signed with a different key (reference ${ref.publicKeyToken}, deployed ${issue.target.publicKeyToken}). .NET binds anyway; .NET Framework would throw FileLoadException. Usually a locally built or re-signed copy replaced the published one.`;
  }
  if (issue.classification !== 'MISSING') return undefined;
  switch (res.missingReason) {
    case 'notInDeps':
      return `${[ref.name, res.missingCopy?.version].filter(Boolean).join(' ')} is in the app folder but not listed in ${idx.primary?.fileName ?? 'deps.json'}, so the default load context cannot load it (FileNotFoundException). Add the package or project reference that ships it, or load it through a plugin load context.`;
    case 'otherRoot':
      return `${req} (${reqPkg}) references ${ref.name} ${ref.version}; it is deployed only in ${rootLabel(idx, res.missingCopy?.root ?? 0)}, which ${req}'s load context does not probe.`;
    default: {
      const owners = ownersOf(idx, ref.name, issue.requester.root);
      const listed = owners[0] ? ` deps.json lists ${owners[0].packageId} ${owners[0].packageVersion}, but the file is not in any scanned folder.` : '';
      const where = idx.manifest.framework.length > 0 ? 'in any scanned folder or the shared framework list' : 'in any scanned folder';
      return `${req} (${reqPkg}) references ${ref.name} ${ref.version}, which is not deployed ${where}.${listed}`;
    }
  }
}

function tokenNote(ref: AssemblyRefInfo, target: BindingTarget | undefined): string | undefined {
  if (!target || target.source === 'framework-assumed') return undefined;
  const a = ref.publicKeyToken;
  const b = target.publicKeyToken;
  if (a === b || (a && b)) return undefined; // equal, or a full mismatch (TOKEN_MISMATCH)
  return `Public key token differs (reference ${a ?? 'null'}, deployed ${b ?? 'null'}). .NET ignores it when binding; .NET Framework would not.`;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface BindingAnalysisInput {
  inputs: BindingInputSummary[];
  deps: DepsModel[];
  manifests: AssemblyManifest[];
  runtimeConfigs: RuntimeConfigInfo[];
  scans?: ReferencerScan[];
  packageMap?: PackageAssemblyEntry[];
}

function choosePrimary(deps: DepsModel[], appName: string | undefined): DepsModel[] {
  if (deps.length === 0) return deps;
  const name = appName?.toLowerCase();
  const byName = name ? deps.findIndex((d) => d.fileName.replace(/^.*[\\/]/, '').toLowerCase() === `${name}.deps.json` || d.appId?.toLowerCase() === name) : -1;
  const index = byName >= 0 ? byName : 0;
  return deps.map((d, i) => ({ ...d, primary: i === index }));
}

/** Same simple name in several places with different versions. */
export function findMultipleCopies(manifest: AssemblyManifest): AssemblyCopies[] {
  const groups = new Map<string, ManifestAssembly[]>();
  for (const a of manifest.assemblies) {
    if (!isNeutral(a.culture)) continue;
    const k = a.name.toLowerCase();
    const list = groups.get(k);
    if (list) list.push(a);
    else groups.set(k, [a]);
  }
  const result: AssemblyCopies[] = [];
  for (const [key, list] of groups) {
    if (new Set(list.map((a) => a.version)).size < 2) continue;
    const copies = list
      .map((a) => toCopy(a, manifest))
      .sort((x, y) => compareAssemblyVersions(parseAssemblyVersion(x.version) ?? ZERO, parseAssemblyVersion(y.version) ?? ZERO) || x.root - y.root || x.path.localeCompare(y.path));
    result.push({ key, name: list[0]?.name ?? key, copies });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

export function analyzeBinding(input: BindingAnalysisInput): BindingResult {
  const warnings: string[] = [];
  const manifest = mergeManifests(input.manifests);
  if (input.manifests.length > 1) warnings.push(`Merged ${input.manifests.length} manifests; their roots are numbered in load order.`);
  const deps = choosePrimary(input.deps, manifest?.appName);
  const runtimeConfig = input.runtimeConfigs[0];
  if (input.runtimeConfigs.length > 1) warnings.push(`Several runtimeconfig.json files loaded; using ${runtimeConfig?.fileName}.`);
  for (const d of deps) for (const w of d.warnings) warnings.push(`${d.fileName}: ${w}`);

  const missing: BindingInputKind[] = [];
  if (deps.length === 0) missing.push('deps');
  if (!manifest) missing.push('manifest');
  const counts: Record<BindingSeverity, number> = { error: 0, warning: 0, info: 0, ok: 0 };
  const base = { inputs: input.inputs, deps, manifest, runtimeConfig, missing, counts, warnings, scans: input.scans ?? [], packageMap: input.packageMap ?? [] };
  if (!manifest) return { ...base, issues: [], copies: [] };

  const idx = buildIndex(manifest, deps, runtimeConfig);
  if (manifest.source === 'dll-upload' && manifest.framework.length === 0) {
    warnings.push('No framework list: framework references are resolved by name only. Load the manifest from Export-AssemblyManifest.ps1 for full accuracy.');
  }
  let unparsed = 0;
  const issues: BindingIssue[] = [];
  for (const a of manifest.assemblies) {
    if (!isNeutral(a.culture)) continue;
    if (!parseAssemblyVersion(a.version)) unparsed++;
    const requesterPackage = packageFor(idx, a.name, a.version, a.root);
    for (const ref of a.references) {
      if (!parseAssemblyVersion(ref.version)) unparsed++;
      const res = resolveTarget(a, ref, idx);
      const classification = classifyReference(ref, res.target, res.isFramework);
      const targetPackage = res.target?.source === 'manifest' ? packageFor(idx, res.target.name, res.target.version, res.target.root ?? 0) : undefined;
      const notes = [...res.notes];
      const tn = tokenNote(ref, res.target);
      if (tn) notes.push(tn);
      if (targetPackage?.assemblyVersionInDeps && res.target?.version && !sameAssemblyVersion(targetPackage.assemblyVersionInDeps, res.target.version)) {
        notes.push(`${targetPackage.depsFile} lists ${res.target.name} as ${targetPackage.assemblyVersionInDeps}, but the file on disk is ${res.target.version}.`);
      }
      const issue: Omit<BindingIssue, 'hint'> = {
        rowId: `${a.root}|${a.path}|${ref.name}|${ref.version}`,
        severity: CLASS_SEVERITY[classification],
        classification,
        requester: { name: a.name, version: a.version, path: a.path, root: a.root, publicKeyToken: a.publicKeyToken },
        requesterPackage,
        reference: ref,
        target: res.target,
        targetPackage,
        isFramework: res.isFramework,
        notes,
      };
      issues.push({ ...issue, hint: hintFor(idx, issue, res) });
      counts[issue.severity]++;
    }
  }
  if (unparsed > 0) warnings.push(`${unparsed} assembly version${unparsed === 1 ? '' : 's'} could not be parsed and were treated as 0.0.0.0.`);
  const order: Record<BindingSeverity, number> = { error: 0, warning: 1, info: 2, ok: 3 };
  issues.sort((x, y) => order[x.severity] - order[y.severity] || x.requester.name.localeCompare(y.requester.name) || x.reference.name.localeCompare(y.reference.name));
  return { ...base, issues, copies: findMultipleCopies(manifest) };
}

/** Parses every input (kind detected per file) and analyzes them together. */
export function analyzeBindingInputs(texts: BindingInputText[]): BindingResult {
  const input: BindingAnalysisInput = { inputs: [], deps: [], manifests: [], runtimeConfigs: [], scans: [], packageMap: [] };
  for (const t of texts) {
    const r = parseBindingInput(t);
    if (!r.ok) {
      input.inputs.push({ inputId: t.inputId, fileName: t.fileName, error: r.error });
      continue;
    }
    input.inputs.push({ inputId: t.inputId, fileName: t.fileName, kind: r.kind });
    if (r.kind === 'deps') input.deps.push(r.deps);
    else if (r.kind === 'manifest') input.manifests.push(r.manifest);
    else if (r.kind === 'runtimeconfig') input.runtimeConfigs.push(r.runtimeConfig);
    else if (r.kind === 'referencer') input.scans?.push(r.scan);
    else input.packageMap?.push(...r.packageMap);
  }
  return analyzeBinding(input);
}

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/**
 * Origin of a deps.json library or an assembly name: the existing classification when the Id was in
 * the analyzed assets files, else deps.json's project type, else the system/internal prefix rules.
 */
export function bindingOriginResolver(classification: ClassifyOutput | undefined, settings: Pick<ClassifySettings, 'systemPrefixes' | 'internalPrefixes'>) {
  return (id: string, packageType?: string): Origin | undefined => {
    const classified = classification?.byId[id.toLowerCase()];
    if (classified) return classified.origin;
    if (packageType === 'project') return 'Project';
    if (matchPrefix(id, settings.systemPrefixes)) return 'System';
    if (matchPrefix(id, settings.internalPrefixes)) return 'Private';
    return undefined;
  };
}

/** true / false when known; undefined when the origin cannot be determined. */
export function isInternalSide(origin: Origin | undefined): boolean | undefined {
  if (origin === undefined || origin === 'Unclassified') return undefined;
  return isInternalOrigin(origin);
}

/**
 * Whether a row survives the "internal only" filter: hidden only when both the requester and the
 * target are known to be non-internal. A requester outside deps.json with no matching rule counts as
 * internal, since that is usually a plugin folder.
 */
export function rowIsInternal(issue: BindingIssue, originOf: (id: string, packageType?: string) => Origin | undefined): boolean {
  const requester = issue.requesterPackage
    ? isInternalSide(originOf(issue.requesterPackage.packageId, issue.requesterPackage.packageType))
    : (isInternalSide(originOf(issue.requester.name)) ?? true);
  if (requester !== false) return true;
  if (issue.isFramework) return false;
  const target = issue.targetPackage ? isInternalSide(originOf(issue.targetPackage.packageId, issue.targetPackage.packageType)) : isInternalSide(originOf(issue.reference.name));
  return target !== false;
}

// ---------------------------------------------------------------------------
// Version correlation
// ---------------------------------------------------------------------------

/**
 * Package version ↔ assemblyVersion ↔ fileVersion for internal packages, sorted by package version.
 * A row is non-monotonic when another package has a lower package version but a higher assembly
 * version (or the reverse): the two numbers are stamped from inconsistent sources.
 */
export function buildCorrelation(deps: DepsModel[], isInternal: (packageKey: IdKey, packageType: string) => boolean): CorrelationRow[] {
  const rows: CorrelationRow[] = [];
  const seen = new Set<string>();
  for (const d of deps) {
    for (const owners of Object.values(d.byAssembly)) {
      for (const o of owners) {
        if (o.packageType !== 'package' || !isInternal(o.packageId.toLowerCase(), o.packageType)) continue;
        const k = `${o.packageId.toLowerCase()}/${o.packageVersion.toLowerCase()}/${o.path.replace(/^.*[\\/]/, '').toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ packageId: o.packageId, packageVersion: o.packageVersion, assembly: o.path.replace(/^.*[\\/]/, ''), assemblyVersion: o.assemblyVersion, fileVersion: o.fileVersion, depsFile: o.depsFile, nonMonotonic: false, conflictsWith: [] });
      }
    }
  }
  rows.sort((a, b) => compareVersionStrings(a.packageVersion, b.packageVersion) || a.packageId.localeCompare(b.packageId) || a.assembly.localeCompare(b.assembly));
  const parsed = rows.map((r) => parseAssemblyVersion(r.assemblyVersion));
  for (let i = 0; i < rows.length; i++) {
    const vi = parsed[i];
    if (!vi) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const vj = parsed[j];
      const ri = rows[i] as CorrelationRow;
      const rj = rows[j] as CorrelationRow;
      if (!vj || compareVersionStrings(ri.packageVersion, rj.packageVersion) >= 0) continue;
      if (compareAssemblyVersions(vi, vj) <= 0) continue;
      ri.nonMonotonic = true;
      rj.nonMonotonic = true;
      if (ri.conflictsWith.length < 5) ri.conflictsWith.push({ packageId: rj.packageId, packageVersion: rj.packageVersion, assemblyVersion: rj.assemblyVersion as string });
      if (rj.conflictsWith.length < 5) rj.conflictsWith.push({ packageId: ri.packageId, packageVersion: ri.packageVersion, assemblyVersion: ri.assemblyVersion as string });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Error lookup
// ---------------------------------------------------------------------------

const DISPLAY_NAME_RE = /'([A-Za-z0-9_.-]+)((?:\s*,\s*[A-Za-z]+\s*=\s*[^,']*)*)'/g;
const EXCEPTION_RE = /\b((?:System\.(?:IO\.|Reflection\.)?)?(?:FileNotFoundException|FileLoadException|BadImageFormatException|TypeLoadException|MissingMethodException|MissingFieldException|ReflectionTypeLoadException))\b/g;

/**
 * Finds assembly display names in pasted exception text, e.g.
 * "Could not load file or assembly 'Model.Import, Version=10.0.0.34377, Culture=neutral, PublicKeyToken=null'".
 * Also matches "from assembly '…'" (TypeLoadException). Returns one entry per distinct name + version.
 */
export function parseLoadErrors(text: string): ParsedLoadError[] {
  const exceptions = [...text.matchAll(EXCEPTION_RE)].map((m) => ({ index: m.index ?? 0, name: (m[1] as string).replace(/^System\.(IO\.|Reflection\.)?/, '') }));
  const out: ParsedLoadError[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(DISPLAY_NAME_RE)) {
    const attrs = new Map<string, string>();
    for (const part of (m[2] ?? '').split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) attrs.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    const version = attrs.get('version');
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    // Accept a bare quoted name only right after "assembly", so ordinary quoted words are ignored.
    if (!version && !/assembly\s*$/i.test(before)) continue;
    if (version && !parseAssemblyVersion(version)) continue;
    const name = m[1] as string;
    const key = `${name.toLowerCase()}/${version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const token = attrs.get('publickeytoken');
    const exception = [...exceptions].reverse().find((e) => e.index < (m.index ?? 0))?.name ?? exceptions[0]?.name;
    out.push({
      raw: m[0],
      exception,
      name,
      version,
      culture: attrs.get('culture'),
      publicKeyToken: token === undefined ? undefined : token.toLowerCase() === 'null' ? null : token.toLowerCase(),
    });
  }
  return out;
}

export function deployedInfo(result: BindingResult, name: string): DeployedInfo {
  const key = name.toLowerCase();
  const manifest = result.manifest;
  return {
    copies: manifest ? manifest.assemblies.filter((a) => a.name.toLowerCase() === key && isNeutral(a.culture)).map((a) => toCopy(a, manifest)) : [],
    framework: manifest?.framework.find((f) => f.name.toLowerCase() === key),
    owners: result.deps.flatMap((d) => d.byAssembly[key] ?? []),
  };
}

export const NO_REQUESTER_VERDICT = 'no requester in provided inputs → likely dynamically loaded from a folder not included';

export function lookupLoadError(result: BindingResult, error: ParsedLoadError): ErrorLookupResult {
  const key = error.name.toLowerCase();
  const sameName = result.issues.filter((i) => i.reference.name.toLowerCase() === key);
  const requesters = sameName.filter((i) => !error.version || sameAssemblyVersion(i.reference.version, error.version));
  const others = new Map<string, Set<string>>();
  for (const i of sameName) {
    if (requesters.includes(i)) continue;
    const set = others.get(i.reference.version) ?? new Set<string>();
    set.add(i.requester.name);
    others.set(i.reference.version, set);
  }
  const otherVersions = [...others.entries()]
    .map(([version, names]) => ({ version, requesters: [...names].sort() }))
    .sort((a, b) => compareAssemblyVersions(parseAssemblyVersion(a.version) ?? ZERO, parseAssemblyVersion(b.version) ?? ZERO));
  const deployed = deployedInfo(result, error.name);
  const label = `${error.name}${error.version ? ` ${error.version}` : ''}`;

  let verdict: string;
  if (requesters.length === 0) {
    verdict = NO_REQUESTER_VERDICT;
    if (otherVersions.length > 0) verdict += `. Other versions are referenced: ${otherVersions.map((o) => `${o.version} by ${o.requesters.join(', ')}`).join('; ')}.`;
  } else {
    const names = [...new Set(requesters.map((r) => r.requester.name))];
    const failing = requesters.filter((r) => r.severity === 'error');
    const target = requesters.find((r) => r.target)?.target;
    const fwLabel = target?.source === 'framework' ? ` (shared framework${target.framework ? ` ${target.framework}` : ''})` : '';
    const deployedText = target?.version ? `${target.version}${fwLabel}` : 'nothing';
    verdict = `${names.length} requester${names.length === 1 ? ' references' : 's reference'} ${label}:${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}. Deployed: ${deployedText}.`;
    verdict += failing.length > 0
      ? ` ${failing[0]?.classification === 'MISSING' ? 'Not loadable' : 'Deployed version is lower'}: this explains the exception.`
      : ' These inputs bind, so the failing process probably ran from a different folder or with an older copy than the one scanned.';
  }
  return { error, requesters, otherVersions, deployed, verdict };
}
