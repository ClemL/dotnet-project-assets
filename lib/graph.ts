// Graph construction and algorithms: merge, dependency tree, why-paths, internal collapse,
// Kahn waves, and cycle detection.

import type {
  AnalyzeOptions,
  BuildOrder,
  BuildOrderView,
  CollapsedEdge,
  CollapsedGraph,
  DepTreeNode,
  IdKey,
  MergedEdge,
  MergedGraph,
  MergedNode,
  NodeType,
  ProjectModel,
  TargetGraph,
} from './types';

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTextCi = (a: string, b: string) => byText(a.toLowerCase(), b.toLowerCase());

/** Targets included in analysis: runtime-specific ones only when requested. */
export function selectTargets(model: ProjectModel, opts: AnalyzeOptions): TargetGraph[] {
  return model.targets.filter((t) => opts.includeRidTargets || !t.rid);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Merges every selected target of every model into one graph keyed by lowercase Id. */
export function buildMergedGraph(models: ProjectModel[], opts: AnalyzeOptions): MergedGraph {
  const nodes: Record<IdKey, MergedNode> = {};
  const edges = new Map<string, MergedEdge>();

  const ensureNode = (id: string, type: NodeType): MergedNode => {
    const key = id.toLowerCase();
    let n = nodes[key];
    if (!n) {
      n = { key, spellings: [], types: [], versions: [], directIn: [], isRootProject: false };
      nodes[key] = n;
    }
    if (!n.spellings.includes(id)) n.spellings.push(id);
    if (!n.types.includes(type)) n.types.push(type);
    return n;
  };
  const addVersion = (n: MergedNode, version: string, project: string, tfm: string) => {
    let v = n.versions.find((x) => x.version === version);
    if (!v) {
      v = { version, usedBy: [] };
      n.versions.push(v);
    }
    if (!v.usedBy.some((u) => u.project === project && u.tfm === tfm)) v.usedBy.push({ project, tfm });
  };
  const addEdge = (from: IdKey, to: IdKey, usage: MergedEdge['usages'][number]) => {
    if (from === to) return;
    const k = `${from}\u0000${to}`;
    let e = edges.get(k);
    if (!e) {
      e = { from, to, usages: [] };
      edges.set(k, e);
    }
    e.usages.push(usage);
  };

  for (const model of models) {
    const projectKey = model.projectName.toLowerCase();
    const rootNode = ensureNode(model.projectName, 'project');
    rootNode.isRootProject = true;
    for (const target of selectTargets(model, opts)) {
      // The owning project gets no version usage of its own: versions record who depends on a node.
      for (const [key, node] of Object.entries(target.nodes)) {
        const merged = ensureNode(node.id, node.type);
        addVersion(merged, node.version, model.label, target.key);
        for (const [childId, range] of Object.entries(node.dependencies)) {
          const childKey = childId.toLowerCase();
          if (!target.nodes[childKey]) continue;
          addEdge(key, childKey, { project: model.label, tfm: target.key, fromVersion: node.version, range });
        }
      }
      for (const root of target.roots) {
        const k = root.id.toLowerCase();
        const merged = nodes[k];
        if (!target.nodes[k] || !merged) continue;
        addEdge(projectKey, k, { project: model.label, tfm: target.key, fromVersion: model.projectVersion, range: root.range });
        merged.directIn.push({ project: model.label, tfm: target.key, range: root.range });
      }
    }
  }

  return {
    nodes,
    edges: [...edges.values()].sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to)),
    projects: models.map((m) => m.label),
  };
}

// ---------------------------------------------------------------------------
// Dependency tree
// ---------------------------------------------------------------------------

/**
 * Builds the dependency tree of one target, rooted at its direct dependencies. Each Id is
 * expanded at its first occurrence (depth-first, children sorted by Id); later occurrences are
 * "repeat" nodes pointing at it, and an Id already on the current path is a "cycle" node.
 */
export function buildTree(target: TargetGraph): DepTreeNode[] {
  let counter = 0;
  const firstUid = new Map<IdKey, string>();
  const onPath = new Map<IdKey, string>();

  const visit = (id: string, range: string): DepTreeNode => {
    const key = id.toLowerCase();
    const uid = `n${counter++}`;
    const node = target.nodes[key];
    if (!node) return { uid, key, id, range, kind: 'missing', children: [] };
    const base = { uid, key, id: node.id, range, resolved: node.version, type: node.type };
    const ancestor = onPath.get(key);
    if (ancestor) return { ...base, kind: 'cycle', refUid: ancestor, children: [] };
    const first = firstUid.get(key);
    if (first) return { ...base, kind: 'repeat', refUid: first, children: [] };
    firstUid.set(key, uid);
    onPath.set(key, uid);
    const children = Object.entries(node.dependencies)
      .sort(([a], [b]) => byTextCi(a, b))
      .map(([childId, childRange]) => visit(childId, childRange));
    onPath.delete(key);
    return { ...base, kind: 'expanded', children };
  };

  return [...target.roots].sort((a, b) => byTextCi(a.id, b.id)).map((r) => visit(r.id, r.range));
}

