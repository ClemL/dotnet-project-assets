'use client';

import { useMemo } from 'react';
import { ORIGIN_LABELS } from '@/lib/classify';
import type { BuildOrderView, ClassifyOutput, CollapsedEdge, IdKey, MergedGraph } from '@/lib/types';
import { Banner } from '../ui/Banner';
import { OriginDot } from '../ui/OriginBadge';
import { card, cx, hint, td, th } from '../ui/styles';
import { waveColor, WaveDag } from './WaveDag';

const DAG_NODE_LIMIT = 400;

export function BuildOrder({
  view,
  graph,
  classification,
  includeProjects,
  onIncludeProjects,
  showDag,
  onShowDag,
}: {
  view: BuildOrderView | undefined;
  graph: MergedGraph;
  classification: ClassifyOutput | undefined;
  includeProjects: boolean;
  onIncludeProjects: (v: boolean) => void;
  showDag: boolean;
  onShowDag: (v: boolean) => void;
}) {
  const edgeMap = useMemo(() => new Map((view?.graph.edges ?? []).map((e) => [`${e.from}>${e.to}`, e])), [view]);
  const name = (k: IdKey) => graph.nodes[k]?.spellings[0] ?? k;
  const chip = (k: IdKey, color?: string) => {
    const c = classification?.byId[k];
    const deps = view?.graph.edges.filter((e) => e.from === k).map((e) => name(e.to)) ?? [];
    return (
      <li key={k} className="inline-flex items-center gap-1.5 rounded border border-line bg-surface py-0.5 pl-0 pr-2 font-mono text-xs" title={`Depends on: ${deps.join(', ') || 'nothing internal'}`}>
        <span aria-hidden="true" className="h-5 w-1.5 rounded-l" style={{ background: color ?? 'var(--line-strong)' }} />
        {c ? <OriginDot origin={c.origin} /> : null}
        {name(k)}
        {c ? <span className="sr-only">({ORIGIN_LABELS[c.origin]})</span> : null}
      </li>
    );
  };
  const edgeDetail = (e: CollapsedEdge | undefined) => {
    if (!e) return null;
    const via = e.via.length ? ` via ${e.via.map(name).join(' → ')}` : '';
    const src = e.sources
      .slice(0, 3)
      .map((s) => `${s.project} @ ${s.fromVersion}`)
      .join('; ');
    return (
      <>
        {via}
        {src ? <span className="text-muted"> (from {src})</span> : null}
      </>
    );
  };

  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center gap-x-6 gap-y-2`}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeProjects} onChange={(e) => onIncludeProjects(e.target.checked)} />
          Include <code className="font-mono">type: project</code> nodes
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showDag} onChange={(e) => onShowDag(e.target.checked)} />
          Show graph
        </label>
        <p className={hint}>
          Internal nodes only (Project, Private, Private (inferred)). Public chains between internal nodes are collapsed into direct edges. Each wave can build in parallel once earlier waves are done.
        </p>
      </div>

      {!view ? (
        <p className="text-sm text-muted">Computing…</p>
      ) : view.graph.nodes.length === 0 ? (
        <Banner tone="info" title="No internal nodes in this scope">
          <p>Add internal prefixes or feeds, or run the nuget.org lookups, so private packages are recognized. Unclassified packages are treated as external.</p>
        </Banner>
      ) : (
        <>
          <p className="text-sm text-ink-2">
            <span className="tabular">{view.graph.nodes.length}</span> internal nodes, <span className="tabular">{view.graph.edges.length}</span> internal edges
            {view.order.ok ? (
              <>
                , <span className="tabular">{view.order.waves.length}</span> waves.
              </>
            ) : (
              '.'
            )}
          </p>

          {!view.order.ok ? (
            <Banner tone="danger" title="Cycle detected: no complete build order exists">
              {view.order.cycles.map((c) => (
                <div key={c.join('>')} className="space-y-0.5">
                  <p className="font-mono text-xs font-semibold">{c.map(name).join(' → ')}</p>
                  <ul className="list-disc pl-5 text-xs">
                    {c.slice(0, -1).map((from, i) => {
                      const to = c[i + 1] as IdKey;
                      return (
                        <li key={`${from}>${to}`}>
                          <span className="font-mono">{name(from)}</span> depends on <span className="font-mono">{name(to)}</span>
                          {edgeDetail(edgeMap.get(`${from}>${to}`))}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              <p className="text-xs">Merging by Id can create cycles that exist only across different versions; check the contributing projects and versions above.</p>
            </Banner>
          ) : null}

          <ol className="space-y-3">
            {(view.order.ok ? view.order.waves : view.order.partialWaves).map((wave, i, all) => (
              <li key={i} className="space-y-1">
                <h3 className="text-sm font-semibold">
                  Wave {i + 1} <span className="tabular font-normal text-muted">({wave.length})</span>
                </h3>
                <ul className="flex flex-wrap gap-1.5">{wave.map((k) => chip(k, waveColor(i, all.length)))}</ul>
              </li>
            ))}
            {!view.order.ok ? (
              <li className="space-y-1">
                <h3 className="text-sm font-semibold text-danger-ink">
                  On or behind a cycle <span className="tabular font-normal">({view.order.blocked.length})</span>
                </h3>
                <ul className="flex flex-wrap gap-1.5">{view.order.blocked.map((k) => chip(k, 'var(--danger)'))}</ul>
              </li>
            ) : null}
          </ol>

          {showDag ? (
            view.graph.nodes.length > DAG_NODE_LIMIT ? (
              <p className={hint}>The graph view is limited to {DAG_NODE_LIMIT} nodes; this scope has {view.graph.nodes.length}. Use the wave list or the CSV export.</p>
            ) : (
              <WaveDag view={view} graph={graph} classification={classification} />
            )
          ) : null}

          <details className="text-sm">
            <summary className="cursor-pointer text-ink-2">Internal edges ({view.graph.edges.length})</summary>
            <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={th}>Node</th>
                    <th className={th}>Depends on</th>
                    <th className={th}>Through (collapsed)</th>
                    <th className={th}>Contributed by</th>
                  </tr>
                </thead>
                <tbody>
                  {view.graph.edges.map((e) => (
                    <tr key={`${e.from}>${e.to}`}>
                      <td className={cx(td, 'font-mono text-xs')}>{name(e.from)}</td>
                      <td className={cx(td, 'font-mono text-xs')}>{name(e.to)}</td>
                      <td className={cx(td, 'font-mono text-xs')}>{e.via.map(name).join(' → ') || 'direct'}</td>
                      <td className={cx(td, 'text-xs')}>{e.sources.map((s) => `${s.project} @ ${s.fromVersion}`).join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
