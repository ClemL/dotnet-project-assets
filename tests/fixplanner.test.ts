import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAndOrder, MERGED_SCOPE } from '../lib/analyze';
import { analyzeBindingInputs } from '../lib/binding';
import { parseBindingInput } from '../lib/bindingInputs';
import { DEFAULT_SETTINGS, isInternalOrigin } from '../lib/classify';
import {
  buildFixGraph,
  detectStamping,
  emptyObservations,
  nugetMinimum,
  observeManifest,
  observeScan,
  ownerResolver,
  parsePackageAssemblyMap,
  parseReferencerScan,
  planCascade,
  planPin,
  scanFromManifest,
  summarizeFailure,
} from '../lib/fixplanner';
import type { AssemblyManifest, IdKey } from '../lib/types';
import { analyzeFixtures } from './helpers';

const DIR = join(__dirname, 'fixtures', 'fixplanner');
const text = (name: string) => readFileSync(join(DIR, name), 'utf8');
const golden = () => parseReferencerScan(text('golden-scan.txt'))!;

const FAIL = ['Plugin.Azure.StorageAccount', 'Plugin.DataLoader', 'Plugin.Excel', 'Model.CQE.Landing.WellPartner', 'Model.CQE.Landing.Sentry', 'Model.CQE.Landing.Org'];

function manifest(): AssemblyManifest {
  const r = parseBindingInput({ inputId: 'm', fileName: 'fix-landing.manifest.json', text: text('fix-landing.manifest.json') });
  if (!r.ok || r.kind !== 'manifest') throw new Error('manifest expected');
  return r.manifest;
}

/** Classifies a fixture offline (the signature heuristic marks the unsigned internal packages). */
function classified(fixture: string) {
  const a = analyzeFixtures(fixture);
  const r = classifyAndOrder(a, { settings: { ...DEFAULT_SETTINGS, offline: true }, lookups: {}, metadata: {}, overrides: {} }, { includeProjects: false });
  const isInternal = (k: IdKey) => {
    const o = r.classification.byId[k]?.origin;
    return o !== undefined && isInternalOrigin(o);
  };
  return { a, r, isInternal, graph: a.merged.graph };
}

describe('referencer scan parsing', () => {
  it('parses the Format-Table paste, skipping blank lines and the ---- row', () => {
    const scan = golden();
    expect(scan.source).toBe('table');
    expect(scan.target).toBe('Model.Import');
    expect(scan.warnings).toEqual([]);
    expect(scan.rows).toHaveLength(9);
    expect(scan.rows[0]).toEqual({ kind: 'REFERENCER', dll: 'Plugin.Azure.StorageAccount.dll', assembly: 'Plugin.Azure.StorageAccount', version: '10.0.0.0', refersTo: '10.0.0.40512', path: undefined });
    expect(scan.rows[8]).toEqual({ kind: 'DEPLOYED', dll: 'Model.Import.dll', assembly: 'Model.Import', version: '10.0.0.19269', refersTo: undefined, path: undefined });
  });

  it('parses the Find-AssemblyReference.ps1 CSV, including a quoted path with a comma', () => {
    const scan = parseReferencerScan(text('golden-scan.csv'), 'scan.csv')!;
    expect(scan.source).toBe('csv');
    expect(scan.rows.map((r) => [r.kind, r.assembly, r.refersTo ?? ''])).toEqual(golden().rows.map((r) => [r.kind, r.assembly, r.refersTo ?? '']));
    expect(scan.rows[3]?.path).toBe('C:\\Apps\\Importer\\Landing, WellPartner\\Model.CQE.Landing.WellPartner.dll');
  });

  it('flags truncated Format-Table values and ignores text that is not a scan', () => {
    const scan = parseReferencerScan('Kind Dll Version RefersTo\nREFERENCER Model.CQE.Landing.Well… 10.0.0.0 10.0.0.34174\nDEPLOYED Model.Import.dll 10.0.0.19269')!;
    expect(scan.warnings.join(' ')).toContain('looks truncated');
    expect(parseReferencerScan('hello world')).toBeNull();
  });

  it('is detected as a binding input next to JSON inputs', () => {
    const r = analyzeBindingInputs([
      { inputId: 's', fileName: 'scan.txt', text: text('golden-scan.txt') },
      { inputId: 'p', fileName: 'PackageAssemblyMap.json', text: text('package-map.json') },
    ]);
    expect(r.inputs.map((i) => i.kind)).toEqual(['referencer', 'packageMap']);
    expect(r.scans[0]?.target).toBe('Model.Import');
    expect(r.packageMap).toHaveLength(8);
    expect(r.missing).toEqual(['deps', 'manifest']);
  });
});