/** uid → parent uid (undefined for top-level nodes). Used to expand ancestors when jumping to a node. */
export function treeParents(roots: DepTreeNode[]): Map<string, string | undefined> {
  const parents = new Map<string, string | undefined>();
  const stack: [DepTreeNode, string | undefined][] = roots.map((r) => [r, undefined]);
  while (stack.length > 0) {
    const [node, parent] = stack.pop() as [DepTreeNode, string | undefined];
    parents.set(node.uid, parent);
    for (const c of node.children) stack.push([c, node.uid]);
  }
  return parents;
}

function successors(target: TargetGraph): Map<IdKey, IdKey[]> {
  const succ = new Map<IdKey, IdKey[]>();
  for (const [key, node] of Object.entries(target.nodes)) {
    succ.set(
      key,
      Object.keys(node.dependencies)
        .map((d) => d.toLowerCase())
        .filter((d) => target.nodes[d] !== undefined),
    );
  }
  return succ;
}

/** Every Id that lies on some path to `key` (its ancestors), plus `key` itself. */
export function pathNodesTo(target: TargetGraph, key: IdKey): Set<IdKey> {
  const preds = new Map<IdKey, IdKey[]>();
  for (const [from, tos] of successors(target)) {
    for (const to of tos) {
      const list = preds.get(to);
      if (list) list.push(from);
      else preds.set(to, [from]);
    }
  }
  const result = new Set<IdKey>();
  if (!target.nodes[key]) return result;
  const queue = [key];
  result.add(key);
  while (queue.length > 0) {
    const cur = queue.shift() as IdKey;
    for (const p of preds.get(cur) ?? []) {
      if (!result.has(p)) {
        result.add(p);
        queue.push(p);
      }
    }
  }
  return result;
}

/**
 * Enumerates paths from the direct dependencies to `key` (the `dotnet nuget why` view).
 * Stops after `limit` paths.
 */
export function whyPaths(target: TargetGraph, key: IdKey, limit = 500): { paths: IdKey[][]; truncated: boolean } {
  const onAnyPath = pathNodesTo(target, key);
  const succ = successors(target);
  const paths: IdKey[][] = [];
  let truncated = false;
  const path: IdKey[] = [];
  const onStack = new Set<IdKey>();

  const dfs = (cur: IdKey): void => {
    if (truncated) return;
    path.push(cur);
    onStack.add(cur);
    if (cur === key) {
      if (paths.length >= limit) truncated = true;
      else paths.push([...path]);
    } else {
      for (const next of succ.get(cur) ?? []) {
        if (onAnyPath.has(next) && !onStack.has(next)) dfs(next);
        if (truncated) break;
      }
    }
    onStack.delete(cur);
    path.pop();
  };

  for (const root of [...target.roots].sort((a, b) => byTextCi(a.id, b.id))) {
    const k = root.id.toLowerCase();
    if (onAnyPath.has(k)) dfs(k);
    if (truncated) break;
  }
  return { paths, truncated };
}

/** Cycles inside one target's resolved graph. */
export function targetCycles(target: TargetGraph): IdKey[][] {
  const succ = successors(target);
  const edges: { from: IdKey; to: IdKey }[] = [];
  for (const [from, tos] of succ) for (const to of tos) edges.push({ from, to });
  return findCycles(Object.keys(target.nodes), edges);
}

// ---------------------------------------------------------------------------
// Cycles (Tarjan SCC, iterative)
// ---------------------------------------------------------------------------

function stronglyConnected(nodes: IdKey[], succ: Map<IdKey, IdKey[]>): IdKey[][] {
  let index = 0;
  const idx = new Map<IdKey, number>();
  const low = new Map<IdKey, number>();
  const onStack = new Set<IdKey>();
  const stack: IdKey[] = [];
  const sccs: IdKey[][] = [];

  const open = (v: IdKey) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
  };

  for (const start of nodes) {
    if (idx.has(start)) continue;
    open(start);
    const work: { v: IdKey; i: number }[] = [{ v: start, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1] as { v: IdKey; i: number };
      const next = succ.get(frame.v) ?? [];
      if (frame.i < next.length) {
        const w = next[frame.i++] as IdKey;
        if (!idx.has(w)) {
          open(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v) as number, idx.get(w) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v) as number, low.get(frame.v) as number));
      if (low.get(frame.v) === idx.get(frame.v)) {
        const scc: IdKey[] = [];
        let w: IdKey;
        do {
          w = stack.pop() as IdKey;
          onStack.delete(w);
          scc.push(w);
        } while (w !== frame.v);
        sccs.push(scc);
      }
    }
  }
  return sccs;
}

/**
 * Returns one representative cycle per strongly connected component (plus self-loops), each as a
 * closed path starting and ending at the component's alphabetically first node.
 */
