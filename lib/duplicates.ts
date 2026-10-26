// Duplicate and conflict detection.

import { selectTargets } from './graph';
import type {
  AnalyzeOptions,
  CaseCollision,
  CrossFileDrift,
  Duplicates,
  IdKey,
  ProjectModel,
  RangeConflict,
  RangeParent,
  RedundantDirectRef,
  TargetGraph,
  TfmDuplicate,
} from './types';
import { compareVersions, compareVersionStrings, parseVersion, rangeMin, satisfiesText } from './versions';

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The same Id resolved at different versions across the targets of one file. */
export function findTfmDuplicates(model: ProjectModel, opts: AnalyzeOptions): TfmDuplicate[] {
  const byKey = new Map<IdKey, { id: string; byTarget: { target: string; version: string }[] }>();
  for (const target of selectTargets(model, opts)) {
    for (const [key, node] of Object.entries(target.nodes)) {
      let entry = byKey.get(key);
      if (!entry) {
        entry = { id: node.id, byTarget: [] };
        byKey.set(key, entry);
      }
      entry.byTarget.push({ target: target.key, version: node.version });
    }
  }
  const result: TfmDuplicate[] = [];
  for (const [key, entry] of byKey) {
    if (new Set(entry.byTarget.map((t) => t.version)).size > 1) {
      result.push({ project: model.label, fileName: model.fileName, key, id: entry.id, byTarget: entry.byTarget });
    }
  }
  return result.sort((a, b) => byText(a.key, b.key));
}

/** The same package Id resolved at different versions across projects (cross-repo drift). */
export function findCrossFileDrift(models: ProjectModel[], opts: AnalyzeOptions): CrossFileDrift[] {
  const byKey = new Map<IdKey, { id: string; versions: Map<string, Map<string, string[]>> }>();
  for (const model of models) {
    for (const target of selectTargets(model, opts)) {
      for (const [key, node] of Object.entries(target.nodes)) {
        if (node.type !== 'package') continue;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { id: node.id, versions: new Map() };
          byKey.set(key, entry);
        }
        let projects = entry.versions.get(node.version);
        if (!projects) {
          projects = new Map();
          entry.versions.set(node.version, projects);
        }
        const tfms = projects.get(model.label) ?? [];
        if (!tfms.includes(target.key)) tfms.push(target.key);
        projects.set(model.label, tfms);
      }
    }
  }
  const result: CrossFileDrift[] = [];
  for (const [key, entry] of byKey) {
    if (entry.versions.size < 2) continue;
    const allProjects = new Set<string>();
    for (const p of entry.versions.values()) for (const name of p.keys()) allProjects.add(name);
    if (allProjects.size < 2) continue;
    result.push({
      key,
      id: entry.id,
      versions: [...entry.versions.entries()]
        .sort(([a], [b]) => compareVersionStrings(a, b))
        .map(([version, projects]) => ({
          version,
          projects: [...projects.entries()].sort(([a], [b]) => byText(a, b)).map(([project, tfms]) => ({ project, tfms })),
        })),
    });
  }
  return result.sort((a, b) => byText(a.key, b.key));
}

function parentsByChild(model: ProjectModel, target: TargetGraph): Map<IdKey, RangeParent[]> {
  const parents = new Map<IdKey, RangeParent[]>();
  const add = (child: IdKey, p: Omit<RangeParent, 'satisfied'>) => {
    const node = target.nodes[child];
    if (!node) return;
    const satisfied = p.range.trim() === '' ? true : satisfiesText(p.range, node.version);
    const list = parents.get(child) ?? [];
    list.push({ ...p, satisfied });
    parents.set(child, list);
  };
  for (const root of target.roots) {
    if (root.kind === 'projectReference') continue;
    add(root.id.toLowerCase(), { parent: model.projectName, parentVersion: model.projectVersion, range: root.range });
  }
  for (const node of Object.values(target.nodes)) {
    for (const [childId, range] of Object.entries(node.dependencies)) {
      add(childId.toLowerCase(), { parent: node.id, parentVersion: node.version, range });
    }
  }
  return parents;
}

/**
 * For each Id requested by more than one parent, or requested with a range its resolved version
 * does not satisfy: every parent and its range. `hasConflict` marks the unsatisfied ones.
 */
export function findRangeConflicts(model: ProjectModel, opts: AnalyzeOptions): RangeConflict[] {
  const result: RangeConflict[] = [];
  for (const target of selectTargets(model, opts)) {
    for (const [key, parents] of parentsByChild(model, target)) {
      const node = target.nodes[key];
      if (!node) continue;
      const hasConflict = parents.some((p) => p.satisfied === false);
      const distinctRanges = new Set(parents.map((p) => p.range.replace(/\s+/g, ''))).size;
      if (!hasConflict && distinctRanges < 2) continue;
      result.push({
        project: model.label,
        target: target.key,
        key,
        id: node.id,
        resolved: node.version,
        hasConflict,
        parents: parents.sort((a, b) => byText(a.parent.toLowerCase(), b.parent.toLowerCase())),
      });
    }
  }
  return result.sort((a, b) => byText(a.key, b.key) || byText(a.target, b.target));
}