describe('failure summary (golden)', () => {
  const summary = summarizeFailure({ target: 'Model.Import', rows: golden().rows, errorVersion: '10.0.0.34377' });

  it('requires the maximum referenced version', () => {
    expect(summary.requiredMinimum).toBe('10.0.0.40512');
    expect(summary.deployed).toEqual({ version: '10.0.0.19269', source: 'scan', others: [] });
  });

  it('fails six requesters and binds two exactly', () => {
    expect(summary.requesters.filter((r) => r.status === 'FAIL').map((r) => r.assembly).sort()).toEqual([...FAIL].sort());
    expect(summary.requesters.filter((r) => r.status === 'OK').map((r) => r.assembly).sort()).toEqual(['Model.CQE', 'Model.CQE.Landing.BILH']);
    expect([summary.failCount, summary.okCount]).toEqual([6, 2]);
  });

  it('reports the revision delta and orders the worst failure first', () => {
    expect(summary.requesters[0]).toMatchObject({ assembly: 'Plugin.Azure.StorageAccount', delta: 40512 - 19269 });
    expect(summary.requesters.find((r) => r.assembly === 'Model.CQE')?.delta).toBe(0);
    expect(summary.errorVersion).toBe('10.0.0.34377');
  });

  it('marks owners found by name in the assets graph', () => {
    const { graph } = classified('fixplanner/fix-app.assets.json');
    const s = summarizeFailure({ target: 'Model.Import', rows: golden().rows, owner: ownerResolver(null, graph) });
    expect(s.targetOwner).toEqual({ packageId: 'Model.Import', packageVersion: '10.0.0-13615', match: 'by name' });
    expect(s.requesters.find((r) => r.assembly === 'Plugin.Excel')?.owner).toMatchObject({ packageId: 'Plugin.Excel', match: 'by name' });
    expect(s.requesters.find((r) => r.assembly === 'Model.CQE.Landing.Org')?.owner).toBeUndefined();
  });
});

describe('AssemblyVersion stamping', () => {
  it('flags Model.Import and none of the assemblies seen only at 10.0.0.0', () => {
    const obs = emptyObservations();
    observeScan(obs, golden(), 'Model.Import');
    const report = detectStamping(obs);
    expect(report.stamped.map((s) => s.assembly)).toEqual(['Model.Import']);
    expect(report.stamped[0]).toMatchObject({ referencedVersions: 6, nonZeroRevision: true, maxRevision: 40512 });
    expect(report.stamped[0]?.versions[0]).toBe('10.0.0.19269');
    expect(report).toMatchObject({ mode: 'outlier', fixedBaseline: 8, baselineTotal: 9 });
  });

  it('reads manifest references too, and reports codebase-wide stamping', () => {
    const obs = emptyObservations();
    observeManifest(obs, manifest());
    expect(detectStamping(obs).stamped.map((s) => s.assembly)).toEqual(['Model.Import']);
    const wide = emptyObservations();
    for (const [name, versions] of [['A.Core', ['1.0.0.11', '1.0.0.12']], ['A.Data', ['1.0.0.40']], ['A.Web', ['1.0.0.0']]] as const) {
      wide.names.set(name.toLowerCase(), name);
      wide.referenced.set(name.toLowerCase(), new Set(versions));
    }
    expect(detectStamping(wide)).toMatchObject({ mode: 'codebase-wide', fixedBaseline: 1 });
  });
});