export function findCycles(nodes: IdKey[], edges: { from: IdKey; to: IdKey }[]): IdKey[][] {
  const nodeSet = new Set(nodes);
  const succ = new Map<IdKey, IdKey[]>();
  for (const n of nodes) succ.set(n, []);
  const selfLoops = new Set<IdKey>();
  for (const e of edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    if (e.from === e.to) selfLoops.add(e.from);
    else (succ.get(e.from) as IdKey[]).push(e.to);
  }
  for (const list of succ.values()) list.sort(byText);

  const cycles: IdKey[][] = [];
  for (const scc of stronglyConnected([...nodes].sort(byText), succ)) {
    if (scc.length === 1) {
      const only = scc[0] as IdKey;
      if (selfLoops.has(only)) cycles.push([only, only]);
      continue;
    }
    const members = new Set(scc);
    const start = [...scc].sort(byText)[0] as IdKey;
    // BFS for the shortest way back to start, staying inside the component.
    const prev = new Map<IdKey, IdKey>();
    const queue: IdKey[] = [];
    for (const s of succ.get(start) ?? []) {
      if (members.has(s) && !prev.has(s)) {
        prev.set(s, start);
        queue.push(s);
      }
    }
    let closing: IdKey | undefined;
    while (queue.length > 0 && closing === undefined) {
      const cur = queue.shift() as IdKey;
      for (const s of succ.get(cur) ?? []) {
        if (s === start) {
          closing = cur;
          break;
        }
        if (members.has(s) && !prev.has(s)) {
          prev.set(s, cur);
          queue.push(s);
        }
      }
    }
    if (closing === undefined) continue;
    const path: IdKey[] = [start];
    for (let cur: IdKey | undefined = closing; cur !== undefined && cur !== start; cur = prev.get(cur)) path.splice(1, 0, cur);
    path.push(start);
    cycles.push(path);
  }
  return cycles.sort((a, b) => byText(a[0] as string, b[0] as string));
}

// ---------------------------------------------------------------------------
// Internal collapse + build order
// ---------------------------------------------------------------------------

/**
 * Projects the graph onto internal nodes: internal A → (any chain of non-internal nodes) →
 * internal B becomes A → B. The search stops at the first internal node on each branch.
 */
export function collapseToInternal(graph: MergedGraph, isInternal: (key: IdKey) => boolean): CollapsedGraph {
  const out = new Map<IdKey, MergedEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }
  const internal = Object.keys(graph.nodes).filter(isInternal).sort(byText);
  const edges: CollapsedEdge[] = [];

  for (const a of internal) {
    const visited = new Set<IdKey>([a]);
    const found = new Map<IdKey, CollapsedEdge>();
    const queue: { key: IdKey; via: IdKey[]; first: MergedEdge }[] = [];
    const reach = (to: IdKey, via: IdKey[], first: MergedEdge) => {
      if (visited.has(to)) return;
      visited.add(to);
      if (isInternal(to)) {
        const seen = new Set<string>();
        const sources = first.usages
          .map((u) => ({ project: u.project, fromVersion: u.fromVersion }))
          .filter((s) => {
            const k = `${s.project}\u0000${s.fromVersion}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        found.set(to, { from: a, to, via, sources });
      } else {
        queue.push({ key: to, via: [...via, to], first });
      }
    };
    for (const e of out.get(a) ?? []) reach(e.to, [], e);
    while (queue.length > 0) {
      const cur = queue.shift() as { key: IdKey; via: IdKey[]; first: MergedEdge };
      for (const e of out.get(cur.key) ?? []) reach(e.to, cur.via, cur.first);
    }
    edges.push(...[...found.values()].sort((x, y) => byText(x.to, y.to)));
  }
  return { nodes: internal, edges };
}

/**
 * Kahn's algorithm grouped into waves: wave 1 holds nodes with no internal dependencies, wave n
 * holds nodes whose dependencies are all in earlier waves. Edge from → to means "from depends on to".
 */
export function kahnWaves(nodes: IdKey[], edges: { from: IdKey; to: IdKey }[]): BuildOrder {
  const nodeSet = new Set(nodes);
  const pending = new Map<IdKey, number>();
  const dependents = new Map<IdKey, IdKey[]>();
  for (const n of nodes) pending.set(n, 0);
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to || !nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    const k = `${e.from}\u0000${e.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pending.set(e.from, (pending.get(e.from) as number) + 1);
    const list = dependents.get(e.to);
    if (list) list.push(e.from);
    else dependents.set(e.to, [e.from]);
  }

  const waves: IdKey[][] = [];
  let current = nodes.filter((n) => pending.get(n) === 0).sort(byText);
  while (current.length > 0) {
    waves.push(current);
    const next: IdKey[] = [];
    for (const n of current) {
      pending.delete(n);
      for (const d of dependents.get(n) ?? []) {
        const left = (pending.get(d) as number) - 1;
        pending.set(d, left);
        if (left === 0) next.push(d);
      }
    }
    current = next.sort(byText);
  }

  if (pending.size === 0) return { ok: true, waves };
  const blocked = [...pending.keys()].sort(byText);
  return { ok: false, cycles: findCycles(blocked, edges), partialWaves: waves, blocked };
}

export function computeBuildOrder(graph: MergedGraph, isInternal: (key: IdKey) => boolean): BuildOrderView {
  const collapsed = collapseToInternal(graph, isInternal);
  return { graph: collapsed, order: kahnWaves(collapsed.nodes, collapsed.edges) };
}
