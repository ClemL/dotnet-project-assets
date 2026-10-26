'use client';

import { useMemo, useState } from 'react';
import { bindingOriginResolver, buildCorrelation, compareAssemblyVersions, isInternalSide, lookupLoadError, parseAssemblyVersion, parseLoadErrors, rowIsInternal } from '@/lib/binding';
import type { AssemblyCopies, BindingIssue, BindingResult, BindingSeverity, ClassifyOutput, ClassifySettings, CorrelationRow, PackageLink } from '@/lib/types';
import { compareVersionStrings } from '@/lib/version';
import { SCRIPT_URL } from '../input/BindingInputs';
import { Banner } from '../ui/Banner';
import { DataTable, type Column } from '../ui/DataTable';
import { card, cx, field, h2, hint, linkBtn, td, th } from '../ui/styles';

const SEVERITY_RANK: Record<BindingSeverity, number> = { error: 0, warning: 1, info: 2, ok: 3 };
const SEVERITY_STYLE: Record<BindingSeverity, string> = {
  error: 'bg-danger-bg text-danger-ink',
  warning: 'bg-warn-bg text-warn-ink',
  info: 'bg-info-bg text-info-ink',
  ok: 'bg-surface-2 text-ok',
};

type SeverityFilter = 'problems' | BindingSeverity | 'all';

function SeverityBadge({ severity }: { severity: BindingSeverity }) {
  return <span className={cx('inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase', SEVERITY_STYLE[severity])}>{severity}</span>;
}

const ZERO_VERSION = parseAssemblyVersion('0.0.0.0')!;
const byAssemblyVersion = (a: string | undefined | null, b: string | undefined | null) =>
  compareAssemblyVersions(parseAssemblyVersion(a) ?? ZERO_VERSION, parseAssemblyVersion(b) ?? ZERO_VERSION);

interface Ctx {
  result: BindingResult;
  canJump: boolean;
  onJump: (packageId: string) => void;
}

function PackageCell({ link, ctx, outside }: { link: PackageLink | undefined; ctx: Ctx; outside: string }) {
  if (!link) return <span className="text-xs text-muted">{outside}</span>;
  return (
    <span className="font-mono text-xs">
      {ctx.canJump ? (
        <button type="button" className={linkBtn} title="Show in the dependency tree" onClick={() => ctx.onJump(link.packageId)}>
          {link.packageId}
        </button>
      ) : (
        link.packageId
      )}{' '}
      <span className="text-ink-2">{link.packageVersion}</span>
      {link.packageType !== 'package' ? <span className="ml-1 rounded bg-surface-2 px-1 font-sans text-[10px] text-ink-2">{link.packageType}</span> : null}
    </span>
  );
}

function rootName(result: BindingResult, root: number): string {
  return result.manifest?.roots[root] ?? `root ${root}`;
}

function DeployedCell({ issue }: { issue: BindingIssue }) {
  const t = issue.target;
  if (!t) return <span className="text-xs text-danger-ink">not deployed</span>;
  if (t.source === 'framework-assumed') return <span className="text-xs text-ink-2">framework (assumed)</span>;
  return (
    <span className="font-mono text-xs">
      {t.version}
      <span className="block font-sans text-[11px] text-muted">{t.source === 'framework' ? `framework ${t.framework ?? ''}` : t.root ? `plugin root ${t.root}` : 'app folder'}</span>
    </span>
  );
}

