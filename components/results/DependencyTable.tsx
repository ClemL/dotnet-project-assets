'use client';

import { useMemo, useState } from 'react';
import { ORIGIN_LABELS } from '@/lib/classify';
import { ORIGINS, type ClassifyOutput, type DependencyRow, type IdKey, type Origin } from '@/lib/types';
import { compareVersionStrings } from '@/lib/versions';
import { OriginBadge } from '../ui/OriginBadge';
import { btnSmall, cx, field, td, th } from '../ui/styles';

type SortKey = 'id' | 'versions' | 'type' | 'directness' | 'origin' | 'reason' | 'projects';
const PAGE = 100;

export function DependencyTable({
  rows,
  classification,
  overrides,
  onOverride,
}: {
  rows: DependencyRow[];
  classification: ClassifyOutput | undefined;
  overrides: Record<IdKey, Origin>;
  onOverride: (key: IdKey, origin: Origin | undefined) => void;
}) {
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<Origin | ''>('');
  const [directness, setDirectness] = useState('');
  const [type, setType] = useState('');
  const [multiVersion, setMultiVersion] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'id', dir: 1 });
  const [page, setPage] = useState(0);

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      const c = classification?.byId[r.key];
      if (origin && c?.origin !== origin) return false;
      if (directness && r.directness !== directness) return false;
      if (type && !r.types.includes(type as DependencyRow['types'][number])) return false;
      if (multiVersion && r.versions.length < 2) return false;
      if (!q) return true;
      return r.key.includes(q) || r.projects.some((p) => p.toLowerCase().includes(q)) || (c?.reasons.some((x) => x.toLowerCase().includes(q)) ?? false);
    });
    const value = (r: DependencyRow): string | number => {
      const c = classification?.byId[r.key];
      switch (sort.key) {
        case 'id':
          return r.key;
        case 'versions':
          return r.versions[r.versions.length - 1] ?? '';
        case 'type':
          return r.types.join(',');
        case 'directness':
          return r.directness;
        case 'origin':
          return c ? ORIGIN_LABELS[c.origin] : '';
        case 'reason':
          return c?.reasons.join(' ') ?? '';
        case 'projects':
          return r.projects.length;
      }
    };
    return [...filtered].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const c = sort.key === 'versions' ? compareVersionStrings(String(x), String(y)) : typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return c * sort.dir || a.key.localeCompare(b.key);
    });
  }, [rows, classification, query, origin, directness, type, multiVersion, sort]);

  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = view.slice(current * PAGE, current * PAGE + PAGE);

  const header = (key: SortKey, label: string) => (
    <th className={th} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-ink" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
        {label}
        <span aria-hidden="true" className="text-muted">
          {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          className={`${field} w-64 max-w-full`}
          placeholder="Filter by Id, project, or reason…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          aria-label="Filter dependencies"
        />
        <select className={field} value={origin} onChange={(e) => (setOrigin(e.target.value as Origin | ''), setPage(0))} aria-label="Filter by origin">
          <option value="">All origins</option>
          {ORIGINS.map((o) => (
            <option key={o} value={o}>
              {ORIGIN_LABELS[o]}
            </option>
          ))}
        </select>
        <select className={field} value={directness} onChange={(e) => (setDirectness(e.target.value), setPage(0))} aria-label="Filter by direct or transitive">
          <option value="">Direct + transitive</option>
          <option value="Direct">Direct</option>
          <option value="Transitive">Transitive</option>
          <option value="Mixed">Mixed</option>
        </select>
        <select className={field} value={type} onChange={(e) => (setType(e.target.value), setPage(0))} aria-label="Filter by type">
          <option value="">All types</option>
          <option value="package">package</option>
          <option value="project">project</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={multiVersion} onChange={(e) => (setMultiVersion(e.target.checked), setPage(0))} />
          Multiple versions only
        </label>
        <span className="tabular ml-auto text-sm text-muted">
          {view.length} of {rows.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {header('id', 'Id')}
              {header('versions', 'Resolved')}
              {header('type', 'Type')}
              {header('directness', 'Direct / transitive')}
              {header('origin', 'Origin')}
              {header('reason', 'Reason')}
              {header('projects', 'Projects')}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const c = classification?.byId[r.key];
              const overridden = overrides[r.key] !== undefined;
              return (
                <tr key={r.key} className="hover:bg-surface-2">
                  <td className={cx(td, 'font-mono text-xs')}>{r.id}</td>
                  <td className={cx(td, 'tabular whitespace-nowrap font-mono text-xs')}>
                    {r.versions.map((v) => (
                      <div key={v}>{v}</div>
                    ))}
                  </td>
                  <td className={cx(td, 'text-xs')}>{r.types.join(', ')}</td>
                  <td className={cx(td, 'text-xs')}>
                    {r.directness}
                    {r.directness === 'Mixed' ? <div className="text-muted">direct in {r.directIn.length}</div> : null}
                  </td>
                  <td className={td}>
                    {c ? <OriginBadge origin={c.origin} mixed={c.mixed} overridden={overridden} /> : <span className="text-xs text-muted">…</span>}
                    <select
                      className="mt-1 block rounded border border-line bg-surface px-1 py-0.5 text-xs text-ink-2"
                      value={overrides[r.key] ?? ''}
                      onChange={(e) => onOverride(r.key, (e.target.value || undefined) as Origin | undefined)}
                      aria-label={`Override origin of ${r.id}`}
                    >
                      <option value="">Auto</option>
                      {ORIGINS.map((o) => (
                        <option key={o} value={o}>
                          {ORIGIN_LABELS[o]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={cx(td, 'max-w-sm break-words text-xs text-ink-2')}>
                    {c?.reasons.map((x, i) => (
                      <div key={i}>{x}</div>
                    ))}
                  </td>
                  <td className={cx(td, 'text-xs')}>
                    {r.projects.length <= 3 ? (
                      r.projects.join(', ')
                    ) : (
                      <details>
                        <summary className="cursor-pointer">{r.projects.length} projects</summary>
                        {r.projects.join(', ')}
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 ? (
              <tr>
                <td className={cx(td, 'text-center text-muted')} colSpan={7}>
                  No dependencies match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button type="button" className={btnSmall} disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          <span className="tabular text-muted">
            Page {current + 1} of {pages}
          </span>
          <button type="button" className={btnSmall} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
