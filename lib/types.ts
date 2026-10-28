// Shared model types. Everything here is plain data (records and arrays) so it can be
// structured-cloned to/from the Web Worker and serialized straight into the JSON export.

/** Lowercase package/project Id. Nodes merge on this key. */
export type IdKey = string;

export type NodeType = 'package' | 'project';

export type InputKind = 'paste' | 'file' | 'folder';

// ---------------------------------------------------------------------------
// Parsed model (lib/parse.ts)
// ---------------------------------------------------------------------------

export interface TargetNode {
  /** Id with the casing used in the targets key. */
  id: string;
  /** Resolved version, normalized. */
  version: string;
  type: NodeType;
  /** Child Id (original casing) → requested range string, exactly as written in the file. */
  dependencies: Record<string, string>;
}

/** One entry of project.frameworks[alias].dependencies, as written by NuGet. */
export interface DeclaredDep {
  id: string;
  /** "version" exactly as written, e.g. "[10.0.*-*, )"; empty when absent. */
  range: string;
  /** versionCentrallyManaged (written only when true). */
  centrallyManaged: boolean;
  /** autoReferenced (written only when true), e.g. implicit SDK references. */
  autoReferenced: boolean;
  /** versionOverride under Central Package Management. */
  versionOverride?: string;
}

export type TriState = 'enabled' | 'disabled' | 'unknown';

/**
 * Restore settings from project.restore. NuGet writes these flags only when they are set (true),
 * so an absent flag is "unknown", never "disabled".
 */
export interface RestoreFlags {
  /** restoreLockProperties.restorePackagesWithLockFile (a string: "true" / "false"). */
  lockFile: TriState;
  /** restoreLockProperties.restoreLockedMode. */
  lockedMode: TriState;
  lockFilePath?: string;
  /** centralPackageVersionsManagementEnabled. */
  cpm: TriState;
  /** Where the CPM state came from: the restore flag, versionCentrallyManaged on a dependency, or nothing. */
  cpmEvidence: 'restore' | 'dependency' | 'none';
  /** CentralPackageTransitivePinningEnabled (capital C in the file). */
  transitivePinning: TriState;
}

export interface DirectDep {
  id: string;
  /** Requested range as a NuGet range string ("[1.0.0, )"); empty for project references. */
  range: string;
  kind: 'packageReference' | 'projectReference';
}

export interface TargetGraph {
  /** Raw targets key, e.g. "net8.0" or "net8.0/win-x64". */
  key: string;
  /** Normalized framework part, e.g. "net8.0". */
  tfm: string;
  rid?: string;
  nodes: Record<IdKey, TargetNode>;
  roots: DirectDep[];
  /** project.frameworks[alias].dependencies for this target's framework (empty when absent). */
  declared: DeclaredDep[];
}

export interface ProjectModel {
  inputId: string;
  fileName: string;
  projectName: string;
  /** Unique display label across all loaded files (projectName, disambiguated if needed). */
  label: string;
  projectPath?: string;
  projectVersion: string;
  /** Keys of project.restore.sources. */
  sources: string[];
  restoreFlags: RestoreFlags;
  /**
   * "<id-lower>/<version-lower>" → whether libraries[*].files lists a .signature.p7s (nuget.org
   * repository-signs every package; internal feeds usually serve unsigned ones). Absent when the
   * library has no files list.
   */
  librarySigned: Record<string, boolean>;
  targets: TargetGraph[];
  warnings: string[];
}

export interface ParseError {
  inputId: string;
  fileName: string;
  message: string;
}

export type ParseResult = { ok: true; model: ProjectModel } | { ok: false; error: ParseError };

// ---------------------------------------------------------------------------
// Graphs (lib/graph.ts)
// ---------------------------------------------------------------------------

export interface ProjectTfm {
  project: string;
  tfm: string;
}

