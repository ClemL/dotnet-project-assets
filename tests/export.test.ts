import { describe, expect, it } from 'vitest';
import { classifyAndOrder } from '../lib/analyze';
import { DEFAULT_SETTINGS } from '../lib/classify';
import { buildFileName, buildOrderCsv, csvCell, dependenciesCsv, formatTimestamp, jsonReport, markdownReport, sanitizeName, skewCsv } from '../lib/export';
import { DEFAULT_SKEW_SETTINGS } from '../lib/skew';
import { analyzeFixtures } from './helpers';

const when = new Date(2026, 9, 26, 14, 5);

describe('file names', () => {
  it('follows AssetsGraph_<Name>_yyyyMMdd_HHmm.<ext>', () => {
    expect(formatTimestamp(when)).toBe('20261026_1405');
    expect(buildFileName('Acme.Web', 'md', when)).toBe('AssetsGraph_Acme.Web_20261026_1405.md');
    expect(buildFileName('Merged', 'csv', when, 'BuildOrder')).toBe('AssetsGraph_Merged-BuildOrder_20261026_1405.csv');
    expect(sanitizeName('My Project [obj/x.json]')).toBe('My_Project_obj_x.json');
    expect(sanitizeName('  ')).toBe('Merged');
  });
});

describe('CSV', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('exports the dependency list and build order', () => {
    const a = analyzeFixtures('acme-web.assets.json');
    const { classification, buildOrders } = classifyAndOrder(
      a,
      { settings: { ...DEFAULT_SETTINGS, offline: true, internalPrefixes: ['Acme.'] }, lookups: {}, metadata: {}, overrides: {} },
      { includeProjects: true },
    );
    const deps = dependenciesCsv(a.merged.rows, classification).replace(/^\uFEFF/, '').split('\r\n');
    expect(deps[0]).toBe('Id,ResolvedVersions,Type,DirectTransitive,Origin,Reason,Projects,DirectIn');
    expect(deps).toContain('Acme.Core,1.0.0,package,Transitive,Private,internal prefix: Acme.,Acme.Web,');
    const order = buildOrderCsv(buildOrders.merged!, a.merged.graph, classification).replace(/^\uFEFF/, '').split('\r\n');
    expect(order.slice(0, 5)).toEqual([
      'Wave,Id,Origin,DependsOn,Status',
      '1,Acme.Core,Private,,ok',
      '1,Acme.Logging,Private,,ok',
      '2,Acme.Data,Project,Acme.Core,ok',
      '3,Acme.Web,Project,Acme.Core; Acme.Data; Acme.Logging,ok',
    ]);
  });
});

describe('reports', () => {
  it('writes a Markdown report with the cycle path', () => {
    const a = analyzeFixtures('cycle-alpha.assets.json', 'cycle-beta.assets.json');
    const settings = { ...DEFAULT_SETTINGS, offline: true, internalPrefixes: ['Acme.'] };
    const { classification, buildOrders } = classifyAndOrder(a, { settings, lookups: {}, metadata: {}, overrides: {} }, { includeProjects: true });
    const text = markdownReport({
      generatedAt: when,
      scope: a.merged,
      models: a.models,
      errors: [{ inputId: 'x', fileName: 'bad|name.json', message: 'Invalid JSON' }],
      classification,
      buildOrder: buildOrders.merged,
      settings,
      options: { ...a.options, includeProjects: true },
    });
    expect(text).toContain('# AssetsGraph report: Merged');
    expect(text).toContain('**Cycle detected; no complete build order exists.**');
    expect(text).toContain('- Acme.Alpha → Acme.Beta → Acme.Alpha');
    expect(text).toContain('**bad\\|name.json**');
  });

  it('writes a JSON report that round-trips', () => {
    const a = analyzeFixtures('diamond.assets.json');
    const parsed = JSON.parse(
      jsonReport({ generatedAt: when, scope: a.merged, models: a.models, errors: [], settings: DEFAULT_SETTINGS, options: { ...a.options, includeProjects: true } }),
    );
    expect(parsed.tool).toBe('assets-graph');
    expect(parsed.dependencies.map((d: { key: string }) => d.key)).toEqual(['lib.a', 'lib.b', 'lib.c', 'lib.d']);
    expect(parsed.graph.edges.length).toBe(5);
  });
});

describe('version skew export', () => {
  const a = analyzeFixtures('skew/rx-api.assets.json');
  const settings = { ...DEFAULT_SETTINGS, offline: true, internalPrefixes: ['Model.', 'Plugin.'] };
  const r = classifyAndOrder(a, { settings, lookups: {}, metadata: {}, overrides: {} }, { includeProjects: true }, { ...DEFAULT_SKEW_SETTINGS, includePublic: true });

  it('writes one CSV row per stale edge', () => {
    const lines = skewCsv(r.skew.merged!).replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('tfm,child,resolvedVersion,parent,parentVersion,requestedRange,requestedVersion,lag,severity,isDirect,isFloating,projects');
    expect(lines).toContain('net10.0,Model.Ref,10.0.0-13570,Model.PBM,10.0.0-13300,10.0.0-12986,10.0.0-12986,584,high,false,false,Rx.Api');
    expect(lines).toContain('net10.0,Microsoft.Data.SqlClient,7.1.1,Model.PBM,10.0.0-13300,6.1.1,6.1.1,n/a (semver),high,false,false,Rx.Api');
    // Internal: 2 Model.Ref + 1 Model.CQE + 3 Model.Import (the direct float is not stale).
    // Public: 2 SqlClient + the direct Polly [8.0.0, 9.0.0) that resolved to 8.5.0 (minor).
    expect(lines).toContain('net10.0,Polly,8.5.0,Rx.Api,1.0.0,"[8.0.0, 9.0.0)",8.0.0,n/a (semver),medium,true,false,Rx.Api');
    expect(lines.length - 1).toBe(9);
  });

  it('adds a Version skew section to the Markdown and JSON reports', () => {
    const input = {
      generatedAt: when,
      scope: a.merged,
      models: a.models,
      errors: [],
      classification: r.classification,
      buildOrder: r.buildOrders.merged,
      settings,
      options: { ...a.options, includeProjects: true },
      skew: r.skew.merged,
      floating: r.floating.merged,
      skewSettings: { ...DEFAULT_SKEW_SETTINGS, includePublic: true },
    };
    const text = markdownReport(input);
    for (const heading of ['## Version skew', '### Per-package skew (3)', '### Public and system packages (2)', '### Consumer staleness ranking (4)', '### Rebuild plan (4)', '### Floating and unpinned references (3 floating)']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('| net10.0 | Model.Import (10.0.0-13615) | 13388 → Model.CQE, Model.PBM; 13463 → Model.Landing; 13615 ← direct ref [10.0.*-*, ) | 227 | Model.CQE, Model.PBM | high |');
    expect(text).toContain('> **Outlier:** Model.PBM is the oldest requester in 2 packages');
    const json = JSON.parse(jsonReport(input));
    expect(json.versionSkew.skew.internal).toHaveLength(3);
    expect(json.versionSkew.floating.floatingCount).toBe(3);
  });

  it('keeps the timestamped file name pattern', () => {
    expect(buildFileName('Rx.Api', 'csv', when, 'VersionSkew')).toBe('AssetsGraph_Rx.Api-VersionSkew_20261026_1405.csv');
  });
});
