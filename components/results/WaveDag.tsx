'use client';

import { useMemo, useState } from 'react';
import { ORIGIN_LABELS } from '@/lib/classify';
import type { BuildOrderView, ClassifyOutput, IdKey, MergedGraph } from '@/lib/types';

const NODE_W = 200;
const NODE_H = 28;
const GAP_X = 72;
const GAP_Y = 10;
const HEADER = 30;
const PAD = 12;
const BAR_W = 6;

interface Placed {
  key: IdKey;
  col: number;
  x: number;
  y: number;
}

/** Index into the 10-step wave ramp, spread across however many waves there are. */
export function waveColor(index: number, count: number): string {
  const step = count <= 1 ? 4 : Math.round((index * 9) / (count - 1));
  return `var(--wave-${step})`;
}

function layout(view: BuildOrderView) {
  const order = view.order;
  const waves = order.ok ? order.waves : order.partialWaves;
  const columns: IdKey[][] = waves.map((w) => [...w]);
  const blockedCol = !order.ok && order.blocked.length > 0 ? columns.push([...order.blocked]) - 1 : -1;

  const deps = new Map<IdKey, IdKey[]>();
  const dependents = new Map<IdKey, IdKey[]>();
  for (const e of view.graph.edges) {
    (deps.get(e.from) ?? deps.set(e.from, []).get(e.from))?.push(e.to);
    (dependents.get(e.to) ?? dependents.set(e.to, []).get(e.to))?.push(e.from);
  }
  const maxRows = Math.max(1, ...columns.map((c) => c.length));
  const y = new Map<IdKey, number>();
  const col = new Map<IdKey, number>();
  const place = () =>
    columns.forEach((c, ci) => {
      const offset = ((maxRows - c.length) * (NODE_H + GAP_Y)) / 2;
      c.forEach((k, ri) => {
        y.set(k, HEADER + PAD + offset + ri * (NODE_H + GAP_Y));
        col.set(k, ci);
      });
    });
  place();

  // Barycenter sweeps to reduce crossings: order each column by the mean height of its neighbors.
  const bary = (k: IdKey, neighbors: Map<IdKey, IdKey[]>, side: (c: number) => boolean) => {
    const ys = (neighbors.get(k) ?? []).filter((n) => side(col.get(n) ?? -1)).map((n) => y.get(n) ?? 0);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : (y.get(k) ?? 0);
  };
  for (let iter = 0; iter < 4; iter++) {
    for (let c = 1; c < columns.length; c++) {
      const column = columns[c] as IdKey[];
      const score = new Map(column.map((k) => [k, bary(k, deps, (n) => n < c)]));
      column.sort((a, b) => (score.get(a) as number) - (score.get(b) as number) || a.localeCompare(b));
      place();
    }
    for (let c = columns.length - 2; c >= 0; c--) {
      const column = columns[c] as IdKey[];
      const score = new Map(column.map((k) => [k, bary(k, dependents, (n) => n > c)]));
      column.sort((a, b) => (score.get(a) as number) - (score.get(b) as number) || a.localeCompare(b));
      place();
    }
  }

  const placed = new Map<IdKey, Placed>();
  columns.forEach((c, ci) => c.forEach((k) => placed.set(k, { key: k, col: ci, x: PAD + ci * (NODE_W + GAP_X), y: y.get(k) ?? 0 })));
  return {
    placed,
    columns,
    blockedCol,
    waveCount: waves.length,
    width: PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * GAP_X + (blockedCol >= 0 ? 48 : 0),
    height: HEADER + PAD * 2 + maxRows * (NODE_H + GAP_Y),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function WaveDag({ view, graph, classification }: { view: BuildOrderView; graph: MergedGraph; classification: ClassifyOutput | undefined }) {
  const L = useMemo(() => layout(view), [view]);
  const [hover, setHover] = useState<IdKey | null>(null);
  const cycleEdges = useMemo(() => {
    const s = new Set<string>();
    if (!view.order.ok) for (const c of view.order.cycles) for (let i = 0; i + 1 < c.length; i++) s.add(`${c[i]}>${c[i + 1]}`);
    return s;
  }, [view]);
  const name = (k: IdKey) => graph.nodes[k]?.spellings[0] ?? k;
  const connected = useMemo(() => {
    if (!hover) return null;
    const s = new Set<IdKey>([hover]);
    for (const e of view.graph.edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, view]);

  if (L.columns.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">Arrows point from a dependency to the node that needs it. Hover a node to trace its edges.</p>
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-line bg-surface">
        <svg width={L.width} height={L.height} role="img" aria-label={`Build order graph: ${L.waveCount} waves, ${L.placed.size} internal nodes. The wave list above has the same content as text.`} className="block">
          <defs>
            <marker id="dag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--line-strong)" />
            </marker>
            <marker id="dag-arrow-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--ink)" />
            </marker>
            <marker id="dag-arrow-cycle" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" />
            </marker>
          </defs>

          {L.columns.map((_, ci) => (
            <text key={ci} x={PAD + ci * (NODE_W + GAP_X)} y={PAD + 12} fontSize={12} fontWeight={600} fill={ci === L.blockedCol ? 'var(--danger)' : 'var(--ink-2)'}>
              {ci === L.blockedCol ? '↻ Cycle / blocked' : `Wave ${ci + 1}`}
            </text>
          ))}

          {view.graph.edges.map((e) => {
            const a = L.placed.get(e.to); // dependency
            const b = L.placed.get(e.from); // dependent
            if (!a || !b) return null;
            const isCycle = cycleEdges.has(`${e.from}>${e.to}`);
            const hot = hover !== null && (e.from === hover || e.to === hover);
            let d: string;
            if (a.col === b.col) {
              const x = a.x + NODE_W;
              d = `M${x},${a.y + NODE_H / 2} C${x + 40},${a.y + NODE_H / 2} ${x + 40},${b.y + NODE_H / 2} ${x},${b.y + NODE_H / 2}`;
            } else {
              const x1 = a.x + NODE_W;
              const x2 = b.x;
              const dx = (x2 - x1) / 2;
              d = `M${x1},${a.y + NODE_H / 2} C${x1 + dx},${a.y + NODE_H / 2} ${x2 - dx},${b.y + NODE_H / 2} ${x2 - 1},${b.y + NODE_H / 2}`;
            }
            return (
              <path
                key={`${e.from}>${e.to}`}
                d={d}
                fill="none"
                stroke={isCycle ? 'var(--danger)' : hot ? 'var(--ink)' : 'var(--line-strong)'}
                strokeWidth={hot || isCycle ? 2 : 1.25}
                opacity={hover !== null && !hot ? 0.2 : 1}
                markerEnd={`url(#${isCycle ? 'dag-arrow-cycle' : hot ? 'dag-arrow-hot' : 'dag-arrow'})`}
              />
            );
          })}

          {[...L.placed.values()].map((p) => {
            const blocked = p.col === L.blockedCol;
            const c = classification?.byId[p.key];
            const depsOf = view.graph.edges.filter((e) => e.from === p.key).map((e) => name(e.to));
            const neededBy = view.graph.edges.filter((e) => e.to === p.key).map((e) => name(e.from));
            const title = [
              name(p.key),
              blocked ? 'On or behind a cycle' : `Wave ${p.col + 1}`,
              c ? `Origin: ${ORIGIN_LABELS[c.origin]}` : '',
              `Depends on: ${depsOf.join(', ') || 'nothing internal'}`,
              `Needed by: ${neededBy.join(', ') || 'nothing internal'}`,
            ]
              .filter(Boolean)
              .join('\n');
            return (
              <g
                key={p.key}
                transform={`translate(${p.x},${p.y})`}
                opacity={connected && !connected.has(p.key) ? 0.35 : 1}
                onMouseEnter={() => setHover(p.key)}
                onMouseLeave={() => setHover(null)}
                className="cursor-default"
              >
                <title>{title}</title>
                <rect width={NODE_W} height={NODE_H} rx={4} fill="var(--surface)" stroke={hover === p.key ? 'var(--ink)' : 'var(--line-strong)'} strokeWidth={hover === p.key ? 1.5 : 1} />
                <rect width={BAR_W} height={NODE_H} rx={2} fill={blocked ? 'var(--danger)' : waveColor(p.col, L.waveCount)} />
                <text x={BAR_W + 8} y={NODE_H / 2 + 4} fontSize={12} fill="var(--ink)" fontFamily="var(--font-mono)">
                  {blocked ? '↻ ' : ''}
                  {truncate(name(p.key), blocked ? 22 : 24)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
