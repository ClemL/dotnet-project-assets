import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAndOrder, MERGED_SCOPE } from '../lib/analyze';
import { DEFAULT_SETTINGS } from '../lib/classify';
import { readRestoreFlags } from '../lib/parse';
import { collectSkewEdges, DEFAULT_SKEW_SETTINGS } from '../lib/skew';
import type { ClassifySettings, SkewRow, SkewSettings } from '../lib/types';
import { DEFAULT_BUILD_PATTERN } from '../lib/versions';
import { analyzeFixtures } from './helpers';

const offline = (internalPrefixes: string[]): ClassifySettings => ({ ...DEFAULT_SETTINGS, offline: true, internalPrefixes });

function run(fixtures: string[], prefixes: string[], skew: Partial<SkewSettings> = {}) {
  const a = analyzeFixtures(...fixtures);
  const r = classifyAndOrder(a, { settings: offline(prefixes), lookups: {}, metadata: {}, overrides: {} }, { includeProjects: true }, { ...DEFAULT_SKEW_SETTINGS, ...skew });
  return { analysis: a, skew: r.skew[MERGED_SCOPE]!, floating: r.floating[MERGED_SCOPE]! };
}

const row = (rows: SkewRow[], child: string) => {
  const found = rows.find((r) => r.child === child);
  if (!found) throw new Error(`no row for ${child}`);
  return found;
};

describe('skew table', () => {
  const { skew } = run(['skew/rx-api.assets.json'], ['Model.', 'Plugin.']);

  it('lists internal children with stale edges, sorted by spread', () => {
    expect(skew.internal.map((r) => [r.child, r.resolvedVersion, r.oldestRequested, r.spread, r.severity])).toEqual([
      ['Model.Ref', '10.0.0-13570', '10.0.0-12986', 584, 'high'],
      ['Model.CQE', '10.0.0-13404', '10.0.0-13094', 310, 'high'],
      ['Model.Import', '10.0.0-13615', '10.0.0-13388', 227, 'high'],
    ]);
    expect(skew.counts).toEqual({ high: 3, medium: 0, low: 0 });
  });

  it('groups requesters by requested version and shows the direct floating reference', () => {
    const imp = row(skew.internal, 'Model.Import');
    expect(imp.groups.map((g) => [g.build, g.requesters.map((r) => (r.isDirect ? `direct ${r.range}` : r.parent))])).toEqual([
      [13388, ['Model.CQE', 'Model.PBM']],
      [13463, ['Model.Landing']],
      [13615, ['direct [10.0.*-*, )']],
    ]);
    expect(imp.oldestRequesters).toEqual(['Model.CQE', 'Model.PBM']);
    expect(imp.edges.find((e) => e.isDirect)).toMatchObject({ stale: false, isFloating: true, requestedRange: '[10.0.*-*, )', requestedVersion: '10.0.0-13615', lag: 0 });
  });

  it('matches Ids case-insensitively and reports casing variants', () => {
    // Model.CQE asks for "Model.Pbm"; it resolves to the same node as Rx.Api's "Model.PBM".
    const models = analyzeFixtures('skew/rx-api.assets.json').models;
    const { edges } = collectSkewEdges(models, () => 'Private', new RegExp(DEFAULT_BUILD_PATTERN), DEFAULT_SKEW_SETTINGS.thresholds);
    const toPbm = edges.filter((e) => e.childKey === 'model.pbm').map((e) => [e.parent, e.child, e.resolvedVersion, e.requestedRange]);
    expect(toPbm).toEqual([
      ['Model.CQE', 'Model.PBM', '10.0.0-13300', '10.0.0-13300'],
      ['Rx.Api', 'Model.PBM', '10.0.0-13300', '[10.0.0-13300, )'],
    ]);
    expect(skew.internal.some((r) => r.childKey === 'model.pbm')).toBe(false);
    expect(skew.casing).toEqual([
      {
        key: 'model.pbm',
        display: 'Model.PBM',
        variants: [
          { spelling: 'Model.PBM', seenIn: ['resolved', 'Rx.Api'] },
          { spelling: 'Model.Pbm', seenIn: ['Model.CQE'] },
        ],
      },
    ]);
  });

  it('keeps public packages out unless the toggle is on, then uses SemVer distance', () => {
    expect(skew.public).toEqual([]);
    const { skew: withPublic } = run(['skew/rx-api.assets.json'], ['Model.', 'Plugin.'], { includePublic: true });
    const sql = row(withPublic.public, 'Microsoft.Data.SqlClient');
    expect([sql.resolvedVersion, sql.spread, sql.spreadDiff, sql.severity]).toEqual(['7.1.1', null, 'major', 'high']);
    expect(sql.groups.map((g) => [g.requestedVersion, g.requesters.map((r) => r.parent)])).toEqual([
      ['6.1.1', ['Model.PBM']],
      ['6.1.4', ['Microsoft.EntityFrameworkCore.SqlServer']],
    ]);
  });
});

