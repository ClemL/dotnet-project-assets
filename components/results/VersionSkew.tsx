'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatRequestedGroup, formatSpread } from '@/lib/export';
import { isFloatingKind, RANGE_KIND_LABEL } from '@/lib/floating';
import { severityRank } from '@/lib/skew';
import type { ConsumerRow, FloatingRef, FloatingReport, IdKey, RangeKind, RebuildSeverity, RebuildStep, Severity, SkewEdge, SkewReport, SkewRow, SkewSettings, TriState } from '@/lib/types';
import { compareVersionStrings } from '@/lib/versions';
import { Banner } from '../ui/Banner';
import { DataTable, type Column } from '../ui/DataTable';
import { OriginDot } from '../ui/OriginBadge';
import { btn, btnSmall, card, cx, field, h2, hint, linkBtn, td, th } from '../ui/styles';
import { Tabs } from '../ui/Tabs';
import { SkewSettingsDrawer } from './SkewSettingsDrawer';

type Sub = 'skew' | 'consumers' | 'rebuild' | 'floating';
type OriginFilter = 'internal' | 'public' | 'all';
type SeverityFilter = 'any' | 'high' | 'medium' | 'low';

const SEVERITY_STYLE: Record<Severity, string> = {
  high: 'bg-danger-bg text-danger-ink',
  medium: 'bg-warn-bg text-warn-ink',
  low: 'bg-info-bg text-info-ink',
  info: 'bg-surface-2 text-ink-2',
  none: 'bg-surface-2 text-muted',
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cx('inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase', SEVERITY_STYLE[severity])}>{severity}</span>;
}

function TriBadge({ value }: { value: TriState }) {
  const style = value === 'enabled' ? 'text-ok' : value === 'disabled' ? 'text-danger-ink' : 'text-muted';
  return <span className={cx('text-xs font-medium', style)}>{value}</span>;
}