function issueColumns(ctx: Ctx): Column<BindingIssue>[] {
  return [
    { id: 'severity', header: 'Severity', render: (i) => <SeverityBadge severity={i.severity} />, compare: (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] },
    {
      id: 'requester',
      header: 'Requester',
      render: (i) => (
        <span className="font-mono text-xs" title={`${rootName(ctx.result, i.requester.root)} → ${i.requester.path}`}>
          {i.requester.name} <span className="text-ink-2">{i.requester.version}</span>
          {i.requester.root > 0 ? <span className="block font-sans text-[11px] text-muted">plugin root {i.requester.root}</span> : null}
        </span>
      ),
      sortValue: (i) => i.requester.name.toLowerCase(),
    },
    {
      id: 'requesterPackage',
      header: 'Requester package',
      render: (i) => <PackageCell link={i.requesterPackage} ctx={ctx} outside="outside deps.json (dynamically loaded?)" />,
      sortValue: (i) => i.requesterPackage?.packageId.toLowerCase() ?? '~',
    },
    {
      id: 'reference',
      header: 'Reference',
      render: (i) => (
        <span className="font-mono text-xs">
          {i.reference.name} <span className="text-ink-2">{i.reference.version}</span>
        </span>
      ),
      sortValue: (i) => i.reference.name.toLowerCase(),
    },
    { id: 'deployed', header: 'Deployed', render: (i) => <DeployedCell issue={i} />, compare: (a, b) => byAssemblyVersion(a.target?.version, b.target?.version) },
    {
      id: 'targetPackage',
      header: 'Deployed package',
      render: (i) => (i.isFramework ? <span className="text-xs text-muted">shared framework</span> : <PackageCell link={i.targetPackage} ctx={ctx} outside={i.target ? 'outside deps.json' : '—'} />),
      sortValue: (i) => i.targetPackage?.packageId.toLowerCase() ?? '~',
    },
    { id: 'classification', header: 'Classification', render: (i) => <code className="text-xs">{i.classification}</code>, sortValue: (i) => i.classification },
    { id: 'hint', header: 'Hint', render: (i) => <span className="block max-w-md text-xs text-ink-2">{i.hint ?? ''}</span>, className: 'min-w-[16rem]' },
  ];
}