describe('consumer ranking', () => {
  const { skew } = run(['skew/rx-api.assets.json'], ['Model.', 'Plugin.']);

  it('ranks by oldest-in-row count, then max lag', () => {
    expect(skew.consumers.map((c) => [c.parent, c.staleEdges, c.oldestInRow, c.maxLag, c.medianLag])).toEqual([
      ['Model.PBM', 2, 2, 584, 405.5],
      ['Model.Landing', 2, 1, 310, 231],
      ['Model.CQE', 1, 1, 227, 227],
      ['Model.Import', 1, 0, 10, 10],
    ]);
    expect(skew.consumers[0]?.action).toBe('Rebuild against Model.Ref 10.0.0-13570 (+584), Model.Import 10.0.0-13615 (+227), then republish Model.PBM.');
    expect(skew.consumers[3]?.action).toBe('Monitor: every stale edge is below the medium threshold.');
  });

  it('calls out the outlier', () => {
    expect(skew.outlier?.message).toBe(
      'Model.PBM is the oldest requester in 2 packages; compiled against a stack up to 584 builds older than what ships. Most likely source of runtime binding failures (MissingMethodException / TypeLoadException).',
    );
  });
});

describe('rebuild plan', () => {
  it('orders stale parents and their consumers in waves', () => {
    const { skew } = run(['skew/rx-api.assets.json'], ['Model.', 'Plugin.']);
    expect(skew.rebuild.steps.map((s) => [s.wave, s.id, s.reason])).toEqual([
      [1, 'Model.PBM', 'stale'],
      [2, 'Model.CQE', 'stale'],
      [3, 'Model.Landing', 'stale'],
      [4, 'Rx.Api', 'cascade'],
    ]);
  });

  it('pulls the consumers of a rebuilt mid-graph package in, in topological order', () => {
    const { skew } = run(['skew/cascade.assets.json'], ['Acme.']);
    expect(skew.internal.map((r) => [r.child, r.spread, r.severity])).toEqual([['Acme.Core', 100, 'medium']]);
    expect(skew.rebuild.steps.map((s) => [s.wave, s.id, s.reason, s.because])).toEqual([
      [1, 'Acme.Mid', 'stale', ['Acme.Core 1.0.0-100 → 1.0.0-200']],
      [2, 'Acme.Top', 'cascade', ['Acme.Mid']],
      [3, 'Acme.App', 'cascade', ['Acme.Top']],
    ]);
  });

  it('can turn the cascade off and raise the minimum severity', () => {
    expect(run(['skew/cascade.assets.json'], ['Acme.'], { cascade: false }).skew.rebuild.steps.map((s) => s.id)).toEqual(['Acme.Mid']);
    expect(run(['skew/cascade.assets.json'], ['Acme.'], { rebuildMinSeverity: 'high' }).skew.rebuild.steps).toEqual([]);
    expect(run(['skew/cascade.assets.json'], ['Acme.'], { thresholds: { low: 1, medium: 50, high: 100 } }).skew.internal[0]?.severity).toBe('high');
  });
});

