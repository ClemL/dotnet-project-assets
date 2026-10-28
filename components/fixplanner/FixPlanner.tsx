'use client';

import { useEffect, useMemo, useState } from 'react';
import { readJson, writeJson } from '@/client/storage';
import { compareAssemblyVersions, deployedInfo, looksLikeFramework, parseAssemblyVersion } from '@/lib/binding';
import { isInternalOrigin } from '@/lib/classify';
import {
  buildFixGraph,
  detectStamping,
  emptyObservations,
  MAX_REVISION,
  nugetMinimum,
  observeManifest,
  observeScan,
  ownerResolver,
  parseReferencerScan,
  planCascade,
  planPin,
  scanFromBinding,
  scanFromManifest,
  STAMPING_FIX_SNIPPET,
  summarizeFailure,
} from '@/lib/fixplanner';
import type {
  AnalysisResult,
  BindingResult,
  CascadePlan,
  CascadeRow,
  ClassifyOutput,
  FailureRequester,
  FailureSummary,
  IdKey,
  OwnerLink,
  PinCandidate,
  PinPlan,
  ReferencerScan,
  StampingReport,
} from '@/lib/types';
import { compareVersionStrings } from '@/lib/versions';
import { Banner } from '../ui/Banner';
import { CodeBlock } from '../ui/CodeBlock';
import { DataTable, type Column } from '../ui/DataTable';
import { card, cx, field, h2, hint, linkBtn } from '../ui/styles';

/** No scan found for the target, or the full plan. */
type Plan = { scan: null } | { scan: ReferencerScan; summary: FailureSummary; stamping: StampingReport; pin: PinPlan; cascade: CascadePlan };

const TODOS = [
  { id: 'fix', label: 'Pin the package or rebuild the cascade' },
  { id: 'rescan', label: 'Rerun the REFERENCER scan on the deployed folder' },
  { id: 'smoke', label: 'Smoke-test the requesters that roll forward' },
  { id: 'stamping', label: 'Fix AssemblyVersion stamping in the producing project' },
] as const;