describe('option 1: pin', () => {
  const map = parsePackageAssemblyMap(JSON.parse(text('package-map.json')))!;
  const requesters = summarizeFailure({ target: 'Model.Import', rows: golden().rows }).requesters;
  const pin = (entries = map, requiredMinimum = '10.0.0.40512', min?: { version: string; requestedBy: string[] }) =>
    planPin({ packageId: 'Model.Import', assembly: 'Model.Import', requiredMinimum, map: entries, requesters, tfm: 'net10.0', nugetMinimum: min });

  it('recommends the only qualifying version', () => {
    const p = pin(map.filter((e) => ['10.0.0-13615', '10.0.0-13700', '10.0.0-13790'].includes(e.packageVersion)));
    expect(p.recommended?.packageVersion).toBe('10.0.0-13790');
    expect(p.snippet).toBe('<PackageReference Include="Model.Import" Version="[10.0.0-13790]" />');
  });

  it('picks the lowest qualifying package version, not the lowest assembly version', () => {
    const p = pin();
    expect(p.candidates.filter((c) => c.bindsAll).map((c) => c.packageVersion)).toEqual(['10.0.0-13760', '10.0.0-13790', '10.0.0-13850']);
    expect(p.recommended).toMatchObject({ packageVersion: '10.0.0-13760', assemblyVersion: '10.0.0.40600', tfm: 'net10.0' });
    // Everyone below 10.0.0.40600 rolls forward, including the requester at 40512.
    expect(p.rollForward.map((r) => r.assembly)).toContain('Plugin.Azure.StorageAccount');
    expect(p.rollForward).toHaveLength(8);
  });

  it('skips versions below the NuGet minimum (NU1605)', () => {
    const p = pin(map, '10.0.0.40512', { version: '10.0.0-13800', requestedBy: ['Plugin.Azure.StorageAccount'] });
    expect(p.recommended?.packageVersion).toBe('10.0.0-13850');
  });

  it('says so when none qualify, offers the feed search, and the cascade still plans', () => {
    const p = pin(map, '10.0.0.45000');
    expect(p.recommended).toBeUndefined();
    expect(p.noneReason).toBe('No cached Model.Import version ships assembly ≥ 10.0.0.45000 (highest: 10.0.0.41020).');
    expect(p.feedSearch).toBe(
      "dotnet package search Model.Import --source 'https://pkgs.dev.azure.com/inscriptrx/_packaging/org/nuget/v3/index.json' --prerelease --exact-match --format table",
    );
    const { graph, isInternal } = classified('fixplanner/fix-app.assets.json');
    expect(planCascade(buildFixGraph(graph, {}), 'model.import', isInternal).rows.length).toBeGreaterThan(0);
  });

  it('computes the NuGet minimum from package edges, not from the app being edited', () => {
    const { a } = classified('fixplanner/fix-app.assets.json');
    expect(nugetMinimum(a.models, 'model.import')).toEqual({ version: '10.0.0-13463', requestedBy: ['Plugin.Azure.StorageAccount'] });
  });
});

describe('option 2: rebuild cascade', () => {
  const { graph, isInternal } = classified('fixplanner/fix-app.assets.json');

  it('orders Model.Import and its internal consumers by global wave', () => {
    const plan = planCascade(buildFixGraph(graph, {}), 'model.import', isInternal, new Set(['plugin.excel']));
    expect(plan.rows.map((r) => [r.wave, r.id])).toEqual([
      [1, 'Model.Import'],
      [2, 'Model.CQE'],
      [2, 'Plugin.DataLoader'],
      [2, 'Plugin.Excel'],
      [3, 'Model.CQE.Report'],
      [3, 'Plugin.Azure.StorageAccount'],
      [4, 'Model.PBM'],
    ]);
    expect(plan.rows[0]?.reason).toEqual({ kind: 'target' });
    expect(plan.rows.find((r) => r.id === 'Plugin.Azure.StorageAccount')?.reason).toEqual({ kind: 'dependsOn', on: ['Model.Import', 'Plugin.DataLoader'] });
    expect(plan.rows.find((r) => r.id === 'Plugin.Excel')?.failRequester).toBe(true);
    expect(plan.rows.every((r) => r.placement === 'assets')).toBe(true);
  });

  it('places Landing assemblies from manifest references, after Model.CQE', () => {
    const fix = buildFixGraph(graph, { manifest: manifest() });
    expect([...fix.placed].sort()).toEqual(['model.cqe.landing.bilh', 'model.cqe.landing.sentry']);
    const plan = planCascade(fix, 'model.import', isInternal);
    const wave = (id: string) => plan.rows.find((r) => r.id === id)?.wave ?? -1;
    expect(wave('Model.CQE.Landing.Sentry')).toBe(wave('Model.CQE') + 1);
    expect(wave('Model.CQE.Landing.BILH')).toBe(wave('Model.CQE.Landing.Sentry') + 1);
    expect(plan.rows.find((r) => r.id === 'Model.CQE.Landing.Sentry')).toMatchObject({ placement: 'dll-references', reason: { kind: 'dependsOn', on: ['Model.CQE', 'Model.Import'] } });
  });

  it('places scan-only requesters right after the target', () => {
    const plan = planCascade(buildFixGraph(graph, { scans: [{ scan: golden(), target: 'Model.Import' }] }), 'model.import', isInternal);
    expect(plan.rows.filter((r) => r.placement === 'dll-references').map((r) => [r.wave, r.id])).toEqual([
      [2, 'Model.CQE.Landing.BILH'],
      [2, 'Model.CQE.Landing.Org'],
      [2, 'Model.CQE.Landing.Sentry'],
      [2, 'Model.CQE.Landing.WellPartner'],
    ]);
  });

  it('derives a scan from a manifest when no scan was pasted', () => {
    const scan = scanFromManifest(manifest(), 'Model.Import')!;
    const s = summarizeFailure({ target: 'Model.Import', rows: scan.rows });
    expect([s.requiredMinimum, s.failCount, s.okCount]).toEqual(['10.0.0.34377', 2, 2]);
  });

  it('shows cycles instead of an order', () => {
    const cyclic = {
      ...graph,
      edges: [...graph.edges, { from: 'model.import', to: 'model.cqe', usages: [] }],
    };
    const plan = planCascade(buildFixGraph(cyclic, {}), 'model.import', isInternal);
    expect(plan.rows).toEqual([]);
    expect(plan.cycles).toEqual([['model.cqe', 'model.import', 'model.cqe']]);
  });
});