describe('floating references', () => {
  it('classifies all four categories and links floats to older consumers', () => {
    const { floating } = run(['skew/rx-api.assets.json'], ['Model.', 'Plugin.']);
    const kind = (id: string) => floating.refs.find((r) => r.id === id)?.kind;
    expect(kind('Model.Import')).toBe('floatingPrerelease');
    expect(kind('Serilog')).toBe('floatingStable');
    expect(kind('Model.PBM')).toBe('openEnded');
    expect(kind('Dapper')).toBe('pinned');
    expect(kind('Polly')).toBe('bounded');
    expect(floating.floatingCount).toBe(3);
    const imp = floating.refs.find((r) => r.id === 'Model.Import');
    expect(imp?.note).toBe('Model.Import floated to 13615 while consumers expect 13388–13463.');
    expect(imp?.olderConsumers).toMatchObject({ parents: ['Model.CQE', 'Model.Landing', 'Model.PBM'], rowId: 'net10.0|model.import|10.0.0-13615' });
    expect(floating.restore[0]?.flags).toMatchObject({ lockFile: 'unknown', cpm: 'unknown', cpmEvidence: 'none' });
    expect(floating.recommend).toBe(true);
    expect(floating.snippets.cpm).toContain('<PackageVersion Include="Model.Import" Version="10.0.0-13615" />');
  });

  it('reads the lock-file flag NuGet writes as a string (real SDK 10 restore)', () => {
    const { floating } = run(['skew/sdk10-lockfile-floats.assets.json'], []);
    expect(floating.restore[0]?.flags).toMatchObject({ lockFile: 'enabled', lockedMode: 'unknown', cpm: 'unknown' });
    expect(Object.fromEntries(floating.refs.map((r) => [r.id, r.kind]))).toEqual({
      'Newtonsoft.Json': 'floatingStable',
      Serilog: 'floatingPrerelease',
      Dapper: 'pinned',
      Polly: 'bounded',
    });
    expect(floating.recommend).toBe(false);
  });

  it('reads Central Package Management and versionCentrallyManaged (real SDK 10 restore)', () => {
    const { floating } = run(['skew/sdk10-cpm.assets.json'], []);
    expect(floating.restore[0]?.flags).toMatchObject({ cpm: 'enabled', cpmEvidence: 'restore', transitivePinning: 'enabled', lockFile: 'unknown' });
    const byId = Object.fromEntries(floating.refs.map((r) => [r.id, r]));
    expect(byId['Newtonsoft.Json']).toMatchObject({ kind: 'pinned', centrallyManaged: true });
    expect(byId['Dapper']).toMatchObject({ kind: 'openEnded', versionOverride: '[2.1.28, )' });
  });

  it('reports absent restore properties as unknown, not disabled', () => {
    expect(readRestoreFlags(undefined, [], {})).toEqual({ lockFile: 'unknown', lockedMode: 'unknown', lockFilePath: undefined, cpm: 'unknown', cpmEvidence: 'none', transitivePinning: 'unknown' });
    expect(readRestoreFlags({ restoreLockProperties: { restorePackagesWithLockFile: 'false' } }, [], {}).lockFile).toBe('disabled');
    expect(readRestoreFlags({}, [{ id: 'A', range: '[1.0.0, )', centrallyManaged: true, autoReferenced: false }], {})).toMatchObject({ cpm: 'enabled', cpmEvidence: 'dependency' });
  });
});

describe('multi-file mode', () => {
  it('shows which projects ship each version and flags cross-project drift', () => {
    const { skew } = run(['skew/rx-api.assets.json', 'skew/cascade.assets.json'], ['Model.', 'Plugin.', 'Acme.']);
    expect(row(skew.internal, 'Model.Import').shippedBy).toEqual(['Rx.Api']);
    expect(row(skew.internal, 'Acme.Core').shippedBy).toEqual(['Acme.App']);
    expect(skew.internal.every((r) => r.drift.length === 0)).toBe(true);
  });
});

