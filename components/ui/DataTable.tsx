'use client';

import { Fragment, useMemo, useState } from 'react';
import { btnSmall, cx, td, th } from './styles';

export interface Column<T> {
  id: string;
  header: string;
  render: (row: T) => React.ReactNode;
  /** Sort key; omit both this and `compare` to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  /** Custom comparator (versions, severities). Takes precedence over sortValue. */
  compare?: (a: T, b: T) => number;
  className?: string;
}

export type SortState = { id: string; dir: 1 | -1 };

/**
 * Sortable, paginated table with optional expandable rows. Filtering stays with the caller, which
 * passes the rows to show.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  initialSort,
  expand,
  rowClassName,
  empty = 'No rows match.',
  pageSize = 100,
  label,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  initialSort?: SortState;
  /** Content shown under a row when it is expanded; rows are not expandable without it. */
  expand?: (row: T) => React.ReactNode;
  rowClassName?: (row: T) => string | undefined;
  empty?: string;
  pageSize?: number;
  label: string;
}) {
  const [sort, setSort] = useState<SortState | undefined>(initialSort);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sort?.id);
    if (!sort || !col || (!col.compare && !col.sortValue)) return rows;
    const cmp =
      col.compare ??
      ((a: T, b: T) => {
        const x = (col.sortValue as (r: T) => string | number)(a);
        const y = (col.sortValue as (r: T) => string | number)(b);
        return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      });
    return [...rows].sort((a, b) => cmp(a, b) * sort.dir);
  }, [rows, columns, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages - 1);
  const shown = sorted.slice(current * pageSize, current * pageSize + pageSize);
  const colSpan = columns.length + (expand ? 1 : 0);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full border-collapse" aria-label={label}>
          <thead>
            <tr>
              {expand ? <th className={th} aria-label="Expand" /> : null}
              {columns.map((c) => {
                const sortable = Boolean(c.compare || c.sortValue);
                const active = sort?.id === c.id;
                return (
                  <th key={c.id} className={th} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : sortable ? 'none' : undefined}>
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 uppercase hover:text-ink"
                        onClick={() => setSort((s) => ({ id: c.id, dir: s?.id === c.id ? (s.dir === 1 ? -1 : 1) : 1 }))}
                      >
                        {c.header}
                        <span aria-hidden="true" className="text-muted">
                          {active ? (sort.dir === 1 ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const key = rowKey(row);
              const isOpen = open.has(key);
              return (
                <Fragment key={key}>
                  <tr className={cx('hover:bg-surface-2', rowClassName?.(row))}>
                    {expand ? (
                      <td className={cx(td, 'w-6')}>
                        <button type="button" className="text-ink-2 hover:text-ink" aria-expanded={isOpen} aria-label={isOpen ? 'Collapse row' : 'Expand row'} onClick={() => toggle(key)}>
                          {isOpen ? '▾' : '▸'}
                        </button>
                      </td>
                    ) : null}
                    {columns.map((c) => (
                      <td key={c.id} className={cx(td, c.className)}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                  {expand && isOpen ? (
                    <tr className="bg-surface-2">
                      <td className={td} />
                      <td className={cx(td, 'text-xs')} colSpan={colSpan - 1}>
                        {expand(row)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {shown.length === 0 ? (
              <tr>
                <td className={cx(td, 'text-center text-muted')} colSpan={colSpan}>
                  {empty}
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
