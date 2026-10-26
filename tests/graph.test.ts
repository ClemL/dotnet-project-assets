import { describe, expect, it } from 'vitest';
import { classifyAndOrder, MERGED_SCOPE } from '../lib/analyze';
import { DEFAULT_SETTINGS } from '../lib/classify';
import { buildTree, collapseToInternal, findCycles, kahnWaves, pathNodesTo, targetCycles, treeParents, whyPaths } from '../lib/graph';
import type { ClassifySettings, DepTreeNode, TargetGraph } from '../lib/types';
import { analyzeFixtures, loadModels } from './helpers';

const offlineAcme: ClassifySettings = { ...DEFAULT_SETTINGS, offline: true, internalPrefixes: ['Acme.'] };

function flatten(nodes: DepTreeNode[]): DepTreeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

function target(fixture: string): TargetGraph {
  const t = loadModels(fixture)[0]?.targets[0];
  if (!t) throw new Error('no target');
  return t;
}

describe('diamond dependency', () => {
  it('expands the shared node once and marks the second occurrence (*)', () => {
    const tree = buildTree(target('diamond.assets.json'));
    expect(tree.map((n) => n.id)).toEqual(['Lib.A', 'Lib.B']);
    const all = flatten(tree);
    const cs = all.filter((n) => n.key === 'lib.c');
    expect(cs.map((n) => n.kind)).toEqual(['expanded', 'repeat']);
    expect(cs[1]?.refUid).toBe(cs[0]?.uid);
    expect(cs[0]?.range).toBe('1.0.0');
    expect(cs[1]?.range).toBe('1.1.0');
    expect(cs[0]?.resolved).toBe('1.1.0');
    // Lib.D appears once, under the expanded Lib.C.
    expect(all.filter((n) => n.key === 'lib.d').length).toBe(1);
    const parents = treeParents(tree);
    expect(parents.get(cs[0]?.uid ?? '')).toBe(tree[0]?.uid);
  });

  it('finds both paths to the shared leaf (nuget why)', () => {
    const t = target('diamond.assets.json');
    expect(whyPaths(t, 'lib.d')).toEqual({
      paths: [
        ['lib.a', 'lib.c', 'lib.d'],
        ['lib.b', 'lib.c', 'lib.d'],
      ],
      truncated: false,
    });
    expect([...pathNodesTo(t, 'lib.c')].sort()).toEqual(['lib.a', 'lib.b', 'lib.c']);
    expect(whyPaths(t, 'lib.d', 1)).toEqual({ paths: [['lib.a', 'lib.c', 'lib.d']], truncated: true });
  });

  it('merges into one graph with the project as root', () => {
    const a = analyzeFixtures('diamond.assets.json');
    expect(a.merged.graph.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      'diamondapp>lib.a',
      'diamondapp>lib.b',
      'lib.a>lib.c',
      'lib.b>lib.c',
      'lib.c>lib.d',
    ]);
    const row = (k: string) => a.merged.rows.find((r) => r.key === k);
    expect(row('lib.a')?.directness).toBe('Direct');
    expect(row('lib.c')?.directness).toBe('Transitive');
    expect(row('diamondapp')).toBeUndefined();
  });
});