/** Direct references that are also pulled in transitively by another direct reference. */
export function findRedundantDirectRefs(model: ProjectModel, opts: AnalyzeOptions): RedundantDirectRef[] {
  const result: RedundantDirectRef[] = [];
  for (const target of selectTargets(model, opts)) {
    const succ = new Map<IdKey, IdKey[]>();
    for (const [key, node] of Object.entries(target.nodes)) {
      succ.set(
        key,
        Object.keys(node.dependencies)
          .map((d) => d.toLowerCase())
          .filter((d) => target.nodes[d] !== undefined),
      );
    }
    const rootKeys = target.roots.map((r) => r.id.toLowerCase()).filter((k) => target.nodes[k] !== undefined);

    // Shortest path from each root to every node it reaches.
    const pathsFrom = new Map<IdKey, Map<IdKey, IdKey[]>>();
    for (const r of rootKeys) {
      const prev = new Map<IdKey, IdKey>();
      const reached = new Map<IdKey, IdKey[]>();
      const queue: IdKey[] = [r];
      const seen = new Set<IdKey>([r]);
      while (queue.length > 0) {
        const cur = queue.shift() as IdKey;
        for (const next of succ.get(cur) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          prev.set(next, cur);
          queue.push(next);
        }
      }
      for (const k of seen) {
        if (k === r) continue;
        const path: IdKey[] = [k];
        for (let p = prev.get(k); p !== undefined; p = prev.get(p)) path.unshift(p);
        reached.set(k, path);
      }
      pathsFrom.set(r, reached);
    }

    for (const root of target.roots) {
      const k = root.id.toLowerCase();
      const node = target.nodes[k];
      if (!node) continue;
      const via: IdKey[][] = [];
      for (const other of rootKeys) {
        if (other === k) continue;
        const p = pathsFrom.get(other)?.get(k);
        if (p) via.push(p);
      }
      if (via.length === 0) continue;
      via.sort((a, b) => a.length - b.length || byText(a.join('/'), b.join('/')));

      // Highest minimum version any transitive parent asks for.
      let transitiveMax: ReturnType<typeof parseVersion> = null;
      for (const parent of Object.values(target.nodes)) {
        for (const [childId, range] of Object.entries(parent.dependencies)) {
          if (childId.toLowerCase() !== k) continue;
          const min = rangeMin(range);
          if (min && (!transitiveMax || compareVersions(min, transitiveMax) > 0)) transitiveMax = min;
        }
      }
      const directMin = root.kind === 'packageReference' ? rangeMin(root.range) : undefined;
      const likelyPin = !!directMin && !!transitiveMax && compareVersions(directMin, transitiveMax) > 0;

      result.push({
        project: model.label,
        target: target.key,
        key: k,
        id: node.id,
        kind: root.kind,
        directRange: root.range,
        resolved: node.version,
        via: via.slice(0, 3).map((p) => p.map((x) => target.nodes[x]?.id ?? x)),
        likelyPin,
      });
    }
  }
  return result.sort((a, b) => byText(a.key, b.key) || byText(a.target, b.target));
}

/** Ids that appear with more than one casing across all files. */
export function findCaseCollisions(models: ProjectModel[], opts: AnalyzeOptions): CaseCollision[] {
  const byKey = new Map<IdKey, Map<string, Set<string>>>();
  const add = (id: string, project: string) => {
    const key = id.toLowerCase();
    let spellings = byKey.get(key);
    if (!spellings) {
      spellings = new Map();
      byKey.set(key, spellings);
    }
    const projects = spellings.get(id) ?? new Set<string>();
    projects.add(project);
    spellings.set(id, projects);
  };
  for (const model of models) {
    add(model.projectName, model.label);
    for (const target of selectTargets(model, opts)) {
      // Resolved node Ids only: casing inside a parent's dependency list comes from that parent's
      // nuspec and differs harmlessly far too often to be useful.
      for (const node of Object.values(target.nodes)) add(node.id, model.label);
    }
  }
  const result: CaseCollision[] = [];
  for (const [key, spellings] of byKey) {
    if (spellings.size < 2) continue;
    result.push({
      key,
      spellings: [...spellings.entries()]
        .sort(([a], [b]) => byText(a, b))
        .map(([id, projects]) => ({ id, projects: [...projects].sort(byText) })),
    });
  }
  return result.sort((a, b) => byText(a.key, b.key));
}

export function findDuplicates(models: ProjectModel[], opts: AnalyzeOptions): Duplicates {
  return {
    tfm: models.flatMap((m) => findTfmDuplicates(m, opts)),
    drift: findCrossFileDrift(models, opts),
    ranges: models.flatMap((m) => findRangeConflicts(m, opts)),
    redundant: models.flatMap((m) => findRedundantDirectRefs(m, opts)),
    caseCollisions: findCaseCollisions(models, opts),
  };
}