export interface MergedNode {
  key: IdKey;
  /** Distinct original casings. */
  spellings: string[];
  types: NodeType[];
  versions: { version: string; usedBy: ProjectTfm[] }[];
  directIn: (ProjectTfm & { range: string })[];
  /** True when this node is the owning project of a loaded assets file. */
  isRootProject: boolean;
}

export interface EdgeUsage {
  project: string;
  tfm: string;
  fromVersion: string;
  range: string;
}

export interface MergedEdge {
  from: IdKey;
  to: IdKey;
  usages: EdgeUsage[];
}

export interface MergedGraph {
  nodes: Record<IdKey, MergedNode>;
  edges: MergedEdge[];
  projects: string[];
}

export type TreeNodeKind = 'expanded' | 'repeat' | 'cycle' | 'missing';

export interface DepTreeNode {
  uid: string;
  key: IdKey;
  id: string;
  /** Requested range from the parent ("" for project references). */
  range: string;
  resolved?: string;
  type?: NodeType;
  /**
   * expanded: first occurrence, children listed.
   * repeat:   already expanded elsewhere, rendered with (*); refUid points at that occurrence.
   * cycle:    the Id is already on the current path; refUid points at the ancestor.
   * missing:  the parent requests an Id that has no entry in this target.
   */
  kind: TreeNodeKind;
  refUid?: string;
  children: DepTreeNode[];
}

export interface CollapsedEdge {
  from: IdKey;
  to: IdKey;
  /** Example chain of non-internal nodes between from and to (empty for a direct edge). */
  via: IdKey[];
  /** Projects/versions that contributed the first hop of that chain. */
  sources: { project: string; fromVersion: string }[];
}

export interface CollapsedGraph {
  nodes: IdKey[];
  edges: CollapsedEdge[];
}

export type BuildOrder =
  | { ok: true; waves: IdKey[][] }
  | {
      ok: false;
      /** Each cycle is a closed path: [a, b, c, a]. */
      cycles: IdKey[][];
      /** Waves that could still be computed before the cycle blocked progress. */
      partialWaves: IdKey[][];
      /** Nodes that could not be placed in any wave. */
      blocked: IdKey[];
    };

export interface BuildOrderView {
  graph: CollapsedGraph;
  order: BuildOrder;
}

// ---------------------------------------------------------------------------
// Duplicates (lib/duplicates.ts)
// ---------------------------------------------------------------------------

export interface TfmDuplicate {
  project: string;
  fileName: string;
  key: IdKey;
  id: string;
  byTarget: { target: string; version: string }[];
}

export interface CrossFileDrift {
  key: IdKey;
  id: string;
  versions: { version: string; projects: { project: string; tfms: string[] }[] }[];
}

export interface RangeParent {
  parent: string;
  parentVersion?: string;
  range: string;
  /** null when the range string could not be parsed. */
  satisfied: boolean | null;
}

export interface RangeConflict {
  project: string;
  target: string;
  key: IdKey;
  id: string;
  resolved: string;
  /** True when at least one parent range is not satisfied by the resolved version. */
  hasConflict: boolean;
  parents: RangeParent[];
}

export interface RedundantDirectRef {
  project: string;
  target: string;
  key: IdKey;
  id: string;
  kind: DirectDep['kind'];
  directRange: string;
  resolved: string;
  /** Up to three shortest paths (Ids) from another direct dependency to this one. */
  via: string[][];
  /** The direct reference raises the version above every transitive minimum, so it is probably an intentional pin. */
  likelyPin: boolean;
}

export interface CaseCollision {
  key: IdKey;
  spellings: { id: string; projects: string[] }[];
}

export interface Duplicates {
  tfm: TfmDuplicate[];
  drift: CrossFileDrift[];
  ranges: RangeConflict[];
  redundant: RedundantDirectRef[];
  caseCollisions: CaseCollision[];
}

// ---------------------------------------------------------------------------
// Classification (lib/classify.ts, lib/metadata.ts)
// ---------------------------------------------------------------------------