describe('internal → public → internal collapse', () => {
  it('keeps an edge across a public chain and stops at the first internal node', () => {
    const a = analyzeFixtures('acme-web.assets.json');
    const { classification, buildOrders } = classifyAndOrder(a, { settings: offlineAcme, lookups: {}, metadata: {}, overrides: {} }, { includeProjects: true });
    expect(classification.byId['contoso.plugin']?.origin).toBe('Unclassified');
    const view = buildOrders[MERGED_SCOPE];
    expect(view?.graph.edges.map((e) => [e.from, e.to, e.via])).toEqual([
      ['acme.data', 'acme.core', []],
      ['acme.web', 'acme.core', ['contoso.plugin']],
      ['acme.web', 'acme.data', []],
      ['acme.web', 'acme.logging', []],
    ]);
    expect(view?.graph.edges[1]?.sources).toEqual([{ project: 'Acme.Web', fromVersion: '2.4.0' }]);
    expect(view?.order).toEqual({ ok: true, waves: [['acme.core', 'acme.logging'], ['acme.data'], ['acme.web']] });
  });

  it('can exclude type: project nodes, which then become pass-through', () => {
    const a = analyzeFixtures('acme-web.assets.json');
    const { buildOrders } = classifyAndOrder(a, { settings: offlineAcme, lookups: {}, metadata: {}, overrides: {} }, { includeProjects: false });
    expect(buildOrders[MERGED_SCOPE]?.graph.nodes).toEqual(['acme.core', 'acme.logging']);
    expect(buildOrders[MERGED_SCOPE]?.order).toEqual({ ok: true, waves: [['acme.core', 'acme.logging']] });
  });

  it('collapses through several public hops', () => {
    const graph = {
      nodes: Object.fromEntries(['a', 'p1', 'p2', 'b'].map((k) => [k, { key: k, spellings: [k], types: ['package' as const], versions: [], directIn: [], isRootProject: false }])),
      edges: [
        { from: 'a', to: 'p1', usages: [] },
        { from: 'p1', to: 'p2', usages: [] },
        { from: 'p2', to: 'b', usages: [] },
      ],
      projects: [],
    };
    expect(collapseToInternal(graph, (k) => k === 'a' || k === 'b').edges).toEqual([{ from: 'a', to: 'b', via: ['p1', 'p2'], sources: [] }]);
  });
});

describe('cycle detection', () => {
  it('reports a cross-file cycle instead of a build order', () => {
    const a = analyzeFixtures('cycle-alpha.assets.json', 'cycle-beta.assets.json');
    const { buildOrders } = classifyAndOrder(a, { settings: offlineAcme, lookups: {}, metadata: {}, overrides: {} }, { includeProjects: true });
    const order = buildOrders[MERGED_SCOPE]?.order;
    expect(order?.ok).toBe(false);
    if (order && !order.ok) {
      expect(order.cycles).toEqual([
        ['acme.alpha', 'acme.beta', 'acme.alpha'],
      ]);
      expect(order.partialWaves).toEqual([]);
      expect(order.blocked).toEqual(['acme.alpha', 'acme.beta', 'acme.shared']);
    }
  });

  it('marks a cycle inside one target in the tree', () => {
    const t = target('cycle-alpha.assets.json');
    const all = flatten(buildTree(t));
    const cycle = all.find((n) => n.kind === 'cycle');
    expect(cycle?.key).toBe('acme.beta');
    expect(cycle?.refUid).toBe(all.find((n) => n.key === 'acme.beta' && n.kind === 'expanded')?.uid);
    expect(targetCycles(t)).toEqual([['acme.beta', 'acme.shared', 'acme.beta']]);
  });

  it('returns one shortest cycle per component and flags self-loops', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'b', to: 'a' },
      { from: 'x', to: 'x' },
      { from: 'y', to: 'z' },
    ];
    expect(findCycles(['a', 'b', 'c', 'x', 'y', 'z'], edges)).toEqual([
      ['a', 'b', 'a'],
      ['x', 'x'],
    ]);
  });

  it('groups independent nodes into parallel waves', () => {
    const order = kahnWaves(['app', 'lib1', 'lib2', 'core'], [
      { from: 'app', to: 'lib1' },
      { from: 'app', to: 'lib2' },
      { from: 'lib1', to: 'core' },
      { from: 'lib2', to: 'core' },
    ]);
    expect(order).toEqual({ ok: true, waves: [['core'], ['lib1', 'lib2'], ['app']] });
  });

  it('keeps the waves computed before a cycle', () => {
    const order = kahnWaves(['base', 'x', 'y', 'top'], [
      { from: 'x', to: 'base' },
      { from: 'x', to: 'y' },
      { from: 'y', to: 'x' },
      { from: 'top', to: 'x' },
    ]);
    expect(order).toEqual({ ok: false, cycles: [['x', 'y', 'x']], partialWaves: [['base']], blocked: ['top', 'x', 'y'] });
  });
});
