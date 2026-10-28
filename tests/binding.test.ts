import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeBinding,
  buildCorrelation,
  classifyReference,
  compareAssemblyVersions,
  lookupLoadError,
  NO_REQUESTER_VERDICT,
  parseAssemblyVersion,
  parseLoadErrors,
} from '../lib/binding';
import { detectBindingInput, parseBindingInput, ridRank } from '../lib/bindingInputs';
import type { AssemblyManifest, BindingInputSummary, BindingIssue, BindingResult, DepsModel, RuntimeConfigInfo } from '../lib/types';

const DIR = join(__dirname, 'fixtures', 'binding');

function load(paths: string[]): BindingResult {
  const deps: DepsModel[] = [];
  const manifests: AssemblyManifest[] = [];
  const runtimeConfigs: RuntimeConfigInfo[] = [];
  const inputs: BindingInputSummary[] = [];
  for (const path of paths) {
    const fileName = path.replace(/^.*[\\/]/, '');
    const r = parseBindingInput({ inputId: fileName, fileName, text: readFileSync(path, 'utf8') });
    if (!r.ok) throw new Error(`${fileName}: ${r.error}`);
    inputs.push({ inputId: fileName, fileName, kind: r.kind });
    if (r.kind === 'deps') deps.push(r.deps);
    else if (r.kind === 'manifest') manifests.push(r.manifest);
    else if (r.kind === 'runtimeconfig') runtimeConfigs.push(r.runtimeConfig);
  }
  return analyzeBinding({ inputs, deps, manifests, runtimeConfigs });
}

const fixture = (...names: string[]) => load(names.map((n) => join(DIR, n)));

function issue(result: BindingResult, requester: string, reference: string): BindingIssue {
  const found = result.issues.find((i) => i.requester.name === requester && i.reference.name === reference);
  if (!found) throw new Error(`no issue ${requester} → ${reference}`);
  return found;
}

describe('assembly versions', () => {
  it('parses and compares four-part versions numerically', () => {
    const v = (s: string) => parseAssemblyVersion(s)!;
    expect(v('10.0.0.34377').parts).toEqual([10, 0, 0, 34377]);
    expect(v('1.2').parts).toEqual([1, 2, 0, 0]);
    expect(compareAssemblyVersions(v('10.0.0.33950'), v('10.0.0.34377'))).toBe(-1);
    expect(compareAssemblyVersions(v('10.0.0.9'), v('10.0.0.10'))).toBe(-1);
    expect(parseAssemblyVersion('10.0.0-13615')).toBeNull();
    expect(parseAssemblyVersion('1.0.0.70000')).toBeNull();
  });
});