function IssueDetail({ issue, result }: { issue: BindingIssue; result: BindingResult }) {
  return (
    <div className="space-y-1">
      <p>
        <span className="text-ink-2">Requester file:</span> <span className="font-mono">{rootName(result, issue.requester.root)} → {issue.requester.path}</span>
      </p>
      {issue.target?.path ? (
        <p>
          <span className="text-ink-2">Deployed file:</span> <span className="font-mono">{rootName(result, issue.target.root ?? 0)} → {issue.target.path}</span>
        </p>
      ) : null}
      <p>
        <span className="text-ink-2">Public key token:</span> reference <span className="font-mono">{issue.reference.publicKeyToken ?? 'null'}</span>, deployed{' '}
        <span className="font-mono">{issue.target ? (issue.target.publicKeyToken ?? 'null') : '—'}</span>
      </p>
      {issue.targetPackage?.assemblyVersionInDeps ? (
        <p>
          <span className="text-ink-2">deps.json:</span> {issue.targetPackage.packageId} {issue.targetPackage.packageVersion} ships assembly {issue.targetPackage.assemblyVersionInDeps} ({issue.targetPackage.depsFile})
        </p>
      ) : null}
      {issue.notes.map((n, k) => (
        <p key={k} className="text-ink-2">
          {n}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error lookup
// ---------------------------------------------------------------------------

function ErrorLookup({ ctx }: { ctx: Ctx }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(0);
  const parsed = useMemo(() => parseLoadErrors(text), [text]);
  const current = parsed[Math.min(selected, parsed.length - 1)];
  const lookup = useMemo(() => (current ? lookupLoadError(ctx.result, current) : null), [ctx.result, current]);
  const failing = lookup?.requesters.some((r) => r.severity === 'error') ?? false;

  return (
    <div className={`${card} space-y-3`}>
      <div>
        <label htmlFor="load-error" className={h2}>
          Paste a FileNotFoundException / FileLoadException message
        </label>
        <p className={hint}>Finds every assembly that references that exact name and version, what is deployed instead, and which NuGet packages are involved.</p>
      </div>
      <textarea
        id="load-error"
        className={`${field} h-20 w-full font-mono text-xs`}
        placeholder="Could not load file or assembly 'Model.Import, Version=10.0.0.34377, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified."
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSelected(0);
        }}
        spellCheck={false}
      />
      {text.trim() !== '' && parsed.length === 0 ? <p className="text-sm text-warn-ink">No assembly display name found. Expected text like &apos;Name, Version=1.2.3.4, Culture=neutral, PublicKeyToken=null&apos;.</p> : null}
      {parsed.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Assemblies found in the message">
          {parsed.map((p, k) => (
            <button
              key={`${p.name}/${p.version}`}
              type="button"
              aria-pressed={k === selected}
              onClick={() => setSelected(k)}
              className={cx('rounded border px-2 py-0.5 font-mono text-xs', k === selected ? 'border-accent bg-info-bg text-info-ink' : 'border-line-strong text-ink-2 hover:bg-surface-2')}
            >
              {p.name} {p.version}
            </button>
          ))}
        </div>
      ) : null}
      {current && lookup ? (
        <div className="space-y-3">
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {[
              ['Exception', current.exception ?? '—'],
              ['Assembly', current.name],
              ['Version', current.version ?? '—'],
              ['Culture', current.culture ?? '—'],
              ['PublicKeyToken', current.publicKeyToken === undefined ? '—' : (current.publicKeyToken ?? 'null')],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-ink-2">{k}</dt>
                <dd className="font-mono text-xs">{v}</dd>
              </div>
            ))}
          </dl>
          <Banner tone={failing ? 'danger' : lookup.requesters.length === 0 ? 'warn' : 'info'} title={lookup.verdict} />
          <div className="text-sm">
            <p className="font-medium">Deployed {current.name}</p>
            <ul className="list-disc pl-5 text-xs">
              {lookup.deployed.copies.map((c) => (
                <li key={`${c.root}/${c.path}`}>
                  <span className="font-mono">{c.version}</span> at <span className="font-mono">{c.rootPath} → {c.path}</span>
                  {c.rid ? ` (RID ${c.rid})` : ''}
                </li>
              ))}
              {lookup.deployed.framework ? (
                <li>
                  <span className="font-mono">{lookup.deployed.framework.version}</span> in the shared framework {lookup.deployed.framework.framework}
                </li>
              ) : null}
              {lookup.deployed.owners.map((o) => (
                <li key={`${o.depsFile}/${o.packageId}/${o.packageVersion}`}>
                  {o.depsFile}: {o.packageType} <span className="font-mono">{o.packageId} {o.packageVersion}</span> ships assembly <span className="font-mono">{o.assemblyVersion ?? 'unknown'}</span>
                </li>
              ))}
              {lookup.deployed.copies.length === 0 && !lookup.deployed.framework && lookup.deployed.owners.length === 0 ? <li>Not deployed in any provided input.</li> : null}
            </ul>
          </div>
          {lookup.requesters.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse" aria-label="Requesters of the assembly">
                <thead>
                  <tr>
                    {['Requester', 'Requester package', 'Deployed', 'Deployed package', 'Classification', 'Hint'].map((h) => (
                      <th key={h} className={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lookup.requesters.map((i) => (
                    <tr key={i.rowId}>
                      <td className={cx(td, 'font-mono text-xs')}>
                        {i.requester.name} <span className="text-ink-2">{i.requester.version}</span>
                      </td>
                      <td className={td}>
                        <PackageCell link={i.requesterPackage} ctx={ctx} outside="outside deps.json (dynamically loaded?)" />
                      </td>
                      <td className={td}>
                        <DeployedCell issue={i} />
                      </td>
                      <td className={td}>{i.isFramework ? <span className="text-xs text-muted">shared framework</span> : <PackageCell link={i.targetPackage} ctx={ctx} outside={i.target ? 'outside deps.json' : '—'} />}</td>
                      <td className={td}>
                        <SeverityBadge severity={i.severity} /> <code className="text-xs">{i.classification}</code>
                      </td>
                      <td className={cx(td, 'max-w-md text-xs text-ink-2')}>{i.hint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className={hint}>
            On .NET, a missing file, a deployed version lower than the reference, and a DLL that <code className="font-mono">deps.json</code> does not list all raise FileNotFoundException &quot;The system cannot find the file
            specified&quot; (verified on .NET 10.0.13), so the exception type alone does not tell them apart.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function BindingCheck({
  result,
  classification,
  settings,
  canJump,
  onJump,
}: {
  result: BindingResult;
  classification: ClassifyOutput | undefined;
  settings: ClassifySettings;
  /** Whether project.assets.json files are analyzed, so packages can be shown in the tree. */
  canJump: boolean;
  onJump: (packageId: string) => void;
}) {
  const [severity, setSeverity] = useState<SeverityFilter>('problems');
  const [internalOnly, setInternalOnly] = useState(true);
  const [hideFramework, setHideFramework] = useState(true);
  const [query, setQuery] = useState('');
  const [nonMonotonicOnly, setNonMonotonicOnly] = useState(false);

  const ctx: Ctx = { result, canJump, onJump };
  const originOf = useMemo(() => bindingOriginResolver(classification, settings), [classification, settings]);

  // Internal/framework filters apply to the cards and the table; severity and text only to the table.
  const scoped = useMemo(
    () => result.issues.filter((i) => (!hideFramework || !i.isFramework) && (!internalOnly || rowIsInternal(i, originOf))),
    [result.issues, hideFramework, internalOnly, originOf],
  );
  const counts = useMemo(() => {
    const c: Record<BindingSeverity, number> = { error: 0, warning: 0, info: 0, ok: 0 };
    for (const i of scoped) c[i.severity]++;
    return c;
  }, [scoped]);
  const q = query.trim().toLowerCase();
  const issues = useMemo(
    () =>
      scoped.filter((i) => {
        if (severity === 'problems' ? i.severity !== 'error' && i.severity !== 'warning' : severity !== 'all' && i.severity !== severity) return false;
        if (!q) return true;
        return [i.requester.name, i.reference.name, i.requesterPackage?.packageId, i.targetPackage?.packageId, i.classification, i.hint].some((s) => s?.toLowerCase().includes(q));
      }),
    [scoped, severity, q],
  );

  const copies = useMemo(
    () =>
      result.copies.filter((c) => {
        if (q && !c.key.includes(q)) return false;
        if (!internalOnly) return true;
        const owner = result.deps.flatMap((d) => d.byAssembly[c.key] ?? [])[0];
        return isInternalSide(owner ? originOf(owner.packageId, owner.packageType) : originOf(c.name)) !== false;
      }),
    [result, q, internalOnly, originOf],
  );

  const correlation = useMemo(
    () => buildCorrelation(result.deps, (key, type) => !internalOnly || isInternalSide(originOf(key, type)) === true),
    [result.deps, internalOnly, originOf],
  );
  const correlationRows = correlation.filter((r) => (!nonMonotonicOnly || r.nonMonotonic) && (!q || r.packageId.toLowerCase().includes(q) || r.assembly.toLowerCase().includes(q)));
  const nonMonotonicCount = correlation.filter((r) => r.nonMonotonic).length;

  const m = result.manifest;
  const primary = result.deps.find((d) => d.primary);
  const gaps = result.deps.flatMap((d) => d.gaps.filter((g) => !g.expected));

  const copyColumns: Column<AssemblyCopies>[] = [
    { id: 'name', header: 'Assembly', render: (c) => <span className="font-mono text-xs">{c.name}</span>, sortValue: (c) => c.key },
    { id: 'count', header: 'Copies', render: (c) => <span className="tabular text-xs">{c.copies.length}</span>, sortValue: (c) => c.copies.length },
    {
      id: 'copies',
      header: 'Versions and paths',
      render: (c) => (
        <ul className="space-y-0.5 text-xs">
          {c.copies.map((x) => (
            <li key={`${x.root}/${x.path}`}>
              <span className="font-mono">{x.version}</span> <span className="text-ink-2">({x.fileVersion ?? 'no file version'})</span> — <span className="font-mono">{x.rootPath} → {x.path}</span>
              {x.rid ? ` (RID ${x.rid})` : ''}
            </li>
          ))}
        </ul>
      ),
    },
  ];

  const correlationColumns: Column<CorrelationRow>[] = [
    {
      id: 'package',
      header: 'Package',
      render: (r) => (
        <span className="font-mono text-xs">
          {canJump ? (
            <button type="button" className={linkBtn} title="Show in the dependency tree" onClick={() => onJump(r.packageId)}>
              {r.packageId}
            </button>
          ) : (
            r.packageId
          )}
        </span>
      ),
      sortValue: (r) => r.packageId.toLowerCase(),
    },
    { id: 'packageVersion', header: 'Package version', render: (r) => <span className="font-mono text-xs">{r.packageVersion}</span>, compare: (a, b) => compareVersionStrings(a.packageVersion, b.packageVersion) },
    { id: 'assembly', header: 'Assembly', render: (r) => <span className="font-mono text-xs">{r.assembly}</span>, sortValue: (r) => r.assembly.toLowerCase() },
    { id: 'assemblyVersion', header: 'AssemblyVersion', render: (r) => <span className="font-mono text-xs">{r.assemblyVersion ?? 'unknown'}</span>, compare: (a, b) => byAssemblyVersion(a.assemblyVersion, b.assemblyVersion) },
    { id: 'fileVersion', header: 'FileVersion', render: (r) => <span className="font-mono text-xs">{r.fileVersion ?? '—'}</span> },
    {
      id: 'flag',
      header: 'Monotonic',
      render: (r) =>
        r.nonMonotonic ? (
          <span className="text-xs text-warn-ink">
            ✗ inverts with {r.conflictsWith.map((c) => `${c.packageId} ${c.packageVersion} (${c.assemblyVersion})`).join('; ')}
          </span>
        ) : (
          <span className="text-xs text-muted">ok</span>
        ),
      sortValue: (r) => (r.nonMonotonic ? 0 : 1),
    },
  ];

  return (
    <div className="space-y-4">
      <ErrorLookup ctx={ctx} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={card}>
          <p className="text-xs uppercase tracking-wide text-ink-2">Errors</p>
          <p className="tabular text-2xl font-semibold text-danger-ink">{counts.error}</p>
          <p className={hint}>MISSING or TOO_OLD: fails to load</p>
        </div>
        <div className={card}>
          <p className="text-xs uppercase tracking-wide text-ink-2">Warnings</p>
          <p className="tabular text-2xl font-semibold text-warn-ink">{counts.warning}</p>
          <p className={hint}>Major roll-forward or token mismatch: binds, but risky</p>
        </div>
        <div className={card}>
          <p className="text-xs uppercase tracking-wide text-ink-2">Bind OK</p>
          <p className="tabular text-2xl font-semibold text-ok">{counts.ok + counts.info}</p>
          <p className={hint}>
            {counts.ok} exact, {counts.info} roll-forward or assumed framework · {result.issues.length} references in total
          </p>
        </div>
        <div className={`${card} space-y-1 text-xs`}>
          <p className="uppercase tracking-wide text-ink-2">Inputs</p>
          <p>
            ✓ deps.json: <span className="font-mono">{primary?.fileName}</span> ({primary?.libraryCount} libraries, {primary?.runtimeTarget})
            {result.deps.length > 1 ? ` + ${result.deps.length - 1} more` : ''}
          </p>
          <p>
            ✓ manifest: {m?.assemblies.length} assemblies in {m?.roots.length} root{m?.roots.length === 1 ? '' : 's'}
            {m?.source === 'dll-upload' ? ' (from DLL upload)' : ''}
          </p>
          <p>
            {m && m.framework.length > 0 ? '✓' : '✗'} framework list:{' '}
            {m && m.framework.length > 0
              ? `${m.framework.length} assemblies${(m.frameworks ?? []).filter((f) => f.usedVersion).map((f) => ` · ${f.name} ${f.usedVersion}${f.exact ? '' : ` (for ${f.requestedVersion})`}`).join('')}`
              : 'none, framework names are assumed'}
          </p>
          <p>
            {result.runtimeConfig ? '✓' : '–'} runtimeconfig.json:{' '}
            {result.runtimeConfig ? result.runtimeConfig.frameworks.map((f) => `${f.name} ${f.version}`).join(', ') || 'no frameworks' : 'not loaded (optional)'}
            {result.runtimeConfig?.selfContained ? ' (self-contained)' : ''}
          </p>
        </div>
      </div>

      {gaps.length > 0 || result.warnings.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-warn-ink">
            {result.warnings.length} input warning{result.warnings.length === 1 ? '' : 's'}
            {gaps.length > 0 ? `, ${gaps.length} deps.json asset${gaps.length === 1 ? '' : 's'} without assemblyVersion` : ''}
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {result.warnings.map((w, k) => (
              <li key={k}>{w}</li>
            ))}
            {gaps.map((g) => (
              <li key={`${g.packageId}/${g.path}`}>
                No assemblyVersion: {g.packageType} <span className="font-mono">{g.packageId} {g.packageVersion}</span> → <span className="font-mono">{g.path}</span> (version unknown; not guessed)
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className={`${card} flex flex-wrap items-center gap-x-4 gap-y-2`}>
        <label className="flex items-center gap-1.5 text-sm">
          Severity
          <select className={field} value={severity} onChange={(e) => setSeverity(e.target.value as SeverityFilter)}>
            <option value="problems">Errors and warnings</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
            <option value="info">Info</option>
            <option value="ok">OK</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={internalOnly} onChange={(e) => setInternalOnly(e.target.checked)} />
          Internal only
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={hideFramework} onChange={(e) => setHideFramework(e.target.checked)} />
          Hide framework references
        </label>
        <input type="search" className={`${field} w-64 max-w-full`} placeholder="Filter by assembly, package, or hint…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter binding results" />
        <p className={cx(hint, 'basis-full')}>
          Internal only hides a row when both sides are known to be non-internal (origin from the Classification tab, else deps.json project type, else your prefixes). Requesters outside deps.json are kept.
        </p>
      </div>

      <section className="space-y-2" aria-labelledby="binding-issues">
        <h2 id="binding-issues" className={h2}>
          References <span className="tabular font-normal text-muted">({issues.length} of {result.issues.length})</span>
        </h2>
        <DataTable
          label="Assembly references"
          rows={issues}
          columns={issueColumns(ctx)}
          rowKey={(i) => i.rowId}
          initialSort={{ id: 'severity', dir: 1 }}
          expand={(i) => <IssueDetail issue={i} result={result} />}
          empty="No references match the filters."
        />
      </section>

      <section className="space-y-2" aria-labelledby="binding-copies">
        <h2 id="binding-copies" className={h2}>
          Multiple copies <span className="tabular font-normal text-muted">({copies.length})</span>
        </h2>
        <p className={hint}>The same assembly name in several folders with different versions. Plugin folders can shadow the app&apos;s copy or conflict with it, depending on the loader.</p>
        <DataTable label="Assemblies with multiple copies" rows={copies} columns={copyColumns} rowKey={(c) => c.key} initialSort={{ id: 'name', dir: 1 }} empty="No assembly appears with different versions." />
      </section>

      <section className="space-y-2" aria-labelledby="binding-correlation">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="binding-correlation" className={h2}>
            Version correlation <span className="tabular font-normal text-muted">({correlationRows.length}; {nonMonotonicCount} non-monotonic)</span>
          </h2>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={nonMonotonicOnly} onChange={(e) => setNonMonotonicOnly(e.target.checked)} />
            Non-monotonic only
          </label>
        </div>
        <p className={hint}>
          Package version ↔ AssemblyVersion ↔ FileVersion from deps.json{internalOnly ? ' for internal packages' : ''}, sorted by package version. ✗ marks a higher package version that ships a lower assembly version (or the reverse): CI
          stamps the two numbers from inconsistent sources, so a package version says nothing about the assembly a DLL was compiled against.
        </p>
        <DataTable
          label="Package and assembly version correlation"
          rows={correlationRows}
          columns={correlationColumns}
          rowKey={(r) => `${r.packageId}/${r.packageVersion}/${r.assembly}`}
          initialSort={{ id: 'packageVersion', dir: 1 }}
          empty={internalOnly ? 'No internal packages identified. Analyze the project.assets.json files (origins and internal prefixes come from the Classification tab), or clear "Internal only".' : 'No packages with assembly versions.'}
        />
      </section>

      <details className={`${card} text-sm`}>
        <summary className="cursor-pointer font-medium">How to produce the inputs</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Build or publish the app. <code className="font-mono">&lt;App&gt;.deps.json</code> and <code className="font-mono">&lt;App&gt;.runtimeconfig.json</code> are next to <code className="font-mono">&lt;App&gt;.dll</code>.
          </li>
          <li>
            Download{' '}
            <a className={linkBtn} href={SCRIPT_URL} download>
              Export-AssemblyManifest.ps1
            </a>{' '}
            (PowerShell 7+). It reads metadata with PEReader and never loads the assemblies.
          </li>
          <li>
            Run it, for example:
            <pre className="mt-1 overflow-x-auto rounded bg-surface-2 p-2 font-mono text-xs">
              {".\\Export-AssemblyManifest.ps1 -BinPath 'C:\\dev\\git\\<Repo>\\<Project>\\bin\\Debug\\net10.0' -ExtraPaths @('C:\\dev\\git\\<Repo>\\plugins') -IncludeFramework $true -DotnetRoot 'C:\\Program Files\\dotnet' -ResultsFolder '.\\results'"}
            </pre>
          </li>
          <li>Load the deps.json, the generated results\AssemblyManifest_&lt;App&gt;_yyyyMMdd_HHmm.json, and optionally runtimeconfig.json on the Inputs tab.</li>
        </ol>
      </details>
    </div>
  );
}
