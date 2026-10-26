'use client';

import { useEffect, useMemo, useState } from 'react';
import { buildTree, pathNodesTo, selectTargets, targetCycles, treeParents, whyPaths } from '@/lib/graph';
import { metadataKey } from '@/lib/metadata';
import type { ClassifyOutput, DepTreeNode, IdKey, Origin, ProjectModel, TargetGraph } from '@/lib/types';
import { describeRange } from '@/lib/version';
import { Banner } from '../ui/Banner';
import { OriginDot } from '../ui/OriginBadge';
import { btnSmall, cx, field, hint } from '../ui/styles';

interface Ctx {
  expanded: Set<string>;
  toggle: (uid: string) => void;
  jump: (uid: string) => void;
  highlight: Set<IdKey> | null;
  targetKey: IdKey | null;
  originOf: (node: DepTreeNode) => Origin | undefined;
  cycleKeys: Set<IdKey>;
}

function rangeText(node: DepTreeNode): string {
  if (node.range === '') return node.type === 'project' ? 'project' : 'any';
  return describeRange(node.range);
}

function TreeRow({ node, ctx }: { node: DepTreeNode; ctx: Ctx }) {
  const open = ctx.expanded.has(node.uid);
  const hasChildren = node.children.length > 0;
  const origin = ctx.originOf(node);
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={false}>
      <div
        id={`tree-${node.uid}`}
        tabIndex={-1}
        className={cx(
          'flex flex-wrap items-center gap-x-1.5 rounded px-1 py-0.5 font-mono text-xs outline-none focus:ring-2 focus:ring-accent',
          ctx.highlight?.has(node.key) && 'bg-mark',
          ctx.targetKey === node.key && 'font-bold',
          ctx.cycleKeys.has(node.key) && 'text-danger-ink',
        )}
      >
        {hasChildren ? (
          <button type="button" className="w-4 text-ink-2 hover:text-ink" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.id}`} onClick={() => ctx.toggle(node.uid)}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="inline-block w-4" aria-hidden="true" />
        )}
        {origin ? <OriginDot origin={origin} /> : null}
        <span>{node.id}</span>
        <span className="text-ink-2">
          ({rangeText(node)} → {node.kind === 'missing' ? 'not resolved' : node.resolved})
        </span>
        {node.type === 'project' ? <span className="rounded bg-surface-2 px-1 font-sans text-[10px] text-ink-2">project</span> : null}
        {node.kind === 'repeat' && node.refUid ? (
          <button type="button" className="text-accent hover:underline" title="Already expanded earlier in the tree. Jump to it." onClick={() => ctx.jump(node.refUid as string)}>
            (*)
          </button>
        ) : null}
        {node.kind === 'cycle' && node.refUid ? (
          <button type="button" className="font-sans font-semibold text-danger-ink hover:underline" title="This Id is already on the current path. Jump to the ancestor." onClick={() => ctx.jump(node.refUid as string)}>
            ↻ cycle
          </button>
        ) : null}
      </div>
      {hasChildren && open ? (
        <ul role="group" className="ml-2.5 border-l border-line pl-2.5">
          {node.children.map((c) => (
            <TreeRow key={c.uid} node={c} ctx={ctx} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function flatten(nodes: DepTreeNode[], out: DepTreeNode[] = []): DepTreeNode[] {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

export interface TreeFocus {
  key: IdKey;
  /** Changes on every request so jumping to the same Id twice still runs. */
  nonce: number;
}

export function DependencyTree({
  models,
  classification,
  includeRid,
  focus,
}: {
  models: ProjectModel[];
  classification: ClassifyOutput | undefined;
  includeRid: boolean;
  /** Jump request from another tab: select a project and target containing the Id, then find its paths. */
  focus?: TreeFocus;
}) {
  const [modelId, setModelId] = useState<string | undefined>(models[0]?.inputId);
  const model = models.find((m) => m.inputId === modelId) ?? models[0];
  const targets = useMemo(() => (model ? selectTargets(model, { includeRidTargets: includeRid }) : []), [model, includeRid]);
  const [targetKey, setTargetKey] = useState<string | undefined>();
  const target: TargetGraph | undefined = targets.find((t) => t.key === targetKey) ?? targets[0];

  const tree = useMemo(() => (target ? buildTree(target) : []), [target]);
  const all = useMemo(() => flatten(tree), [tree]);
  const parents = useMemo(() => treeParents(tree), [tree]);
  const cycles = useMemo(() => (target ? targetCycles(target) : []), [target]);
  const cycleKeys = useMemo(() => new Set(cycles.flat()), [cycles]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [whyKey, setWhyKey] = useState<IdKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [focusUid, setFocusUid] = useState<string | null>(null);
  const [showAllPaths, setShowAllPaths] = useState(false);

  useEffect(() => {
    setExpanded(new Set());
    setWhyKey(null);
    setMessage(null);
  }, [target]);

  const [pendingSearch, setPendingSearch] = useState<IdKey | null>(null);
  useEffect(() => {
    if (!focus) return;
    for (const m of models) {
      const t = selectTargets(m, { includeRidTargets: includeRid }).find((x) => x.nodes[focus.key]);
      if (t) {
        setModelId(m.inputId);
        setTargetKey(t.key);
        setPendingSearch(focus.key);
        return;
      }
    }
    setMessage(`"${focus.key}" is not in any loaded project.assets.json.`);
    // Runs once per jump request; models and includeRid are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const why = useMemo(() => {
    if (!target || !whyKey) return null;
    return { nodes: pathNodesTo(target, whyKey), ...whyPaths(target, whyKey) };
  }, [target, whyKey]);

  // Runs after the render that expanded the jump target's ancestors, so the element exists.
  useEffect(() => {
    if (!focusUid) return;
    const el = document.getElementById(`tree-${focusUid}`);
    setFocusUid(null);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }, [focusUid]);

  const ctx: Ctx = {
    expanded,
    toggle: (uid) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
        return next;
      }),
    jump: (uid) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (let p = parents.get(uid); p !== undefined; p = parents.get(p)) next.add(p);
        return next;
      });
      setFocusUid(uid);
    },
    highlight: why?.nodes ?? null,
    targetKey: whyKey,
    originOf: (node) => {
      if (!classification) return undefined;
      return (node.resolved ? classification.byPackage[metadataKey(node.id, node.resolved)]?.origin : undefined) ?? classification.byId[node.key]?.origin;
    },
    cycleKeys,
  };

  const runSearch = (text: string) => {
    const key = text.trim().toLowerCase();
    if (!key) {
      setWhyKey(null);
      setMessage(null);
      return;
    }
    if (!target?.nodes[key]) {
      setWhyKey(null);
      setMessage(`"${text.trim()}" is not in ${target?.key ?? 'this target'}.`);
      return;
    }
    setMessage(null);
    setWhyKey(key);
    setShowAllPaths(false);
    const onPath = pathNodesTo(target, key);
    setExpanded(new Set(all.filter((n) => n.kind === 'expanded' && n.key !== key && onPath.has(n.key)).map((n) => n.uid)));
  };

  // Declared after runSearch so the jump search uses the tree of the newly selected target.
  useEffect(() => {
    if (!pendingSearch || !target?.nodes[pendingSearch]) return;
    const id = target.nodes[pendingSearch].id;
    setPendingSearch(null);
    setQuery(id);
    runSearch(id);
    // runSearch is recreated every render; the jump only depends on the pending Id and the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSearch, target]);

  if (!model || !target) return <p className="text-sm text-muted">No targets to show.</p>;
  const nodeCount = Object.keys(target.nodes).length;
  const display = (k: IdKey) => {
    const n = target.nodes[k];
    return n ? `${n.id} ${n.version}` : k;
  };
  const paths = why ? (showAllPaths ? why.paths : why.paths.slice(0, 25)) : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        {models.length > 1 ? (
          <label className="flex flex-col gap-0.5 text-xs text-ink-2">
            Project
            <select className={field} value={model.inputId} onChange={(e) => (setModelId(e.target.value), setTargetKey(undefined))}>
              {models.map((m) => (
                <option key={m.inputId} value={m.inputId}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-0.5 text-xs text-ink-2">
          Target
          <select className={field} value={target.key} onChange={(e) => setTargetKey(e.target.value)}>
            {targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.key}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex flex-col gap-0.5 text-xs text-ink-2"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(query);
          }}
        >
          <label htmlFor="why-search">Why is this package here?</label>
          <div className="flex gap-1">
            <input id="why-search" className={`${field} w-64 max-w-full`} list="tree-ids" placeholder="Package Id…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" className={btnSmall}>
              Find paths
            </button>
            {whyKey ? (
              <button type="button" className={btnSmall} onClick={() => (setQuery(''), runSearch(''))}>
                Clear
              </button>
            ) : null}
          </div>
          <datalist id="tree-ids">
            {Object.values(target.nodes).map((n) => (
              <option key={n.id} value={n.id} />
            ))}
          </datalist>
        </form>
        <div className="ml-auto flex gap-1">
          <button type="button" className={btnSmall} onClick={() => setExpanded(new Set(all.filter((n) => n.children.length > 0).map((n) => n.uid)))}>
            Expand all
          </button>
          <button type="button" className={btnSmall} onClick={() => setExpanded(new Set())}>
            Collapse all
          </button>
        </div>
      </div>

      <p className={hint}>
        {model.label} · {target.key}: {target.roots.length} direct, {nodeCount} resolved. Nodes read <code className="font-mono">Id (requested range → resolved)</code>; <span className="font-mono">(*)</span> marks a subtree already
        expanded above (click to jump).
      </p>
      {message ? <p className="text-sm text-warn-ink">{message}</p> : null}

      {cycles.length > 0 ? (
        <Banner tone="danger" title={`${cycles.length} cycle${cycles.length === 1 ? '' : 's'} in ${target.key}`}>
          {cycles.map((c) => (
            <p key={c.join('>')} className="font-mono text-xs">
              {c.map(display).join(' → ')}
            </p>
          ))}
        </Banner>
      ) : null}

      {why ? (
        <div className="space-y-1 rounded-lg border border-line bg-surface p-3">
          <p className="text-sm">
            <strong className="tabular">{why.truncated ? `${why.paths.length}+` : why.paths.length}</strong> path{why.paths.length === 1 ? '' : 's'} to <span className="font-mono">{display(whyKey as IdKey)}</span>. Highlighted below.
          </p>
          <ol className="max-h-64 list-decimal space-y-0.5 overflow-auto pl-6 font-mono text-xs">
            {paths.map((p, i) => (
              <li key={i}>
                <span className="text-ink-2">{model.projectName} → </span>
                {p.map(display).join(' → ')}
              </li>
            ))}
          </ol>
          {why.paths.length > paths.length ? (
            <button type="button" className={btnSmall} onClick={() => setShowAllPaths(true)}>
              Show all {why.paths.length}
            </button>
          ) : null}
          {why.truncated ? <p className={hint}>Stopped after {why.paths.length} paths.</p> : null}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface p-2">
        <p className="px-1 pb-1 text-sm font-semibold">{model.projectName}</p>
        <ul role="tree" aria-label={`Dependency tree of ${model.label} for ${target.key}`}>
          {tree.map((n) => (
            <TreeRow key={n.uid} node={n} ctx={ctx} />
          ))}
        </ul>
        {tree.length === 0 ? <p className="px-1 text-sm text-muted">No direct dependencies.</p> : null}
      </div>
    </div>
  );
}