describe('classification', () => {
  const r = fixture('classes.deps.json', 'classes.manifest.json');

  it('assigns one category per reference', () => {
    expect(issue(r, 'Rx.Api', 'Model.Missing').classification).toBe('MISSING');
    expect(issue(r, 'Plugin.Excel', 'Model.Import').classification).toBe('TOO_OLD');
    expect(issue(r, 'Rx.Api', 'Signed.Lib').classification).toBe('TOKEN_MISMATCH');
    expect(issue(r, 'Rx.Api', 'Major.Lib').classification).toBe('ROLL_FORWARD_MAJOR');
    expect(issue(r, 'Rx.Api', 'Minor.Lib').classification).toBe('ROLL_FORWARD');
    expect(issue(r, 'Rx.Api', 'Model.Import').classification).toBe('EXACT');
  });

  it('maps categories to severities (token mismatch binds on .NET, so it is a warning)', () => {
    expect(issue(r, 'Rx.Api', 'Model.Missing').severity).toBe('error');
    expect(issue(r, 'Plugin.Excel', 'Model.Import').severity).toBe('error');
    expect(issue(r, 'Rx.Api', 'Signed.Lib').severity).toBe('warning');
    expect(issue(r, 'Rx.Api', 'Major.Lib').severity).toBe('warning');
    expect(issue(r, 'Rx.Api', 'Minor.Lib').severity).toBe('info');
    expect(issue(r, 'Rx.Api', 'Model.Import').severity).toBe('ok');
    expect(r.counts).toEqual({ error: 5, warning: 2, info: 3, ok: 3 });
  });

  it('applies the documented precedence', () => {
    const t = { name: 'X', publicKeyToken: 'bbbbbbbbbbbbbbbb', source: 'manifest' as const };
    const ref = { name: 'X', version: '2.0.0.0', publicKeyToken: 'aaaaaaaaaaaaaaaa' };
    expect(classifyReference(ref, { ...t, version: '1.0.0.0' }, false)).toBe('TOO_OLD');
    expect(classifyReference(ref, { ...t, version: '3.0.0.0' }, false)).toBe('TOKEN_MISMATCH');
    expect(classifyReference({ ...ref, publicKeyToken: null }, { ...t, version: '3.0.0.0' }, true)).toBe('ROLL_FORWARD');
  });

  it('writes the package-correlation hint for TOO_OLD', () => {
    expect(issue(r, 'Plugin.Excel', 'Model.Import').hint).toBe(
      'Plugin.Excel (package 10.0.0-13406) was compiled against Model.Import assembly 10.0.0.34377; the deployed Model.Import package 10.0.0-13615 ships assembly 10.0.0.33950. ' +
        'Either Plugin.Excel was built against a newer Model.Import than any published package, or this deployment is missing a newer Model.Import.',
    );
    const dynamic = issue(r, 'Plugin.Dynamic', 'Model.Import');
    expect(dynamic.classification).toBe('TOO_OLD');
    expect(dynamic.requesterPackage).toBeUndefined();
    expect(dynamic.hint).toContain('Plugin.Dynamic (outside deps.json)');
    expect(dynamic.notes.join(' ')).toContain('resolved from the app folder');
  });

  it('treats a bin DLL that deps.json does not list as missing', () => {
    const orphan = issue(r, 'Rx.Api', 'Orphan.Lib');
    expect(orphan.classification).toBe('MISSING');
    expect(orphan.hint).toContain('not listed in classes.deps.json');
  });

  it('lets a plugin folder resolve its own copy first and reports multiple copies', () => {
    expect(issue(r, 'Plugin.Dynamic', 'Shared.Util').classification).toBe('EXACT');
    expect(r.copies.map((c) => [c.name, c.copies.map((x) => `${x.root}:${x.version}`)])).toEqual([['Shared.Util', ['0:1.0.0.0', '1:1.2.0.0']]]);
  });

  it('skips satellite resource assemblies', () => {
    expect(r.issues.some((i) => i.requester.name === 'Rx.Api.resources')).toBe(false);
  });
});

describe('framework references', () => {
  const r = fixture('classes.deps.json', 'classes.manifest.json');

  it('resolves through framework[] and rolls forward across majors without a warning', () => {
    const rt = issue(r, 'Model.Import', 'System.Runtime');
    expect(rt.target).toMatchObject({ source: 'framework', version: '10.0.0.0', framework: 'Microsoft.NETCore.App' });
    expect(rt.classification).toBe('ROLL_FORWARD');
    expect(rt.isFramework).toBe(true);
  });

  it('lets the higher framework copy win over an older app-local copy', () => {
    const stj = issue(r, 'Rx.Api', 'System.Text.Json');
    expect(stj.target?.source).toBe('framework');
    expect(stj.notes.join(' ')).toContain("shared framework's 10.0.0.0 wins");
  });

  it('does not let the name heuristic hide a missing Microsoft.* package when a framework list exists', () => {
    expect(issue(r, 'Rx.Api', 'Microsoft.Data.SqlClient').classification).toBe('MISSING');
  });

  it('falls back to the name heuristic without a framework list', () => {
    const h = fixture('classes.deps.json', 'heuristic.manifest.json');
    expect(issue(h, 'Rx.Api', 'System.Text.Json').classification).toBe('FRAMEWORK_ASSUMED');
    expect(issue(h, 'Rx.Api', 'System.Text.Json').target?.source).toBe('framework-assumed');
    expect(issue(h, 'Rx.Api', 'netstandard').classification).toBe('FRAMEWORK_ASSUMED');
    expect(issue(h, 'Rx.Api', 'Contoso.Missing').classification).toBe('MISSING');
  });
});