export type Origin = 'Project' | 'System' | 'Private' | 'PrivateInferred' | 'Public' | 'Unclassified';

export const ORIGINS: readonly Origin[] = ['Project', 'System', 'Private', 'PrivateInferred', 'Public', 'Unclassified'];

export type ReasonCode =
  | 'override'
  | 'metadata-public'
  | 'metadata-system'
  | 'metadata-internal-feed'
  | 'project'
  | 'system-prefix'
  | 'internal-prefix'
  | 'signature-signed'
  | 'signature-unsigned'
  | 'nuget-listed'
  | 'nuget-unlisted-version'
  | 'nuget-not-found'
  | 'nuget-error'
  | 'nuget-pending'
  | 'offline';

export interface Classification {
  origin: Origin;
  code: ReasonCode;
  /** Human-readable reason, including any metadata notes that fell through. */
  reason: string;
}

export interface ClassifySettings {
  systemPrefixes: string[];
  internalPrefixes: string[];
  internalFeeds: string[];
  offline: boolean;
  /** Keep using internal-feed metadata even when the feed looks like a nuget.org proxy. */
  trustProxyFeedMetadata: boolean;
}

export type NugetLookup =
  | { status: 'found'; versions: string[]; fetchedAt: number }
  | { status: 'notFound'; fetchedAt: number }
  | { status: 'error'; message: string };

/** "<id-lower>/<version-lower>" → source (feed URL or local path). */
export type SourceMap = Record<string, string>;

export interface PackageRef {
  key: IdKey;
  id: string;
  version: string;
  types: NodeType[];
  isRootProject: boolean;
  /** .signature.p7s present in libraries[*].files; undefined when no files list was available. */
  signed?: boolean;
}

export interface ClassifyInput {
  packages: PackageRef[];
  settings: ClassifySettings;
  lookups: Record<IdKey, NugetLookup>;
  metadata: SourceMap;
  overrides: Record<IdKey, Origin>;
}

export interface IdClassification {
  origin: Origin;
  /** Versions of this Id were classified differently. */
  mixed: boolean;
  /** One entry per version: "13.0.3: nuget.org: version listed". */
  reasons: string[];
}

export interface ProxyWarning {
  feed: string;
  publicLookingCount: number;
  /** Whether metadata from this feed is being ignored as a result. */
  ignored: boolean;
}

export interface ClassifyOutput {
  /** Keyed by "<id-lower>/<version-lower>". */
  byPackage: Record<string, Classification>;
  byId: Record<IdKey, IdClassification>;
  proxyWarning?: ProxyWarning;
  coverage: { withMetadata: number; total: number };
  /** Ids that still need a nuget.org lookup (no earlier rule decided them). */
  lookupCandidates: IdKey[];
}

// ---------------------------------------------------------------------------
// Analysis (lib/analyze.ts)
// ---------------------------------------------------------------------------

export type Directness = 'Direct' | 'Transitive' | 'Mixed';

export interface DependencyRow {
  key: IdKey;
  id: string;
  versions: string[];
  types: NodeType[];
  directness: Directness;
  /** Projects that reference this Id directly. */
  directIn: string[];
  /** Projects whose graph contains this Id at all. */
  projects: string[];
}

export interface AnalyzeOptions {
  /** Include runtime-specific targets such as "net8.0/win-x64". */
  includeRidTargets: boolean;
}

export interface ScopeAnalysis {
  /** "merged" or the inputId of a single file. */
  scopeId: string;
  label: string;
  graph: MergedGraph;
  rows: DependencyRow[];
  duplicates: Duplicates;
}

export interface PrefixSuggestion {
  prefix: string;
  count: number;
  examples: string[];
}

export interface AnalysisResult {
  options: AnalyzeOptions;
  models: ProjectModel[];
  errors: ParseError[];
  merged: ScopeAnalysis;
  files: ScopeAnalysis[];
  packages: PackageRef[];
  suggestions: { internalPrefixes: PrefixSuggestion[]; internalFeeds: string[] };
}