// Golden test: drop the real file at tests/fixtures/real/rxsense.assets.json (gitignored).
const GOLDEN = join(__dirname, 'fixtures', 'real', 'rxsense.assets.json');

describe.runIf(existsSync(GOLDEN))('golden: rxsense.assets.json (net10.0)', () => {
  // The describe body runs even when skipped, so the analysis is computed lazily inside the tests.
  let cached: ReturnType<typeof run> | undefined;
  const golden = () => (cached ??= run(['real/rxsense.assets.json'], ['Model.', 'Plugin.'], { includePublic: true }));
  const build = (r: SkewRow) => [r.resolvedBuild, r.spread];

  it('matches the expected skew rows', () => {
    const net10 = golden().skew.internal.filter((r) => r.tfm === 'net10.0');
    const linql = row(net10, 'Plugin.Linql.Server');
    expect(build(linql)).toEqual([13511, 493]);
    expect(linql.groups[0]?.build).toBe(13018);
    expect(linql.oldestRequesters).toEqual(['Model.PBM']);
    expect(build(row(net10, 'Model.Ref'))).toEqual([13570, 584]);
    expect(row(net10, 'Model.Ref').oldestRequesters).toEqual(['Model.PBM']);
    const imp = row(net10, 'Model.Import');
    expect(build(imp)).toEqual([13615, 227]);
    expect(imp.groups.find((g) => g.build === 13388)?.requesters.map((r) => r.parent).sort()).toEqual(['Model.CQE', 'Plugin.DataLoader', 'Plugin.Excel']);
    expect(imp.groups.find((g) => g.build === 13463)?.requesters.map((r) => r.parent).sort()).toEqual(['Model.Landing.RxSense', 'Plugin.Azure.StorageAccount']);
    expect(imp.edges.find((e) => e.isDirect)?.requestedRange).toBe('[10.0.*-*, )');
    expect(build(row(net10, 'Model.CQE'))).toEqual([13404, 310]);
    expect(build(row(net10, 'Model.CQE.Report'))).toEqual([13314, 298]);
    expect(build(row(net10, 'Model.Drug'))).toEqual([13366, 351]);
    expect(build(row(net10, 'Plugin.SQL.CodeDeploy'))).toEqual([13426, 179]);
    expect(build(row(net10, 'Plugin.BCP'))).toEqual([13423, 155]);
    expect(build(row(net10, 'Plugin.Update'))).toEqual([13244, 244]);
  });

  it('ranks Model.PBM first', () => {
    const { consumers } = golden().skew;
    expect([consumers[0]?.parent, consumers[0]?.oldestInRow]).toEqual(['Model.PBM', 6]);
  });

  it('finds the five floating direct references', () => {
    const floats = golden().floating.refs.filter((r) => r.target === 'net10.0' && (r.kind === 'floatingPrerelease' || r.kind === 'floatingStable'));
    expect(floats.map((r) => r.id).sort()).toEqual(['Model.Import', 'Model.Landing.RxSense', 'Plugin.Azure.StorageAccount', 'Plugin.BCP', 'Plugin.Logging.Console']);
  });

  it('flags Microsoft.Data.SqlClient as a major jump', () => {
    const sql = row(golden().skew.public.filter((r) => r.tfm === 'net10.0'), 'Microsoft.Data.SqlClient');
    expect(sql.resolvedVersion).toBe('7.1.1');
    expect(sql.spreadDiff).toBe('major');
    expect(sql.severity).toBe('high');
    expect(sql.groups.map((g) => g.requestedVersion)).toEqual(expect.arrayContaining(['6.1.1', '6.1.4', '6.1.7']));
  });
});