const passesSeverity = (s: Severity, f: SeverityFilter) => f === 'any' || severityRank(s) >= severityRank(f);

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <button
          type="button"
          className={btnSmall}
          onClick={() => {
            navigator.clipboard
              ?.writeText(text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-surface-2 p-2 font-mono text-xs">{text}</pre>
    </div>
  );
}

function EdgeDetail({ row }: { row: SkewRow }) {
  return (
    <table className="w-full border-collapse" aria-label={`Edges into ${row.child}`}>
      <thead>
        <tr>
          {['Requester', 'Requester version', 'Requested range (as written)', 'Requested version', 'Lag', 'Severity', 'Projects'].map((h) => (
            <th key={h} className={th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {row.edges.map((e: SkewEdge) => (
          <tr key={`${e.parentKey}|${e.parentVersion}|${e.requestedRange}|${e.isDirect}`} className={e.stale ? undefined : 'text-muted'}>
            <td className={cx(td, 'font-mono text-xs')}>
              {e.parent}
              {e.isDirect ? <span className="ml-1 rounded bg-surface-2 px-1 font-sans text-[10px]">direct ref</span> : null}
            </td>
            <td className={cx(td, 'font-mono text-xs')}>{e.parentVersion}</td>
            <td className={cx(td, 'font-mono text-xs')}>{e.requestedRange}</td>
            <td className={cx(td, 'font-mono text-xs')}>{e.requestedVersion ?? '—'}</td>
            <td className={cx(td, 'tabular text-xs')}>{e.stale ? (e.lag !== null ? e.lag : `n/a (semver, ${e.diff})`) : e.isFloating ? 'floated to resolved' : 'not stale'}</td>
            <td className={td}>{e.stale ? <SeverityBadge severity={e.severity} /> : null}</td>
            <td className={cx(td, 'text-xs')}>{e.projects.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface SkewFocus {
  key: IdKey;
  nonce: number;
}

export function VersionSkew({
  skew,
  floating,
  settings,
  onSettings,
  isMerged,
  fileCount,
  onOpenDrift,
  canJump,
  onJumpTree,
  focus,
}: {
  skew: SkewReport | undefined;
  floating: FloatingReport | undefined;
  settings: SkewSettings;
  onSettings: (s: SkewSettings) => void;
  isMerged: boolean;
  fileCount: number;
  onOpenDrift: () => void;
  canJump: boolean;
  onJumpTree: (id: string) => void;
  focus?: SkewFocus;
}) {
  const [sub, setSub] = useState<Sub>('skew');
  const [drawer, setDrawer] = useState(false);
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<OriginFilter>('internal');
  const [severity, setSeverity] = useState<SeverityFilter>('any');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<'floating' | RangeKind | 'all'>('floating');

  // Jump request from another tab: filter to the Id and open the sub-section that contains it.
  useEffect(() => {
    if (!focus || !skew) return;
    setQuery(focus.key);
    setSeverity('any');
    setTarget('');
    if (skew.internal.some((r) => r.childKey === focus.key)) {
      setSub('skew');
      setOrigin('internal');
    } else if (skew.public.some((r) => r.childKey === focus.key)) {
      setSub('skew');
      setOrigin('public');
    } else if (skew.consumers.some((c) => c.parentKey === focus.key)) setSub('consumers');
    else if (floating?.refs.some((r) => r.key === focus.key)) {
      setSub('floating');
      setKind('all');
    } else setSub('skew');
    // Only a new jump request (or the first result after one) should reset the filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, skew !== undefined]);

  const q = query.trim().toLowerCase();
  const targets = useMemo(() => [...new Set([...(skew?.internal ?? []), ...(skew?.public ?? [])].map((r) => r.target))].sort(), [skew]);
  const [internalRows, publicRows] = useMemo(() => {
    const keep = (r: SkewRow) => (!target || r.target === target) && passesSeverity(r.severity, severity) && (!q || r.childKey.includes(q) || r.edges.some((e) => e.parentKey.includes(q)));
    return [(skew?.internal ?? []).filter(keep), (skew?.public ?? []).filter(keep)];
  }, [skew, target, severity, q]);

  if (!skew || !floating) return <p className="text-sm text-muted">Computing…</p>;

  const merged = isMerged && fileCount > 1;
  const floatingRefs = floating.refs.filter((r) => isFloatingKind(r.kind));
  const lockKnown = floating.restore.filter((r) => r.flags.lockFile === 'enabled').length;

  /** Cross-link from a floating reference to its skew row. */
  const showSkewRow = (child: string, isPublic: boolean) => {
    setSub('skew');
    setOrigin(isPublic ? 'public' : 'internal');
    setSeverity('any');
    setTarget('');
    setQuery(child.toLowerCase());
  };

  const skewColumns = (isPublic: boolean): Column<SkewRow>[] => {
    const columns: Column<SkewRow>[] = [
      {
        id: 'package',
        header: 'Package (resolved version)',
        render: (r) => (
          <span className="font-mono text-xs">
            <span className="inline-flex items-center gap-1.5">
              {r.origin ? <OriginDot origin={r.origin} /> : null}
              {canJump ? (
                <button type="button" className={linkBtn} title="Show in the dependency tree" onClick={() => onJumpTree(r.child)}>
                  {r.child}
                </button>
              ) : (
                r.child
              )}
            </span>{' '}
            <span className="text-ink-2">({r.resolvedVersion})</span>
            {targets.length > 1 ? <span className="block font-sans text-[11px] text-muted">{r.target}</span> : null}
          </span>
        ),
        sortValue: (r) => r.childKey,
      },
      {
        id: 'requested',
        header: 'Requested versions',
        render: (r) => (
          <ul className="space-y-0.5 font-mono text-xs">
            {r.groups.map((g) => (
              <li key={g.requestedVersion}>{formatRequestedGroup(g)}</li>
            ))}
          </ul>
        ),
      },
      { id: 'spread', header: 'Spread', render: (r) => <span className="tabular text-xs">{formatSpread(r)}</span>, sortValue: (r) => r.spread ?? (r.spreadDiff === 'major' ? Number.MAX_SAFE_INTEGER : -1) },
      { id: 'oldest', header: 'Oldest requester', render: (r) => <span className="font-mono text-xs">{r.oldestRequesters.join(', ')}</span>, sortValue: (r) => r.oldestRequesters[0]?.toLowerCase() ?? '' },
      { id: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} />, sortValue: (r) => severityRank(r.severity) },
      ...(merged
        ? [
            {
              id: 'shipped',
              header: 'Shipped by',
              render: (r: SkewRow) => (
                <span className="text-xs">
                  {r.shippedBy.join(', ')}
                  {r.drift.length > 0 ? (
                    <button type="button" className={cx(linkBtn, 'block text-warn-ink')} onClick={onOpenDrift} title="Open Duplicates → Across projects (drift)">
                      cross-project drift: also {r.drift.join(', ')}
                    </button>
                  ) : null}
                </span>
              ),
              sortValue: (r: SkewRow) => r.drift.length,
            },
          ]
        : []),
    ];
    return isPublic ? columns.map((c) => (c.id === 'spread' ? { ...c, header: 'SemVer distance' } : c)) : columns;
  };

  const consumerColumns: Column<ConsumerRow>[] = [
    {
      id: 'package',
      header: 'Package (version)',
      render: (c) => (
        <span className="font-mono text-xs">
          {c.parent} <span className="text-ink-2">({c.versions.join(', ')})</span>
          {c.isRootProject ? <span className="ml-1 rounded bg-surface-2 px-1 font-sans text-[10px]">root project</span> : null}
        </span>
      ),
      sortValue: (c) => c.parentKey,
    },
    { id: 'stale', header: 'Stale edges', render: (c) => <span className="tabular text-xs">{c.staleEdges}</span>, sortValue: (c) => c.staleEdges },
    { id: 'oldest', header: 'Oldest-in-row count', render: (c) => <span className="tabular text-xs">{c.oldestInRow}</span>, compare: (a, b) => a.oldestInRow - b.oldestInRow || (a.maxLag ?? -1) - (b.maxLag ?? -1) },
    { id: 'max', header: 'Max lag', render: (c) => <span className="tabular text-xs">{c.maxLag ?? `n/a (${c.worstDiff})`}</span>, sortValue: (c) => c.maxLag ?? -1 },
    { id: 'median', header: 'Median lag', render: (c) => <span className="tabular text-xs">{c.medianLag ?? 'n/a'}</span>, sortValue: (c) => c.medianLag ?? -1 },
    { id: 'severity', header: 'Severity', render: (c) => <SeverityBadge severity={c.severity} />, sortValue: (c) => severityRank(c.severity) },
    { id: 'action', header: 'Recommended action', render: (c) => <span className="block max-w-md text-xs text-ink-2">{c.action}</span> },
  ];
  const consumers = skew.consumers.filter((c) => passesSeverity(c.severity, severity) && (!q || c.parentKey.includes(q)));

  const rebuildColumns: Column<RebuildStep>[] = [
    { id: 'wave', header: 'Wave', render: (s) => <span className="tabular text-xs">{s.wave > 0 ? s.wave : 'blocked'}</span>, sortValue: (s) => (s.wave > 0 ? s.wave : Number.MAX_SAFE_INTEGER) },
    {
      id: 'package',
      header: 'Package',
      render: (s) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          {s.origin ? <OriginDot origin={s.origin} /> : null}
          {s.id}
        </span>
      ),
      sortValue: (s) => s.key,
    },
    {
      id: 'reason',
      header: 'Reason',
      render: (s) => <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-semibold', s.reason === 'stale' ? 'bg-warn-bg text-warn-ink' : 'bg-info-bg text-info-ink')}>{s.reason}</span>,
      sortValue: (s) => s.reason,
    },
    {
      id: 'because',
      header: 'Because',
      render: (s) => (
        <span className="block max-w-xl text-xs text-ink-2">
          {s.reason === 'stale' ? 'Compiled against: ' : 'Consumes rebuilt: '}
          <span className="font-mono">{s.because.join(', ')}</span>
        </span>
      ),
    },
  ];
  const steps = skew.rebuild.steps.filter((s) => !q || s.key.includes(q));

  const floatingColumns: Column<FloatingRef>[] = [
    {
      id: 'package',
      header: 'Package',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          {r.origin ? <OriginDot origin={r.origin} /> : null}
          {r.id}
          {r.autoReferenced ? <span className="rounded bg-surface-2 px-1 font-sans text-[10px]">implicit</span> : null}
        </span>
      ),
      sortValue: (r) => r.key,
    },
    ...(merged ? [{ id: 'project', header: 'Project', render: (r: FloatingRef) => <span className="text-xs">{r.project}</span>, sortValue: (r: FloatingRef) => r.project }] : []),
    { id: 'range', header: 'Range (as written)', render: (r) => <span className="font-mono text-xs">{r.range}</span>, sortValue: (r) => r.range },
    {
      id: 'kind',
      header: 'Kind',
      render: (r) => (
        <span className="text-xs">
          {RANGE_KIND_LABEL[r.kind]}
          {r.centrallyManaged ? <span className="block text-[11px] text-muted">centrally managed</span> : null}
          {r.versionOverride ? <span className="block text-[11px] text-muted">VersionOverride</span> : null}
        </span>
      ),
      sortValue: (r) => r.kind,
    },
    { id: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} />, sortValue: (r) => severityRank(r.severity) },
    { id: 'resolved', header: 'Resolved', render: (r) => <span className="font-mono text-xs">{r.resolvedVersion ?? '—'}</span>, compare: (a, b) => compareVersionStrings(a.resolvedVersion ?? '', b.resolvedVersion ?? '') },
    {
      id: 'consumers',
      header: 'Older consumers',
      render: (r) =>
        r.note ? (
          <span className="block max-w-md text-xs">
            {r.note}{' '}
            {r.olderConsumers?.rowId ? (
              <button type="button" className={linkBtn} onClick={() => showSkewRow(r.id, !skew.internal.some((x) => x.rowId === r.olderConsumers?.rowId))}>
                Show skew row
              </button>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-muted">—</span>
        ),
    },
  ];
  const isInternalRef = (r: FloatingRef) => r.origin === 'Project' || r.origin === 'Private' || r.origin === 'PrivateInferred';
  const refs = floating.refs.filter(
    (r) =>
      (kind === 'all' || (kind === 'floating' ? isFloatingKind(r.kind) : r.kind === kind)) &&
      (origin === 'all' || (origin === 'internal' ? isInternalRef(r) : !isInternalRef(r))) &&
      (!target || r.target === target) &&
      (!q || r.key.includes(q)),
  );

  const severityOptions = (
    <select className={field} value={severity} onChange={(e) => setSeverity(e.target.value as SeverityFilter)} aria-label="Minimum severity">
      <option value="any">Any severity</option>
      <option value="low">Low and up</option>
      <option value="medium">Medium and up</option>
      <option value="high">High</option>
    </select>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-ink-2">
          A <strong>stale edge</strong> is an internal package compiled against an older build of another internal package than the one that ships. Lag = resolved build − requested build, computed when both share major.minor.patch.
        </p>
        <button type="button" className={btn} onClick={() => setDrawer(true)}>
          Settings
        </button>
      </div>
      <SkewSettingsDrawer open={drawer} onClose={() => setDrawer(false)} settings={settings} onSettings={onSettings} />

      {skew.warnings.map((w) => (
        <Banner key={w} tone="warn" title={w} />
      ))}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={card}>
          <p className="text-xs uppercase tracking-wide text-ink-2">Stale packages</p>
          <p className="tabular text-2xl font-semibold">{skew.internal.length}</p>
          <p className="flex flex-wrap gap-1.5 pt-1 text-xs">
            <span className={cx('rounded px-1.5', SEVERITY_STYLE.high)}>{skew.counts.high} high</span>
            <span className={cx('rounded px-1.5', SEVERITY_STYLE.medium)}>{skew.counts.medium} medium</span>
            <span className={cx('rounded px-1.5', SEVERITY_STYLE.low)}>{skew.counts.low} low</span>
          </p>
        </div>
        <div className={card}>
          <p className="text-xs uppercase tracking-wide text-ink-2">Outlier</p>
          <p className="truncate font-mono text-lg font-semibold" title={skew.outlier?.consumer.parent}>
            {skew.outlier?.consumer.parent ?? 'none'}
          </p>
          <p className={hint}>{skew.outlier ? `oldest requester in ${skew.outlier.consumer.oldestInRow}, max lag ${skew.outlier.consumer.maxLag ?? skew.outlier.consumer.worstDiff}` : 'No package is the oldest requester anywhere.'}</p>
        </div>
        <div className={card}>
          <p className="text-xs uppercase tracking-wide text-ink-2">Floating references</p>
          <p className="tabular text-2xl font-semibold">{floating.floatingCount}</p>
          <p className={hint}>{floatingRefs.filter((r) => r.olderConsumers).length} with consumers expecting older versions</p>
        </div>
        <div className={card}>
          <p className="text-xs uppercase tracking-wide text-ink-2">Lock file</p>
          {floating.restore.length === 1 ? (
            <p className="text-lg font-semibold">
              <TriBadge value={floating.restore[0]?.flags.lockFile ?? 'unknown'} />
            </p>
          ) : (
            <p className="tabular text-lg font-semibold">
              {lockKnown} of {floating.restore.length} enabled
            </p>
          )}
          <p className={hint}>From project.restore; &quot;unknown&quot; means the property is absent (NuGet writes it only when set).</p>
        </div>
      </div>

      {skew.outlier ? (
        <Banner tone="warn" title="Outlier">
          <p>{skew.outlier.message}</p>
        </Banner>
      ) : null}

      {skew.casing.length > 0 ? (
        <Banner tone="info" title={`${skew.casing.length} package Id${skew.casing.length === 1 ? ' is' : 's are'} spelled with different casing`}>
          <p>NuGet matches Ids case-insensitively, and so does this analysis. Shown with the casing of the resolved package.</p>
          <ul className="list-disc pl-5 text-xs">
            {skew.casing.slice(0, 20).map((c) => (
              <li key={c.key}>
                <span className="font-mono">{c.variants.map((v) => v.spelling).join(' / ')}</span>{' '}
                <span className="text-ink-2">({c.variants.map((v) => `${v.spelling}: ${v.seenIn.slice(0, 3).join(', ')}${v.seenIn.length > 3 ? ', …' : ''}`).join('; ')})</span>
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <Tabs<Sub>
        label="Version skew sections"
        size="sm"
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'skew', label: 'Per-package skew', count: skew.internal.length },
          { id: 'consumers', label: 'Consumer ranking', count: skew.consumers.length },
          { id: 'rebuild', label: 'Rebuild plan', count: skew.rebuild.steps.length },
          { id: 'floating', label: 'Floating refs', count: floating.floatingCount },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <input type="search" className={`${field} w-64 max-w-full`} placeholder="Filter by package Id…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter version skew" />
        {sub === 'skew' || sub === 'floating' ? (
          <select className={field} value={origin} onChange={(e) => setOrigin(e.target.value as OriginFilter)} aria-label="Internal or public">
            <option value="internal">Internal</option>
            <option value="public">Public / system</option>
            <option value="all">Internal + public</option>
          </select>
        ) : null}
        {sub !== 'rebuild' && sub !== 'floating' ? severityOptions : null}
        {sub === 'floating' ? (
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Range kind">
            <option value="floating">Floating only</option>
            <option value="all">All kinds</option>
            {(Object.keys(RANGE_KIND_LABEL) as RangeKind[]).map((k) => (
              <option key={k} value={k}>
                {RANGE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        ) : null}
        {targets.length > 1 && (sub === 'skew' || sub === 'floating') ? (
          <select className={field} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target framework">
            <option value="">All targets</option>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {sub === 'skew' ? (
        <div className="space-y-4">
          {origin !== 'public' ? (
            <section className="space-y-2">
              <h2 className={h2}>
                Internal packages <span className="tabular font-normal text-muted">({internalRows.length} of {skew.internal.length})</span>
              </h2>
              {skew.internal.length === 0 ? (
                <p className={hint}>No stale internal edges. Internal means Project, Private, or Private (inferred) on the Classification tab; Unclassified packages are not internal.</p>
              ) : null}
              <DataTable label="Internal version skew" rows={internalRows} columns={skewColumns(false)} rowKey={(r) => r.rowId} expand={(r) => <EdgeDetail row={r} />} initialSort={{ id: 'spread', dir: -1 }} empty="No rows match the filters." />
            </section>
          ) : null}
          {origin !== 'internal' ? (
            <section className="space-y-2">
              <h2 className={h2}>
                Public and system packages <span className="tabular font-normal text-muted">({publicRows.length} of {skew.public.length})</span>
              </h2>
              {!settings.includePublic ? (
                <p className={hint}>
                  Turn on <em>Include public and system packages</em> in{' '}
                  <button type="button" className={linkBtn} onClick={() => setDrawer(true)}>
                    Settings
                  </button>
                  .
                </p>
              ) : (
                <DataTable label="Public version skew" rows={publicRows} columns={skewColumns(true)} rowKey={(r) => r.rowId} expand={(r) => <EdgeDetail row={r} />} initialSort={{ id: 'severity', dir: -1 }} empty="No rows match the filters." />
              )}
            </section>
          ) : null}
        </div>
      ) : null}

      {sub === 'consumers' ? (
        <section className="space-y-2">
          <p className={hint}>Internal parents with at least one stale edge, ranked by how often they are the oldest requester, then by max lag.</p>
          <DataTable label="Consumer staleness ranking" rows={consumers} columns={consumerColumns} rowKey={(c) => c.parentKey} empty="No internal consumer has a stale edge." />
        </section>
      ) : null}

      {sub === 'rebuild' ? (
        <section className="space-y-2">
          <div className={`${card} flex flex-wrap items-center gap-x-6 gap-y-2`}>
            <label className="flex items-center gap-2 text-sm">
              Minimum severity
              <select className={field} value={settings.rebuildMinSeverity} onChange={(e) => onSettings({ ...settings, rebuildMinSeverity: e.target.value as RebuildSeverity })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={settings.cascade} onChange={(e) => onSettings({ ...settings, cascade: e.target.checked })} />
              Cascade to consumers
            </label>
            <p className={hint}>
              Stale: has a stale edge at or above the minimum severity. Cascade: consumes a package that is being rebuilt, so it must be rebuilt to pick up the new version. Waves come from the collapsed internal graph; each wave can build in parallel.
            </p>
          </div>
          {skew.rebuild.cycles.length > 0 ? (
            <Banner tone="danger" title="Cycle in the rebuild set: no complete order exists">
              {skew.rebuild.cycles.map((c) => (
                <p key={c.join('>')} className="font-mono text-xs">
                  {c.join(' → ')}
                </p>
              ))}
            </Banner>
          ) : null}
          <DataTable label="Rebuild plan" rows={steps} columns={rebuildColumns} rowKey={(s) => s.key} initialSort={{ id: 'wave', dir: 1 }} empty="Nothing to rebuild at this minimum severity." />
        </section>
      ) : null}

      {sub === 'floating' ? (
        <section className="space-y-3">
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full border-collapse" aria-label="Restore settings">
              <thead>
                <tr>
                  {['Project', 'Lock file', 'Locked mode', 'Central Package Management', 'Transitive pinning'].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {floating.restore.map((r) => (
                  <tr key={r.project}>
                    <td className={cx(td, 'text-xs')}>{r.project}</td>
                    <td className={td}>
                      <TriBadge value={r.flags.lockFile} />
                    </td>
                    <td className={td}>
                      <TriBadge value={r.flags.lockedMode} />
                    </td>
                    <td className={td}>
                      <TriBadge value={r.flags.cpm} />
                      {r.flags.cpmEvidence === 'dependency' ? <span className="block text-[11px] text-muted">from versionCentrallyManaged</span> : null}
                    </td>
                    <td className={td}>
                      <TriBadge value={r.flags.transitivePinning} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={hint}>
            Read from <code className="font-mono">project.restore</code>. NuGet writes these flags only when they are set, so absent means unknown, not disabled. A <code className="font-mono">packages.lock.json</code> next to the project
            is used even when the property is absent.
          </p>
          {floating.recommend ? (
            <div className={`${card} space-y-3`}>
              <h2 className={h2}>Recommendations</h2>
              <p className="text-sm text-ink-2">Floating references exist and no lock file was detected, so every restore can pick up a different build.</p>
              <ol className="list-decimal space-y-3 pl-5 text-sm">
                <li className="space-y-1">
                  <p>
                    Enable <code className="font-mono">packages.lock.json</code> with <code className="font-mono">RestoreLockedMode=true</code> in CI. Floats are then re-evaluated only when you refresh the lock file.
                  </p>
                  <CopyBlock label="Directory.Build.props and commands" text={floating.snippets.lockFile} />
                </li>
                <li className="space-y-1">
                  <p>
                    Pin internal versions with Central Package Management (<code className="font-mono">Directory.Packages.props</code>). The versions below are what resolves today.
                  </p>
                  <CopyBlock label="Directory.Packages.props" text={floating.snippets.cpm} />
                </li>
              </ol>
            </div>
          ) : null}
          <DataTable label="Direct references by range kind" rows={refs} columns={floatingColumns} rowKey={(r) => `${r.project}|${r.target}|${r.key}`} initialSort={{ id: 'severity', dir: -1 }} empty="No direct references match the filters." />
        </section>
      ) : null}
    </div>
  );
}