// ---------------------------------------------------------------------------
// Binding check (lib/bindingInputs.ts, lib/binding.ts)
// ---------------------------------------------------------------------------

export type BindingInputKind = 'deps' | 'manifest' | 'runtimeconfig' | 'referencer' | 'packageMap';

/** One runtime asset of a deps.json library. deps.json records file paths, not assembly names. */
export interface DepsAsset {
  path: string;
  /** File name without ".dll". */
  assemblyName: string;
  /** null when the entry has no assemblyVersion field ("unknown"). */
  assemblyVersion: string | null;
  fileVersion: string | null;
  /** From runtimeTargets ("win", "win-x64"); undefined for plain runtime assets. */
  rid?: string;
}

export interface AssemblyOwner {
  packageId: string;
  packageVersion: string;
  /** deps.json libraries[].type: "package", "project", or "reference". */
  packageType: string;
  assemblyVersion: string | null;
  fileVersion: string | null;
  path: string;
  rid?: string;
  depsFile: string;
}

export interface DepsGap {
  packageId: string;
  packageVersion: string;
  packageType: string;
  path: string;
  /** True for the application's own entry, which never carries an assemblyVersion. */
  expected: boolean;
}

export interface DepsModel {
  inputId: string;
  fileName: string;
  /** runtimeTarget.name, e.g. ".NETCoreApp,Version=v10.0" or ".NETCoreApp,Version=v10.0/win-x64". */
  runtimeTarget: string;
  /** The application's deps.json: decides what the default load context can load. */
  primary: boolean;
  /** Id of the application's own entry, when identified. */
  appId?: string;
  libraryCount: number;
  /** "<id-lower>/<version-lower>" → runtime assets. */
  byPackage: Record<string, DepsAsset[]>;
  /** Assembly name (lowercase) → owning packages. More than one entry means two packages ship the same file. */
  byAssembly: Record<string, AssemblyOwner[]>;
  gaps: DepsGap[];
  warnings: string[];
}

export interface AssemblyRefInfo {
  name: string;
  version: string;
  publicKeyToken: string | null;
  culture?: string | null;
}

export interface ManifestAssembly {
  /** Path relative to roots[root] (or absolute). */
  path: string;
  root: number;
  name: string;
  version: string;
  publicKeyToken: string | null;
  fileVersion: string | null;
  culture?: string | null;
  rid?: string | null;
  references: AssemblyRefInfo[];
}

export interface FrameworkAssembly {
  name: string;
  version: string;
  framework: string;
  publicKeyToken?: string | null;
}

export interface FrameworkFolder {
  name: string;
  requestedVersion: string;
  /** null when no folder with the same major.minor was installed. */
  usedVersion: string | null;
  exact: boolean;
  path: string | null;
}

export interface AssemblyManifest {
  schema: 1;
  generatedAt: string;
  appName?: string;
  roots: string[];
  assemblies: ManifestAssembly[];
  framework: FrameworkAssembly[];
  frameworks?: FrameworkFolder[];
  skipped?: Record<string, number>;
  source: 'script' | 'dll-upload';
  /** Input files merged into this manifest. */
  fileNames: string[];
}

export interface RuntimeConfigInfo {
  fileName: string;
  frameworks: { name: string; version: string }[];
  rollForward?: string;
  selfContained: boolean;
}

export type BindingClass = 'MISSING' | 'TOO_OLD' | 'TOKEN_MISMATCH' | 'ROLL_FORWARD_MAJOR' | 'ROLL_FORWARD' | 'EXACT' | 'FRAMEWORK_ASSUMED';
export type BindingSeverity = 'error' | 'warning' | 'info' | 'ok';
export type TargetSource = 'manifest' | 'framework' | 'framework-assumed';

export interface PackageLink {
  packageId: string;
  packageVersion: string;
  packageType: string;
  depsFile: string;
  assemblyVersionInDeps: string | null;
}

