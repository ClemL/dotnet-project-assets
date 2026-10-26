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