describe('deps.json', () => {
  it('detects input kinds', () => {
    expect(detectBindingInput({ schema: 1, assemblies: [] })).toBe('manifest');
    expect(detectBindingInput({ runtimeOptions: {} })).toBe('runtimeconfig');
    expect(detectBindingInput({ runtimeTarget: { name: 'x' }, targets: {}, libraries: {} })).toBe('deps');
    expect(detectBindingInput({ version: 3, targets: {}, libraries: {}, project: {} })).toBeNull();
  });

  it('maps multiple runtime DLLs, runtimes/win assets, and missing assemblyVersion', () => {
    const r = parseBindingInput({ inputId: 'm', fileName: 'multi-asset.deps.json', text: readFileSync(join(DIR, 'multi-asset.deps.json'), 'utf8') });
    if (!r.ok || r.kind !== 'deps') throw new Error('expected deps');
    const d = r.deps;
    expect(d.runtimeTarget).toBe('.NETCoreApp,Version=v10.0');
    expect(d.appId).toBe('Host.App');
    // Plain runtime assets plus the unix and win runtimeTargets; native and resource assets are ignored.
    expect(d.byPackage['vendor.suite/4.2.0']?.map((a) => `${a.assemblyName}@${a.rid ?? '-'}`)).toEqual([
      'Vendor.Suite.Core@-',
      'Vendor.Suite.Reports@-',
      'Vendor.Suite.Native.Shim@-',
      'Vendor.Suite.Native.Shim@unix',
      'Vendor.Suite.Native.Shim@win',
    ]);
    expect(d.byAssembly['vendor.suite.native.shim']).toEqual([expect.objectContaining({ rid: 'win', fileVersion: '4.2.17.2', packageId: 'Vendor.Suite', packageVersion: '4.2.0' })]);
    expect(d.byAssembly['vendor.suite.reports']?.[0]?.assemblyVersion).toBeNull();
    expect(d.gaps).toEqual([
      expect.objectContaining({ packageId: 'Host.App', expected: true }),
      expect.objectContaining({ packageId: 'Vendor.Suite', path: 'lib/net8.0/Vendor.Suite.Reports.dll', expected: false }),
    ]);
    expect(d.warnings.join(' ')).toContain('1 runtime asset has no assemblyVersion');
    expect(ridRank('win-x64')).toBeGreaterThan(ridRank('win'));
    expect(ridRank('linux-x64')).toBeLessThan(0);
  });

  it('reads a real SDK 10 deps.json, runtimeconfig.json, and script manifest', () => {
    const r = fixture('sdk10-app.deps.json', 'sdk10-app.manifest.json', 'sdk10-app.runtimeconfig.json');
    expect(r.missing).toEqual([]);
    expect(r.deps[0]?.primary).toBe(true);
    expect(r.runtimeConfig?.frameworks).toEqual([{ name: 'Microsoft.NETCore.App', version: '10.0.0' }]);
    // Project references carry assemblyVersion; only the app's own entry does not.
    expect(r.deps[0]?.byAssembly.lib?.[0]?.assemblyVersion).toBe('2.0.0.0');
    expect(r.deps[0]?.gaps).toEqual([expect.objectContaining({ packageId: 'App', expected: true })]);
    expect(issue(r, 'App', 'Lib')).toMatchObject({ classification: 'EXACT', requesterPackage: expect.objectContaining({ packageType: 'project' }) });
    const eventLog = r.issues.find((i) => i.requester.path.startsWith('runtimes/win/') && i.reference.name === 'System.Runtime');
    expect(eventLog).toMatchObject({ classification: 'ROLL_FORWARD', requesterPackage: { packageId: 'System.Diagnostics.EventLog', packageVersion: '8.0.0' } });
    expect(r.counts.error).toBe(0);
    expect(r.copies.map((c) => c.name)).toEqual(['Lib']);
  });
});