export interface BindingTarget {
  name: string;
  /** Version the reference binds to; for "framework-assumed" there is none. */
  version?: string;
  publicKeyToken: string | null;
  source: TargetSource;
  path?: string;
  root?: number;
  framework?: string;
}

export interface BindingIssue {
  rowId: string;
  severity: BindingSeverity;
  classification: BindingClass;
  requester: { name: string; version: string; path: string; root: number; publicKeyToken: string | null };
  /** undefined → "outside deps.json (dynamically loaded?)". */
  requesterPackage?: PackageLink;
  reference: AssemblyRefInfo;
  target?: BindingTarget;
  targetPackage?: PackageLink;
  /** Target is a shared-framework assembly (listed or assumed). */
  isFramework: boolean;
  hint?: string;
  notes: string[];
}

export interface AssemblyCopy {
  path: string;
  root: number;
  rootPath: string;
  version: string;
  fileVersion: string | null;
  rid?: string | null;
}

export interface AssemblyCopies {
  key: string;
  name: string;
  copies: AssemblyCopy[];
}

export interface CorrelationRow {
  packageId: string;
  packageVersion: string;
  assembly: string;
  assemblyVersion: string | null;
  fileVersion: string | null;
  depsFile: string;
  nonMonotonic: boolean;
  /** Packages that invert the order: lower package version with a higher assembly version, or the reverse. */
  conflictsWith: { packageId: string; packageVersion: string; assemblyVersion: string }[];
}

export interface ParsedLoadError {
  raw: string;
  exception?: string;
  name: string;
  version?: string;
  culture?: string;
  /** undefined when the message has no PublicKeyToken part; null for "PublicKeyToken=null". */
  publicKeyToken?: string | null;
}

export interface DeployedInfo {
  copies: AssemblyCopy[];
  framework?: FrameworkAssembly;
  owners: AssemblyOwner[];
}

export interface ErrorLookupResult {
  error: ParsedLoadError;
  requesters: BindingIssue[];
  /** Same name, other versions. */
  otherVersions: { version: string; requesters: string[] }[];
  deployed: DeployedInfo;
  verdict: string;
}

export interface BindingInputSummary {
  inputId: string;
  fileName: string;
  kind?: BindingInputKind;
  error?: string;
}

export interface BindingResult {
  inputs: BindingInputSummary[];
  deps: DepsModel[];
  manifest?: AssemblyManifest;
  runtimeConfig?: RuntimeConfigInfo;
  /** Required inputs that are absent (deps, manifest). */
  missing: BindingInputKind[];
  issues: BindingIssue[];
  copies: AssemblyCopies[];
  counts: Record<BindingSeverity, number>;
  warnings: string[];
  /** Referencer scans (Fix Planner input). */
  scans: ReferencerScan[];
  /** Package → assembly map entries from Export-PackageAssemblyMap.ps1 (Fix Planner input). */
  packageMap: PackageAssemblyEntry[];
}

// ---------------------------------------------------------------------------
// Version skew (lib/versions.ts, lib/skew.ts, lib/floating.ts)
// ---------------------------------------------------------------------------

/** How two versions differ: 'build' when a lag is computable, otherwise the highest differing part. */
export type VersionDiff = 'equal' | 'build' | 'major' | 'minor' | 'patch' | 'revision' | 'prerelease';

export type RangeKind = 'floatingPrerelease' | 'floatingStable' | 'openEnded' | 'bounded' | 'pinned' | 'unknown';

export type Severity = 'none' | 'info' | 'low' | 'medium' | 'high';

export type RebuildSeverity = 'low' | 'medium' | 'high';

export interface SkewSettings {
  /** Regex source; capture group 1 is the build number. */
  buildNumberPattern: string;
  /** Minimum spread/lag for each severity. */
  thresholds: { low: number; medium: number; high: number };
  rebuildMinSeverity: RebuildSeverity;
  cascade: boolean;
  includePublic: boolean;
}

