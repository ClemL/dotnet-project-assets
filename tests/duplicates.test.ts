import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYZE_OPTIONS } from '../lib/analyze';
import { findCaseCollisions, findCrossFileDrift, findRangeConflicts, findRedundantDirectRefs, findTfmDuplicates } from '../lib/duplicates';
import { analyzeFixtures, loadModels } from './helpers';

const opts = DEFAULT_ANALYZE_OPTIONS;

describe('range conflicts', () => {
  it('lists every parent and flags the range the resolved version breaks', () => {
    const [m] = loadModels('range-conflict.assets.json');
    const conflicts = findRangeConflicts(m!, opts);
    expect(conflicts).toEqual([
      {
        project: 'ConflictApp',
        target: 'net8.0',
        key: 'shared.core',
        id: 'Shared.Core',
        resolved: '2.1.0',
        hasConflict: true,
        parents: [
          { parent: 'Lib.A', parentVersion: '2.0.0', range: '[1.0.0, 2.0.0)', satisfied: false },
          { parent: 'Lib.B', parentVersion: '1.0.0', range: '2.1.0', satisfied: true },
        ],
      },
    ]);
  });

  it('records differing but satisfied ranges without flagging a conflict', () => {
    const [m] = loadModels('diamond.assets.json');
    const c = findRangeConflicts(m!, opts);
    expect(c.map((x) => [x.key, x.hasConflict])).toEqual([['lib.c', false]]);
  });
});

describe('redundant direct references', () => {
  it('finds direct refs also pulled in transitively, with the shortest path and pin detection', () => {
    const [m] = loadModels('redundant-direct.assets.json');
    const r = findRedundantDirectRefs(m!, opts);
    expect(r.map((x) => ({ id: x.id, via: x.via, likelyPin: x.likelyPin }))).toEqual([
      { id: 'Newtonsoft.Json', via: [['Some.Client', 'Newtonsoft.Json']], likelyPin: true },
      { id: 'Serilog', via: [['Serilog.AspNetCore', 'Serilog']], likelyPin: false },
    ]);
  });

  it('reports nothing for a diamond whose shared node is not direct', () => {
    const [m] = loadModels('diamond.assets.json');
    expect(findRedundantDirectRefs(m!, opts)).toEqual([]);
  });
});

describe('multi-TFM duplicates', () => {
  it('finds an Id resolved at different versions across target frameworks', () => {
    const [m] = loadModels('multi-tfm.assets.json');
    expect(findTfmDuplicates(m!, opts)).toEqual([
      {
        project: 'MultiLib',
        fileName: 'multi-tfm.assets.json',
        key: 'system.text.json',
        id: 'System.Text.Json',
        byTarget: [
          { target: '.NETCoreApp,Version=v8.0', version: '8.0.0' },
          { target: '.NETFramework,Version=v4.8', version: '6.0.0' },
        ],
      },
    ]);
  });

  it('ignores runtime-specific targets unless asked', () => {
    const [m] = loadModels('multi-tfm.assets.json');
    const withRid = findTfmDuplicates(m!, { includeRidTargets: true });
    expect(withRid[0]?.byTarget.map((t) => t.target)).toContain('.NETCoreApp,Version=v8.0/win-x64');
    const a = analyzeFixtures('multi-tfm.assets.json');
    expect(a.merged.rows.some((r) => r.key === 'runtime.win-x64.contoso.native')).toBe(false);
  });
});

describe('cross-file version drift', () => {
  it('groups projects by the version they resolve', () => {
    const models = loadModels('drift-billing.assets.json', 'drift-claims.assets.json', 'drift-pharmacy.assets.json');
    expect(findCrossFileDrift(models, opts)).toEqual([
      {
        key: 'newtonsoft.json',
        id: 'Newtonsoft.Json',
        versions: [
          { version: '13.0.1', projects: [{ project: 'Billing.Api', tfms: ['net8.0'] }] },
          {
            version: '13.0.3',
            projects: [
              { project: 'Claims.Api', tfms: ['net8.0'] },
              { project: 'Pharmacy.Worker', tfms: ['net8.0'] },
            ],
          },
        ],
      },
    ]);
  });

  it('does not treat multi-TFM differences inside one project as drift', () => {
    expect(findCrossFileDrift(loadModels('multi-tfm.assets.json'), opts)).toEqual([]);
  });
});

describe('case-only Id collisions', () => {
  it('reports Ids that differ only by case and merges them into one node', () => {
    const models = loadModels('case-a.assets.json', 'case-b.assets.json');
    expect(findCaseCollisions(models, opts)).toEqual([
      {
        key: 'acme.utils',
        spellings: [
          { id: 'Acme.Utils', projects: ['Reports.Web'] },
          { id: 'acme.utils', projects: ['Reports.Jobs'] },
        ],
      },
    ]);
    const a = analyzeFixtures('case-a.assets.json', 'case-b.assets.json');
    const row = a.merged.rows.find((r) => r.key === 'acme.utils');
    expect(row?.versions).toEqual(['1.0.0', '1.2.0']);
    expect(row?.projects).toEqual(['Reports.Jobs', 'Reports.Web']);
    expect(a.merged.duplicates.drift.map((d) => d.key)).toEqual(['acme.utils']);
  });
});