// Golden: the real RxSense assets file at tests/fixtures/real/rxsense.assets.json (gitignored).
const REAL = join(__dirname, 'fixtures', 'real', 'rxsense.assets.json');

describe.runIf(existsSync(REAL))('golden: RxSense wave order', () => {
  const EXPECTED = [
    ['Feature.Helper', 'Feature.Build.Helper', 'Linql.Core', 'Linql.ModelGenerator.Core'],
    ['Feature.Config', 'Feature.Build.SQL', 'Linql.Server', 'Linql.ModelGenerator.CSharp.Backend'],
    ['Feature.DataAccess', 'Feature.WebApi', 'Plugin.Logging.Console'],
    ['DataLayer.Core'],
    ['DataLayer.Api', 'DataLayer.SQL'],
    ['DataLayer.SQL.EF', 'Plugin.BCP'],
    ['DataLayer.SQL.EF6'],
    ['Plugin.Update', 'Model.Export'],
    ['Plugin.Linql.Server', 'Plugin.AssemblyRegister', 'Plugin.DataEngine.Serverless', 'Plugin.SqlServer.Partition', 'Plugin.DataClassification'],
    ['Plugin.PM.PermissionsManagement', 'Plugin.SQL.CodeDeploy', 'Model.Binary'],
    ['Model.Import', 'Model.Drug', 'Model.SQL', 'Model.Ref'],
    ['Model.CQE', 'Plugin.DataLoader', 'Plugin.Excel'],
    ['Model.CQE.Report', 'Plugin.Azure.StorageAccount'],
    ['Model.PBM'],
    ['Model.Landing.RxSense'],
  ];
  const sorted = (waves: string[][]) => waves.map((w) => [...w].sort());

  it('builds the internal packages in the expected waves (classified by signature alone)', () => {
    const { r, graph } = classified('real/rxsense.assets.json');
    const view = r.buildOrders[MERGED_SCOPE]!;
    if (!view.order.ok) throw new Error('cycle');
    expect(sorted(view.order.waves.map((w) => w.map((k) => graph.nodes[k]?.spellings[0] ?? k)))).toEqual(sorted(EXPECTED));
  });

  it('cascades from Model.Import through waves 10-14', () => {
    const { graph, isInternal } = classified('real/rxsense.assets.json');
    const plan = planCascade(buildFixGraph(graph, {}), 'model.import', isInternal);
    const byWave = new Map<number, string[]>();
    for (const row of plan.rows) byWave.set(row.wave, [...(byWave.get(row.wave) ?? []), row.id]);
    expect([...byWave.entries()].map(([w, ids]) => [w, ids.sort()])).toEqual([
      [10, ['Model.Import']],
      [11, ['Model.CQE', 'Plugin.DataLoader', 'Plugin.Excel']],
      [12, ['Model.CQE.Report', 'Plugin.Azure.StorageAccount']],
      [13, ['Model.PBM']],
      [14, ['Model.Landing.RxSense']],
    ]);
  });

  it('classifies the 38 unsigned packages as internal and the 70 signed ones as public', () => {
    const { a, r } = classified('real/rxsense.assets.json');
    const pkgs = a.packages.filter((p) => !p.isRootProject);
    expect(pkgs.filter((p) => r.classification.byPackage[`${p.key}/${p.version.toLowerCase()}`]?.code === 'signature-unsigned')).toHaveLength(38);
    expect(pkgs.filter((p) => p.signed === true).length).toBe(70);
  });
});