export interface SkewEdge {
  target: string;
  tfm: string;
  childKey: IdKey;
  /** Casing from the resolved targets key. */
  child: string;
  resolvedVersion: string;
  childOrigin?: Origin;
  parentKey: IdKey;
  parent: string;
  parentVersion: string;
  parentOrigin?: Origin;
  /** Range exactly as written. */
  requestedRange: string;
  /** Lower bound; the resolved version for a satisfied float; undefined without a lower bound. */
  requestedVersion?: string;
  requestedBuild: number | null;
  resolvedBuild: number | null;
  diff: VersionDiff;
  /** resolved build − requested build; null → "n/a (semver)". */
  lag: number | null;
  stale: boolean;
  severity: Severity;
  isDirect: boolean;
  isFloating: boolean;
  /** Projects (file labels) whose graph contains this edge. */
  projects: string[];
}

export interface RequestedGroup {
  requestedVersion: string;
  build: number | null;
  requesters: { parent: string; parentKey: IdKey; isDirect: boolean; range: string }[];
}

export interface SkewRow {
  rowId: string;
  target: string;
  tfm: string;
  childKey: IdKey;
  child: string;
  origin?: Origin;
  resolvedVersion: string;
  resolvedBuild: number | null;
  /** Ascending by requested version. */
  groups: RequestedGroup[];
  /** Every in-scope edge into the child, for the expanded view. */
  edges: SkewEdge[];
  oldestRequested: string;
  oldestRequesters: string[];
  oldestRequesterKeys: IdKey[];
  spread: number | null;
  spreadDiff: VersionDiff;
  severity: Severity;
  /** Projects that resolve this version (merged view). */
  shippedBy: string[];
  /** Other versions of the same package resolved by other projects for the same target (cross-project drift). */
  drift: string[];
}

export interface ConsumerRow {
  parentKey: IdKey;
  parent: string;
  versions: string[];
  origin?: Origin;
  isRootProject: boolean;
  staleEdges: number;
  oldestInRow: number;
  maxLag: number | null;
  medianLag: number | null;
  worstDiff: VersionDiff;
  severity: Severity;
  action: string;
}

export interface RebuildStep {
  wave: number;
  key: IdKey;
  id: string;
  origin?: Origin;
  reason: 'stale' | 'cascade';
  /** stale: the outdated dependencies; cascade: the rebuilt packages it consumes. */
  because: string[];
}

export interface RebuildPlan {
  minSeverity: RebuildSeverity;
  cascade: boolean;
  steps: RebuildStep[];
  /** Cycles among the rebuild set (no complete order exists). */
  cycles: IdKey[][];
  blocked: IdKey[];
}

export interface CasingNote {
  key: IdKey;
  /** Casing of the resolved targets key. */
  display: string;
  variants: { spelling: string; seenIn: string[] }[];
}

export interface SkewReport {
  internal: SkewRow[];
  public: SkewRow[];
  consumers: ConsumerRow[];
  outlier?: { consumer: ConsumerRow; message: string };
  rebuild: RebuildPlan;
  casing: CasingNote[];
  counts: Record<'high' | 'medium' | 'low', number>;
  warnings: string[];
}

export interface FloatingRef {
  project: string;
  target: string;
  key: IdKey;
  id: string;
  range: string;
  kind: RangeKind;
  severity: Severity;
  centrallyManaged: boolean;
  autoReferenced: boolean;
  versionOverride?: string;
  resolvedVersion?: string;
  origin?: Origin;
  /** Internal consumers that request an older version than the float resolved to. */
  olderConsumers?: { min: string; max: string; parents: string[]; rowId?: string };
  note?: string;
}

export interface FloatingReport {
  refs: FloatingRef[];
  restore: { project: string; flags: RestoreFlags }[];
  floatingCount: number;
  /** Floating references exist and at least one of their projects has no lock file detected. */
  recommend: boolean;
  snippets: { lockFile: string; cpm: string };
}