describe('error lookup', () => {
  it('parses the FileNotFoundException message', () => {
    const msg = "Could not load file or assembly 'Model.Import, Version=10.0.0.34377, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.";
    expect(parseLoadErrors(msg)).toEqual([
      { raw: "'Model.Import, Version=10.0.0.34377, Culture=neutral, PublicKeyToken=null'", exception: undefined, name: 'Model.Import', version: '10.0.0.34377', culture: 'neutral', publicKeyToken: null },
    ]);
  });

  it('parses a FileLoadException with a token and ignores type names', () => {
    const msg =
      "System.IO.FileLoadException: Could not load file or assembly 'Newtonsoft.Json, Version=13.0.0.0, Culture=neutral, PublicKeyToken=30ad4fe6b2a6aeed'. The located assembly's manifest definition does not match the assembly reference. (0x80131040)\n" +
      "System.TypeLoadException: Could not load type 'Model.Import.Mapper' from assembly 'Model.Import, Version=10.0.0.33950, Culture=neutral, PublicKeyToken=null'.";
    const parsed = parseLoadErrors(msg);
    expect(parsed.map((p) => [p.exception, p.name, p.version, p.publicKeyToken])).toEqual([
      ['FileLoadException', 'Newtonsoft.Json', '13.0.0.0', '30ad4fe6b2a6aeed'],
      ['TypeLoadException', 'Model.Import', '10.0.0.33950', null],
    ]);
  });

  it('finds every requester of the exact name and version', () => {
    const r = fixture('classes.deps.json', 'classes.manifest.json');
    const [err] = parseLoadErrors("Could not load file or assembly 'model.import, Version=10.0.0.34377, Culture=neutral, PublicKeyToken=null'.");
    const result = lookupLoadError(r, err!);
    expect(result.requesters.map((i) => i.requester.name).sort()).toEqual(['Plugin.Dynamic', 'Plugin.Excel']);
    expect(result.otherVersions).toEqual([{ version: '10.0.0.33950', requesters: ['Rx.Api'] }]);
    expect(result.deployed.copies.map((c) => c.version)).toEqual(['10.0.0.33950']);
    expect(result.deployed.owners.map((o) => o.packageVersion)).toEqual(['10.0.0-13615']);
    expect(result.verdict).toContain('this explains the exception');
  });

  it('reports when no provided input references the assembly', () => {
    const r = fixture('classes.deps.json', 'classes.manifest.json');
    const result = lookupLoadError(r, { raw: '', name: 'Plugin.Unknown', version: '1.0.0.0' });
    expect(result.requesters).toEqual([]);
    expect(result.verdict).toBe(NO_REQUESTER_VERDICT);
  });
});

describe('version correlation', () => {
  it('flags pairs where a higher package version ships a lower assembly version', () => {
    const r = fixture('classes.deps.json', 'classes.manifest.json');
    const rows = buildCorrelation(r.deps, (key) => key.startsWith('model.') || key.startsWith('plugin.'));
    expect(rows.map((x) => [x.packageId, x.packageVersion, x.assemblyVersion, x.nonMonotonic])).toEqual([
      ['Model.Drug', '10.0.0-13366', '10.0.0.33000', false],
      ['Plugin.Excel', '10.0.0-13406', '10.0.0.34012', true],
      ['Model.Ref', '10.0.0-13570', '10.0.0.34100', true],
      ['Model.Import', '10.0.0-13615', '10.0.0.33950', true],
    ]);
    expect(rows[3]?.conflictsWith.map((c) => c.packageId)).toEqual(['Plugin.Excel', 'Model.Ref']);
  });
});

// Golden test: drop a real <App>.deps.json and AssemblyManifest_*.json into tests/fixtures/real/ (gitignored).
const REAL = join(__dirname, 'fixtures', 'real');
const realFiles = existsSync(REAL) ? readdirSync(REAL).filter((f) => /\.deps\.json$/i.test(f) || /^AssemblyManifest_.*\.json$/i.test(f) || /\.runtimeconfig\.json$/i.test(f)) : [];
const haveRealBinding = realFiles.some((f) => /\.deps\.json$/i.test(f)) && realFiles.some((f) => /^AssemblyManifest_/i.test(f));

describe.runIf(haveRealBinding)('golden: real deps.json + manifest', () => {
  it('explains Model.Import 10.0.0.34377', () => {
    const r = load(realFiles.map((f) => join(REAL, f)));
    const [err] = parseLoadErrors("Could not load file or assembly 'Model.Import, Version=10.0.0.34377, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.");
    const result = lookupLoadError(r, err!);
    expect(result.requesters.length >= 1 || result.verdict.startsWith(NO_REQUESTER_VERDICT)).toBe(true);
  });
});