function Todos({ target }: { target: string }) {
  const key = `fix-todos:${target.toLowerCase()}`;
  const [done, setDone] = useState<Record<string, boolean>>({});
  useEffect(() => setDone(readJson<Record<string, boolean>>(key, {})), [key]);
  const toggle = (id: string, value: boolean) => {
    const next = { ...done, [id]: value };
    setDone(next);
    writeJson(key, next);
  };
  return (
    <aside className={`${card} space-y-2`} aria-labelledby="fix-todos">
      <h2 id="fix-todos" className={h2}>
        To-dos <span className="font-mono text-sm font-normal text-ink-2">{target}</span>
      </h2>
      <ul className="space-y-1.5">
        {TODOS.map((t) => (
          <li key={t.id}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={done[t.id] === true} onChange={(e) => toggle(t.id, e.target.checked)} />
              <span className={done[t.id] ? 'text-muted line-through' : undefined}>{t.label}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className={hint}>Saved in this browser for {target}.</p>
    </aside>
  );
}

function OwnerCell({ owner }: { owner: OwnerLink | undefined }) {
  if (!owner) return <span className="text-xs text-muted">unknown</span>;
  return (
    <span className="font-mono text-xs">
      {owner.packageId} <span className="text-ink-2">{owner.packageVersion ?? ''}</span>
      {owner.match === 'by name' ? <span className="ml-1 rounded bg-surface-2 px-1 font-sans text-[10px] text-ink-2">by name</span> : null}
    </span>
  );
}

function StatusBadge({ status }: { status: 'FAIL' | 'OK' }) {
  return <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-semibold', status === 'FAIL' ? 'bg-danger-bg text-danger-ink' : 'bg-surface-2 text-ok')}>{status}</span>;
}

export function FixPlanner({
  binding,
  analysis,
  classification,
  target: requestedTarget,
  onTarget,
  errorVersion,
  scanText,
  onScanText,
}: {
  binding: BindingResult | null;
  analysis: AnalysisResult | null;
  classification: ClassifyOutput | undefined;
  target: string;
  onTarget: (t: string) => void;
  errorVersion?: string;
  scanText: string;
  onScanText: (t: string) => void;
}) {
  const pasted = useMemo(() => (scanText.trim() ? parseReferencerScan(scanText, 'Pasted scan') : null), [scanText]);
  const scans: ReferencerScan[] = useMemo(() => [...(binding?.scans ?? []), ...(pasted ? [pasted] : [])], [binding, pasted]);
  const candidates = useMemo(() => {
    const names = [...scans.map((s) => s.target), ...(binding?.issues.filter((i) => i.severity === 'error').map((i) => i.reference.name) ?? [])].filter((x): x is string => Boolean(x));
    return [...new Map(names.map((n) => [n.toLowerCase(), n])).values()];
  }, [scans, binding]);
  const target = requestedTarget || candidates[0] || '';
  const graph = analysis?.merged.graph;
  const owner = useMemo(() => ownerResolver(binding, graph), [binding, graph]);
  const isInternalKey = useMemo(
    () => (k: IdKey) => {
      const o = classification?.byId[k]?.origin;
      return o !== undefined && isInternalOrigin(o);
    },
    [classification],
  );

  const plan = useMemo((): Plan | null => {
    if (!target) return null;
    const t = target.toLowerCase();
    const scan =
      scans.find((s) => s.target?.toLowerCase() === t) ??
      scans.find((s) => !s.target) ??
      (binding ? scanFromBinding(binding, target) : null) ??
      (binding?.manifest ? scanFromManifest(binding.manifest, target) : null);
    if (!scan) return { scan: null };

    let deployedFallback: { version: string; source: 'manifest' | 'deps.json' } | undefined;
    if (binding) {
      const info = deployedInfo(binding, target);
      const copy = info.copies.find((c) => c.root === 0) ?? info.copies[0];
      if (copy) deployedFallback = { version: copy.version, source: 'manifest' };
      else if (info.owners[0]?.assemblyVersion) deployedFallback = { version: info.owners[0].assemblyVersion, source: 'deps.json' };
    }
    const summary = summarizeFailure({ target: scan.target ?? target, rows: scan.rows, deployedFallback, owner, errorVersion });

    const obs = emptyObservations();
    for (const s of scans) observeScan(obs, s, s.target ?? target);
    if (scan.source === 'binding' || scan.source === 'manifest') observeScan(obs, scan, target);
    if (binding?.manifest) observeManifest(obs, binding.manifest);
    const stamping = detectStamping(obs, (assembly) => {
      if (looksLikeFramework(assembly)) return false;
      const pkg = owner(assembly)?.packageId.toLowerCase() ?? assembly.toLowerCase();
      const origin = classification?.byId[pkg]?.origin;
      return origin === undefined || isInternalOrigin(origin) || origin === 'Unclassified';
    });

    const packageId = summary.targetOwner?.packageId ?? summary.target;
    const pin = planPin({
      packageId,
      assembly: summary.target,
      requiredMinimum: summary.requiredMinimum,
      map: binding?.packageMap ?? [],
      nugetMinimum: analysis ? nugetMinimum(analysis.models, packageId.toLowerCase()) : undefined,
      requesters: summary.requesters,
      tfm: analysis?.models[0]?.targets.find((x) => !x.rid)?.tfm,
      cpm: analysis?.models.some((m) => m.restoreFlags.cpm === 'enabled'),
    });

    const failKeys = new Set<IdKey>(summary.requesters.filter((r) => r.status === 'FAIL').map((r) => (r.owner?.packageId ?? r.assembly).toLowerCase()));
    const cascade: CascadePlan = graph
      ? planCascade(buildFixGraph(graph, { manifest: binding?.manifest, scans: [{ scan, target: summary.target }], owner }), packageId.toLowerCase(), isInternalKey, failKeys)
      : { rows: [], cycles: [], unavailable: 'Analyze the project.assets.json files on the Inputs tab to plan the rebuild cascade.' };
    return { scan, summary, stamping, pin, cascade };
  }, [target, scans, binding, owner, errorVersion, classification, analysis, graph, isInternalKey]);

  const requesterColumns: Column<FailureRequester>[] = [
    { id: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} />, sortValue: (r) => (r.status === 'FAIL' ? 0 : 1) },
    { id: 'dll', header: 'Requester', render: (r) => <span className="font-mono text-xs" title={r.path}>{r.dll}</span>, sortValue: (r) => r.assembly.toLowerCase() },
    { id: 'version', header: 'Its version', render: (r) => <span className="font-mono text-xs">{r.version}</span> },
    { id: 'refersTo', header: 'Compiled against', render: (r) => <span className="font-mono text-xs">{r.refersTo}</span>, sortValue: (r) => r.refersTo },
    { id: 'delta', header: 'Δ revision', render: (r) => <span className="tabular text-xs">{r.delta === null ? 'n/a' : r.delta > 0 ? `+${r.delta}` : r.delta}</span>, sortValue: (r) => r.delta ?? -1 },
    { id: 'owner', header: 'Package', render: (r) => <OwnerCell owner={r.owner} />, sortValue: (r) => r.owner?.packageId.toLowerCase() ?? '~' },
  ];
  const pinColumns: Column<PinCandidate>[] = [
    { id: 'pkg', header: 'Package version', render: (c) => <span className="font-mono text-xs">{c.packageVersion}</span>, compare: (a, b) => compareVersionStrings(a.packageVersion, b.packageVersion) },
    { id: 'asm', header: 'AssemblyVersion', render: (c) => <span className="font-mono text-xs">{c.assemblyVersion}</span> },
    { id: 'file', header: 'FileVersion', render: (c) => <span className="font-mono text-xs">{c.fileVersion ?? '—'}</span> },
    { id: 'tfm', header: 'TFM', render: (c) => <span className="font-mono text-xs">{c.tfm}</span> },
    {
      id: 'ok',
      header: 'Qualifies',
      render: (c) => (
        <span className="text-xs">
          {c.bindsAll ? <span className="text-ok">binds all</span> : <span className="text-danger-ink">too old</span>}
          {c.bindsAll && !c.meetsNuGetMinimum ? <span className="block text-warn-ink">below NuGet minimum (NU1605)</span> : null}
        </span>
      ),
      sortValue: (c) => (c.bindsAll && c.meetsNuGetMinimum ? 0 : c.bindsAll ? 1 : 2),
    },
  ];
  const cascadeColumns: Column<CascadeRow>[] = [
    { id: 'wave', header: 'Wave', render: (r) => <span className="tabular text-xs">{r.wave + 1}</span>, sortValue: (r) => r.wave },
    {
      id: 'pkg',
      header: 'Package',
      render: (r) => (
        <span className="font-mono text-xs">
          {r.id}
          {r.placement === 'dll-references' ? <span className="ml-1 rounded bg-warn-bg px-1 font-sans text-[10px] text-warn-ink">placed from DLL references (unverified)</span> : null}
        </span>
      ),
      sortValue: (r) => r.key,
    },
    { id: 'reason', header: 'Reason', render: (r) => <span className="text-xs text-ink-2">{r.reason.kind === 'target' ? 'target' : `depends on ${r.reason.on.join(', ')}`}</span> },
    { id: 'fail', header: 'Failing requester', render: (r) => (r.failRequester ? <StatusBadge status="FAIL" /> : null), sortValue: (r) => (r.failRequester ? 0 : 1) },
  ];

  const s = plan && 'summary' in plan ? plan.summary : undefined;
  const failing = s?.requesters.filter((r) => r.status === 'FAIL') ?? [];
  const firstFailure = s?.errorVersion ? s.requesters.filter((r) => r.refersTo === s.errorVersion) : [];
  // Deploying exactly the version the exception names is the usual first attempt; show what it leaves failing.
  const errorParsed = parseAssemblyVersion(s?.errorVersion);
  const stillFailing = errorParsed ? failing.filter((r) => compareAssemblyVersions(parseAssemblyVersion(r.refersTo) ?? errorParsed, errorParsed) > 0) : [];
  const example = failing[failing.length - 1];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-4">
        <div className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-0.5 text-xs text-ink-2">
              Assembly that failed to load
              <input className={`${field} w-72 font-mono`} list="fix-targets" value={target} placeholder="Model.Import" onChange={(e) => onTarget(e.target.value)} />
              <datalist id="fix-targets">
                {candidates.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            {errorVersion ? (
              <p className="text-xs text-ink-2">
                From the error lookup: <span className="font-mono">{errorVersion}</span>
              </p>
            ) : null}
          </div>
          <details open={scans.length === 0}>
            <summary className="cursor-pointer text-sm font-medium">REFERENCER scan {pasted ? <span className="font-normal text-ok">· {pasted.rows.length} rows pasted</span> : null}</summary>
            <div className="mt-2 space-y-1">
              <textarea
                className={`${field} h-36 w-full font-mono text-xs`}
                value={scanText}
                onChange={(e) => onScanText(e.target.value)}
                placeholder={'Kind       Dll                             Version   RefersTo\nREFERENCER Plugin.Excel.dll                 10.0.0.0  10.0.0.34377\nDEPLOYED   Model.Import.dll                10.0.0.19269'}
                spellCheck={false}
                aria-label="Paste the REFERENCER scan"
              />
              <p className={hint}>
                Paste the Format-Table output or the CSV from Find-AssemblyReference.ps1. Without a scan, the requesters come from the Binding check (deps.json + manifest) or from the manifest alone.
              </p>
              {pasted?.warnings.map((w) => (
                <p key={w} className="text-xs text-warn-ink">
                  {w}
                </p>
              ))}
              {scanText.trim() && !pasted ? <p className="text-xs text-danger-ink">Not a REFERENCER scan: expected a header row starting with Kind.</p> : null}
            </div>
          </details>
        </div>

        {!target ? <Banner tone="info" title="Paste a REFERENCER scan, or open this tab from Plan fix in the Binding check." /> : null}
        {target && plan && !('summary' in plan) ? (
          <Banner tone="warn" title={`No requesters of ${target} found`}>
            <p>Paste a REFERENCER scan for it, or load deps.json and an assembly manifest that reference it.</p>
          </Banner>
        ) : null}

        {plan && 'summary' in plan && s ? (
          <>
            <section className="space-y-3" aria-labelledby="fix-summary">
              <h2 id="fix-summary" className={h2}>
                1. Failure summary <span className="font-normal text-ink-2">({plan.scan.source === 'binding' ? 'from the Binding check' : plan.scan.source === 'manifest' ? 'from the manifest' : plan.scan.fileName})</span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className={card}>
                  <p className="text-xs uppercase tracking-wide text-ink-2">Required minimum</p>
                  <p className="font-mono text-xl font-semibold">{s.requiredMinimum}</p>
                  <p className={hint}>Highest version any requester was compiled against</p>
                </div>
                <div className={card}>
                  <p className="text-xs uppercase tracking-wide text-ink-2">Deployed {s.target}</p>
                  <p className="font-mono text-xl font-semibold">{s.deployed?.version ?? 'not deployed'}</p>
                  <p className={hint}>
                    {s.deployed ? `from the ${s.deployed.source}` : 'no DEPLOYED row, manifest copy, or deps.json entry'}
                    {s.deployed?.others.length ? `; other copies: ${s.deployed.others.join(', ')}` : ''}
                  </p>
                </div>
                <div className={card}>
                  <p className="text-xs uppercase tracking-wide text-ink-2">Requesters</p>
                  <p className="text-xl font-semibold">
                    <span className="text-danger-ink">{s.failCount} fail</span> · <span className="text-ok">{s.okCount} ok</span>
                  </p>
                  <p className={hint}>
                    Package: <OwnerCell owner={s.targetOwner} />
                  </p>
                </div>
              </div>
              {failing.length > 0 ? (
                <Banner tone="danger" title="The runtime reports only the first failure">
                  <p>
                    {firstFailure.length > 0 ? (
                      <>
                        The exception names <span className="font-mono">{s.target} {s.errorVersion}</span>, the first reference the runtime hit ({firstFailure.map((r) => r.assembly).join(', ')}).{' '}
                      </>
                    ) : null}
                    {failing.length} requester{failing.length === 1 ? '' : 's'} fail{failing.length === 1 ? 's' : ''} in total.{' '}
                    {stillFailing.length > 0 ? (
                      <>
                        Deploying the version the exception names, {s.errorVersion}, still fails {stillFailing.map((r) => `${r.assembly} (${r.refersTo})`).join(', ')}.{' '}
                      </>
                    ) : failing.length > 1 && example ? (
                      <>
                        Fixing one of them (for example deploying a {s.target} that satisfies {example.assembly} at {example.refersTo}) only moves the exception to the next.{' '}
                      </>
                    ) : null}
                    The deployed {s.target} must be at least <strong className="font-mono">{s.requiredMinimum}</strong>.
                  </p>
                </Banner>
              ) : (
                <Banner tone="info" title={`Every requester binds to the deployed ${s.target}`}>
                  <p>If the exception persists, the failing process runs from a different folder or loads an older copy than the one scanned.</p>
                </Banner>
              )}
              <DataTable label={`Requesters of ${s.target}`} rows={s.requesters} columns={requesterColumns} rowKey={(r) => `${r.path ?? r.dll}|${r.refersTo}`} empty="No requesters." />
            </section>

            {plan.stamping.stamped.length > 0 ? (
              <section aria-labelledby="fix-stamping">
                <Banner tone="warn" title={`2. Per-build AssemblyVersion: ${plan.stamping.stamped.map((x) => x.assembly).join(', ')}`}>
                  <p>
                    {plan.stamping.mode === 'outlier'
                      ? `${plan.stamping.fixedBaseline} of ${plan.stamping.baselineTotal} internal assemblies keep one x.y.z.0 AssemblyVersion; these change it with every build:`
                      : `Most internal assemblies here change their AssemblyVersion with every build (${plan.stamping.baselineTotal - plan.stamping.fixedBaseline} of ${plan.stamping.baselineTotal}):`}
                  </p>
                  <ul className="list-disc pl-5 font-mono text-xs">
                    {plan.stamping.stamped.map((x) => (
                      <li key={x.assembly}>
                        {x.assembly}: {x.versions[0]} … {x.versions[x.versions.length - 1]} ({x.referencedVersions} referenced version{x.referencedVersions === 1 ? '' : 's'})
                      </li>
                    ))}
                  </ul>
                  <p>
                    On .NET the deployed version must be ≥ the referenced version, so any consumer built after the shipped build fails to load it, even when nothing in its API changed. And the revision is a 16-bit part: the compiler
                    rejects anything above {MAX_REVISION} (error CS7034), so stamping the build id stops compiling at build {MAX_REVISION + 1}
                    {plan.stamping.stamped[0] ? ` (current ${plan.stamping.stamped[0].maxRevision}, ${MAX_REVISION - plan.stamping.stamped[0].maxRevision} builds left)` : ''}. Keep AssemblyVersion fixed and put the build in
                    FileVersion and InformationalVersion:
                  </p>
                  <CodeBlock label="Example: producing project or Directory.Build.props" code={STAMPING_FIX_SNIPPET} fileName="Directory.Build.props" maxHeight="max-h-60" />
                  <p className="text-xs">
                    FileVersion above 65535 only warns (CS7035), which fails builds that set TreatWarningsAsErrors; keep the full build id in InformationalVersion if that matters.
                  </p>
                </Banner>
              </section>
            ) : null}

            <section className="space-y-2" aria-labelledby="fix-pin">
              <h2 id="fix-pin" className={h2}>
                3. Option 1: pin an existing {plan.pin.packageId} package
              </h2>
              {plan.pin.recommended ? (
                <div className={`${card} space-y-2`}>
                  <p className="text-sm">
                    Lowest package version whose assembly binds every requester: <strong className="font-mono">{plan.pin.recommended.packageVersion}</strong> (AssemblyVersion {plan.pin.recommended.assemblyVersion}).
                    {plan.pin.nugetMinimum ? ` It also meets the highest package-level minimum, ${plan.pin.nugetMinimum.version} (requested by ${plan.pin.nugetMinimum.requestedBy.join(', ')}).` : ''} Add it to the app project:
                  </p>
                  <CodeBlock label="App .csproj" code={plan.pin.snippet ?? ''} maxHeight="max-h-20" />
                  {plan.pin.cpmSnippet ? <CodeBlock label="Directory.Packages.props (Central Package Management is on)" code={plan.pin.cpmSnippet} maxHeight="max-h-20" /> : null}
                  {plan.pin.rollForward.length > 0 ? (
                    <Banner tone="warn" title={`${plan.pin.rollForward.length} requester${plan.pin.rollForward.length === 1 ? '' : 's'} will roll forward`}>
                      <p>
                        These were compiled against an older {s.target} and bind to {plan.pin.recommended.assemblyVersion}. If {s.target}&apos;s API changed in between, they fail at first call with MissingMethodException or
                        TypeLoadException; smoke-test them:
                      </p>
                      <p className="font-mono text-xs">{plan.pin.rollForward.map((r) => `${r.assembly} (${r.refersTo})`).join(', ')}</p>
                    </Banner>
                  ) : null}
                </div>
              ) : (
                <div className={`${card} space-y-2`}>
                  <p className="text-sm">{plan.pin.noneReason} Option 2 (rebuild) below is the way forward. To check versions that were never restored here, search the feed:</p>
                  <CodeBlock label="Feed search" code={plan.pin.feedSearch} maxHeight="max-h-20" />
                </div>
              )}
              {plan.pin.candidates.length > 0 ? <DataTable label={`${plan.pin.packageId} versions in the package map`} rows={plan.pin.candidates} columns={pinColumns} rowKey={(c) => c.packageVersion} initialSort={{ id: 'pkg', dir: 1 }} /> : null}
            </section>

            <section className="space-y-2" aria-labelledby="fix-cascade">
              <h2 id="fix-cascade" className={h2}>
                4. Option 2: rebuild {plan.cascade.startId ?? s.target} and everything downstream
              </h2>
              {plan.cascade.unavailable ? <p className="text-sm text-ink-2">{plan.cascade.unavailable}</p> : null}
              {plan.cascade.cycles.length > 0 ? (
                <Banner tone="danger" title="Cycle: no rebuild order exists">
                  {plan.cascade.cycles.map((c) => (
                    <p key={c.join('>')} className="font-mono text-xs">
                      {c.join(' → ')}
                    </p>
                  ))}
                </Banner>
              ) : null}
              {plan.cascade.rows.length > 0 ? (
                <>
                  <p className={hint}>
                    Wave numbers come from the full build order (assets files plus references read from DLLs), so they match the Build order tab unless a DLL reference adds an edge the assets files lack. Packages in one
                    wave can build in parallel once the previous wave has published.
                  </p>
                  <DataTable label="Rebuild cascade" rows={plan.cascade.rows} columns={cascadeColumns} rowKey={(r) => r.key} initialSort={{ id: 'wave', dir: 1 }} />
                  <CodeBlock
                    label="Rebuild order"
                    maxHeight="max-h-48"
                    code={[...new Set(plan.cascade.rows.map((r) => r.wave))].map((w) => `Wave ${w + 1}: ${plan.cascade.rows.filter((r) => r.wave === w).map((r) => r.id).join(', ')}`).join('\n')}
                  />
                </>
              ) : null}
            </section>

            <section className={`${card} space-y-1`} aria-labelledby="fix-export">
              <h2 id="fix-export" className={h2}>
                5. Pipeline export
              </h2>
              <p className="text-sm text-ink-2">Next step: map each package to its Azure DevOps pipeline and export the order into TriggerAzureDevOpsPipelines.ps1. Waiting for the script template.</p>
            </section>
          </>
        ) : null}

        <details className={`${card} text-sm`}>
          <summary className="cursor-pointer font-medium">Inputs and scripts</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <a className={linkBtn} href="/scripts/Find-AssemblyReference.ps1" download>
                Find-AssemblyReference.ps1
              </a>{' '}
              (PowerShell 7): the REFERENCER scan of the failing folder. Paste its table above or load its CSV on the Inputs tab.
            </li>
            <li>
              <a className={linkBtn} href="/scripts/Export-PackageAssemblyMap.ps1" download>
                Export-PackageAssemblyMap.ps1
              </a>{' '}
              (PowerShell 7): which package version ships which AssemblyVersion, for Option 1. Load the JSON on the Inputs tab.
            </li>
            <li>project.assets.json files (Inputs tab) place packages in the cascade; deps.json and the assembly manifest add requesters, owning packages, and DLL-only assemblies.</li>
            <li>The Collect scripts tab has both scripts with examples, plus collectors for the other inputs.</li>
          </ul>
        </details>
      </div>
      {target ? <Todos target={target} /> : <div />}
    </div>
  );
}