// ---------------------------------------------------------------------------
// Fix Planner (lib/fixplanner.ts)
// ---------------------------------------------------------------------------

export interface ReferencerRow {
  kind: 'REFERENCER' | 'DEPLOYED';
  /** File name as given ("Plugin.Excel.dll"). */
  dll: string;
  /** Assembly simple name (file name without .dll / .exe). */
  assembly: string;
  /** The row's own AssemblyVersion. */
  version: string;
  /** REFERENCER rows: the version of the target assembly this DLL was compiled against. */
  refersTo?: string;
  path?: string;
}

export interface ReferencerScan {
  source: 'table' | 'csv' | 'manifest' | 'binding';
  fileName: string;
  /** The scanned assembly, from the DEPLOYED rows; undefined when the scan has none. */
  target?: string;
  rows: ReferencerRow[];
  warnings: string[];
}

export interface PackageAssemblyEntry {
  id: string;
  packageVersion: string;
  dll: string;
  assemblyVersion: string;
  fileVersion: string | null;
  tfm: string;
}

export interface OwnerLink {
  packageId: string;
  packageVersion?: string;
  /** deps.json maps the file to its package; "by name" assumes the package Id equals the assembly name. */
  match: 'deps.json' | 'by name';
}

export interface FailureRequester {
  assembly: string;
  dll: string;
  version: string;
  refersTo: string;
  status: 'FAIL' | 'OK';
  /** refersTo − deployed on the 4th component when major.minor.build match; null otherwise. */
  delta: number | null;
  owner?: OwnerLink;
  path?: string;
}

export interface FailureSummary {
  target: string;
  targetOwner?: OwnerLink;
  deployed?: { version: string; source: 'scan' | 'manifest' | 'deps.json'; others: string[] };
  /** max(RefersTo): the lowest deployed version every requester binds to. */
  requiredMinimum: string;
  requesters: FailureRequester[];
  failCount: number;
  okCount: number;
  /** Version named in the pasted exception (the first failure the runtime hit), if any. */
  errorVersion?: string;
}

export interface StampedAssembly {
  assembly: string;
  /** Distinct versions observed (references to it and its own AssemblyVersion), ascending. */
  versions: string[];
  referencedVersions: number;
  nonZeroRevision: boolean;
  maxRevision: number;
}

export interface StampingReport {
  stamped: StampedAssembly[];
  /** Internal assemblies seen only at one x.y.z.0 version. */
  fixedBaseline: number;
  /** Internal assemblies observed. */
  baselineTotal: number;
  /** outlier: fixed assemblies outnumber stamped ones; codebase-wide: they do not. */
  mode: 'none' | 'outlier' | 'codebase-wide';
}

export interface PinCandidate {
  packageVersion: string;
  assemblyVersion: string;
  fileVersion: string | null;
  tfm: string;
  /** assemblyVersion ≥ the required minimum. */
  bindsAll: boolean;
  /** packageVersion ≥ every package-level minimum for the target in the graph (else NU1605 on restore). */
  meetsNuGetMinimum: boolean;
}

export interface PinPlan {
  packageId: string;
  candidates: PinCandidate[];
  recommended?: PinCandidate;
  nugetMinimum?: { version: string; requestedBy: string[] };
  snippet?: string;
  cpmSnippet?: string;
  /** Requesters that will bind to a higher version than they were compiled against. */
  rollForward: FailureRequester[];
  feedSearch: string;
  noneReason?: string;
}

export interface CascadeRow {
  /** Global wave index (0-based) over the fix graph. */
  wave: number;
  key: IdKey;
  id: string;
  reason: { kind: 'target' } | { kind: 'dependsOn'; on: string[] };
  failRequester: boolean;
  placement: 'assets' | 'dll-references';
}

export interface CascadePlan {
  start?: IdKey;
  startId?: string;
  rows: CascadeRow[];
  cycles: IdKey[][];
  /** Why there is no cascade (no assets files, target not in the graph, …). */
  unavailable?: string;
}
