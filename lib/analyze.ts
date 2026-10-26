// Analysis pipeline: parse → per-file and merged scopes → classification-independent results.
// Classification and build order are computed separately because they change with settings.

import { classifyAll, isInternalOrigin, suggestInternalPrefixes } from './classify';
import { findDuplicates } from './duplicates';
import { buildMergedGraph, computeBuildOrder, selectTargets } from './graph';
import { suggestInternalFeeds } from './metadata';
import { assignLabels, parseAssetsJson, type ParseInput } from './parse';
import type {
  AnalysisResult,
  AnalyzeOptions,
  BuildOrderView,
  ClassifyInput,
  ClassifyOutput,
  DependencyRow,
  IdKey,
  MergedGraph,
  NodeType,
  PackageRef,
  ParseError,
  ProjectModel,
  ScopeAnalysis,
} from './types';
import { compareVersionStrings } from './version';

export const MERGED_SCOPE = 'merged';

export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = { includeRidTargets: false };

export function parseInputs(inputs: ParseInput[], onProgress?: (done: number, total: number, fileName: string) => void): {
  models: ProjectModel[];
  errors: ParseError[];
} {
  const models: ProjectModel[] = [];
  const errors: ParseError[] = [];
  inputs.forEach((input, i) => {
    const r = parseAssetsJson(input);
    if (r.ok) models.push(r.model);
    else errors.push(r.error);
    onProgress?.(i + 1, inputs.length, input.fileName);
  });
  return { models: assignLabels(models), errors };
}

/** Dependency list rows. A file's own project is listed only when another file depends on it. */
export function buildDependencyRows(graph: MergedGraph): DependencyRow[] {
  const rows: DependencyRow[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.versions.length === 0) continue;
    const usages = node.versions.flatMap((v) => v.usedBy);
    const projects = [...new Set(usages.map((u) => u.project))].sort();
    const directIn = [...new Set(node.directIn.map((d) => d.project))].sort();
    // Direct or transitive per project+target pair.
    const pairs = new Set(usages.map((u) => `${u.project}\u0000${u.tfm}`));
    const directPairs = new Set(node.directIn.map((d) => `${d.project}\u0000${d.tfm}`));
    const directness = directPairs.size === 0 ? 'Transitive' : directPairs.size >= pairs.size ? 'Direct' : 'Mixed';
    rows.push({
      key: node.key,
      id: node.spellings[0] ?? node.key,
      versions: node.versions.map((v) => v.version).sort(compareVersionStrings),
      types: [...node.types].sort(),
      directness,
      directIn,
      projects,
    });
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function analyzeScope(scopeId: string, label: string, models: ProjectModel[], opts: AnalyzeOptions): ScopeAnalysis {
  const graph = buildMergedGraph(models, opts);
  return { scopeId, label, graph, rows: buildDependencyRows(graph), duplicates: findDuplicates(models, opts) };
}

/** Distinct Id+version pairs (with the node types seen for each), including the files' own projects. */
export function collectPackages(models: ProjectModel[], opts: AnalyzeOptions): PackageRef[] {
  const map = new Map<string, PackageRef>();
  const add = (id: string, version: string, type: NodeType, isRootProject: boolean) => {
    const k = `${id.toLowerCase()}/${version.toLowerCase()}`;
    let p = map.get(k);
    if (!p) {
      p = { key: id.toLowerCase(), id, version, types: [], isRootProject: false };
      map.set(k, p);
    }
    if (!p.types.includes(type)) p.types.push(type);
    if (isRootProject) p.isRootProject = true;
  };
  for (const m of models) {
    add(m.projectName, m.projectVersion, 'project', true);
    for (const t of selectTargets(m, opts)) for (const n of Object.values(t.nodes)) add(n.id, n.version, n.type, false);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : compareVersionStrings(a.version, b.version)));
}

export function analyzeModels(models: ProjectModel[], errors: ParseError[], opts: AnalyzeOptions, systemPrefixes: readonly string[]): AnalysisResult {
  const projectIds = new Set<string>();
  for (const m of models) {
    projectIds.add(m.projectName);
    for (const t of m.targets) for (const n of Object.values(t.nodes)) if (n.type === 'project') projectIds.add(n.id);
  }
  return {
    options: opts,
    models,
    errors,
    merged: analyzeScope(MERGED_SCOPE, models.length === 1 ? (models[0] as ProjectModel).label : 'Merged', models, opts),
    files: models.map((m) => analyzeScope(m.inputId, m.label, [m], opts)),
    packages: collectPackages(models, opts),
    suggestions: {
      internalPrefixes: suggestInternalPrefixes([...projectIds], systemPrefixes),
      internalFeeds: suggestInternalFeeds(models.flatMap((m) => m.sources)),
    },
  };
}

export interface ClassifiedResult {
  classification: ClassifyOutput;
  /** Build order per scope id ("merged" or an inputId). */
  buildOrders: Record<string, BuildOrderView>;
}

export interface BuildOrderOptions {
  /** Include type: project nodes (and the files' own projects) in the build order. */
  includeProjects: boolean;
}

export function classifyAndOrder(analysis: AnalysisResult, input: Omit<ClassifyInput, 'packages'>, opts: BuildOrderOptions): ClassifiedResult {
  const classification = classifyAll({ ...input, packages: analysis.packages });
  const isInternal = (key: IdKey) => {
    const c = classification.byId[key];
    if (!c || !isInternalOrigin(c.origin)) return false;
    return opts.includeProjects || c.origin !== 'Project';
  };
  const buildOrders: Record<string, BuildOrderView> = {};
  for (const scope of [analysis.merged, ...analysis.files]) buildOrders[scope.scopeId] = computeBuildOrder(scope.graph, isInternal);
  return { classification, buildOrders };
}

export function scopeOf(analysis: AnalysisResult, scopeId: string): ScopeAnalysis {
  return analysis.files.find((f) => f.scopeId === scopeId) ?? analysis.merged;
}

export function modelsOf(analysis: AnalysisResult, scopeId: string): ProjectModel[] {
  return scopeId === MERGED_SCOPE ? analysis.models : analysis.models.filter((m) => m.inputId === scopeId);
}
