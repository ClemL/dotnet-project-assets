import { describe, expect, it } from 'vitest';
import { parseInputs } from '../lib/analyze';
import { parseAssetsJson } from '../lib/parse';
import { isProjectAssetsPath, joinPath, normalizeFsPath } from '../lib/paths';
import { fixtureInput, loadModels } from './helpers';

describe('parseAssetsJson', () => {
  it('builds the model for a single-target file', () => {
    const [m] = loadModels('diamond.assets.json');
    expect(m?.projectName).toBe('DiamondApp');
    expect(m?.sources).toEqual(['https://api.nuget.org/v3/index.json']);
    const t = m?.targets[0];
    expect(t?.key).toBe('net8.0');
    expect(Object.keys(t?.nodes ?? {}).sort()).toEqual(['lib.a', 'lib.b', 'lib.c', 'lib.d']);
    expect(t?.roots).toEqual([
      { id: 'Lib.A', range: '[1.0.0, )', kind: 'packageReference' },
      { id: 'Lib.B', range: '[1.0.0, )', kind: 'packageReference' },
    ]);
  });

  it('resolves project references through msbuildProject paths', () => {
    const [m] = loadModels('acme-web.assets.json');
    const roots = m?.targets[0]?.roots ?? [];
    expect(roots).toContainEqual({ id: 'Acme.Data', range: '', kind: 'projectReference' });
    expect(roots.filter((r) => r.kind === 'packageReference').map((r) => r.id)).toEqual(['Acme.Logging', 'Contoso.Plugin']);
    expect(m?.warnings).toEqual([]);
  });

  it('matches long-form framework keys to their dependency groups, including RID targets', () => {
    const [m] = loadModels('multi-tfm.assets.json');
    const keys = m?.targets.map((t) => [t.key, t.tfm, t.rid]);
    expect(keys).toEqual([
      ['.NETCoreApp,Version=v8.0', 'net8.0', undefined],
      ['.NETFramework,Version=v4.8', 'net48', undefined],
      ['.NETCoreApp,Version=v8.0/win-x64', 'net8.0', 'win-x64'],
    ]);
    for (const t of m?.targets ?? []) expect(t.roots.map((r) => r.id)).toEqual(['Polly', 'System.Text.Json']);
    expect(m?.warnings).toEqual([]);
  });
});

describe('malformed input', () => {
  it('reports invalid JSON', () => {
    const r = parseAssetsJson(fixtureInput('truncated.assets.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/^Invalid JSON/);
  });

  it('lists every missing required field', () => {
    const r = parseAssetsJson(fixtureInput('not-assets.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('Not a project.assets.json file: missing or invalid targets, libraries, project.restore.projectName.');
  });

  it('rejects empty input, non-object JSON, and wrong field types', () => {
    const cases = ['', '   ', '[1,2]', '"text"', '{"version":3,"targets":[],"libraries":{},"project":{"restore":{"projectName":"X"}}}'];
    for (const text of cases) expect(parseAssetsJson({ inputId: 'x', fileName: 'x', text }).ok).toBe(false);
  });

  it('accepts a BOM-prefixed file', () => {
    const input = fixtureInput('diamond.assets.json');
    expect(parseAssetsJson({ ...input, text: `\uFEFF${input.text}` }).ok).toBe(true);
  });

  it('keeps going when some files fail', () => {
    const { models, errors } = parseInputs([
      fixtureInput('truncated.assets.json'),
      fixtureInput('diamond.assets.json'),
      fixtureInput('not-assets.json'),
      fixtureInput('range-conflict.assets.json'),
    ]);
    expect(models.map((m) => m.projectName)).toEqual(['DiamondApp', 'ConflictApp']);
    expect(errors.map((e) => e.fileName)).toEqual(['truncated.assets.json', 'not-assets.json']);
  });

  it('warns about unknown node types and unparseable dependency-group entries without failing', () => {
    const text = JSON.stringify({
      version: 3,
      targets: { 'net8.0': { 'Odd/1.0.0': { type: 'reference' } } },
      libraries: {},
      projectFileDependencyGroups: { 'net8.0': ['Odd ~> 1.0'] },
      project: { restore: { projectName: 'Weird' } },
    });
    const r = parseAssetsJson({ inputId: 'w', fileName: 'w.json', text });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.targets[0]?.nodes.odd?.type).toBe('package');
      expect(r.model.warnings.length).toBe(2);
    }
  });

  it('disambiguates files that share a project name', () => {
    const a = fixtureInput('diamond.assets.json');
    const { models } = parseInputs([a, { ...a, inputId: 'copy', fileName: 'copy/obj/project.assets.json' }]);
    expect(models.map((m) => m.label)).toEqual(['DiamondApp [diamond.assets.json]', 'DiamondApp [copy/obj/project.assets.json]']);
  });
});

describe('paths', () => {
  it('keeps only obj/project.assets.json outside ignored folders', () => {
    expect(isProjectAssetsPath('git/App/obj/project.assets.json')).toBe(true);
    expect(isProjectAssetsPath('git\\App\\OBJ\\project.assets.json')).toBe(true);
    expect(isProjectAssetsPath('git/web/node_modules/pkg/obj/project.assets.json')).toBe(false);
    expect(isProjectAssetsPath('git/App/bin/Debug/obj/project.assets.json')).toBe(false);
    expect(isProjectAssetsPath('git/.vs/App/obj/project.assets.json')).toBe(false);
    expect(isProjectAssetsPath('git/App/project.assets.json')).toBe(false);
    expect(isProjectAssetsPath('git/App/obj/project.nuget.cache')).toBe(false);
  });

  it('resolves relative project paths', () => {
    expect(joinPath('C:/dev/git/Acme/src/Acme.Web', '../Acme.Data/Acme.Data.csproj')).toBe('C:/dev/git/Acme/src/Acme.Data/Acme.Data.csproj');
    expect(normalizeFsPath('C:\\a\\.\\b\\..\\c')).toBe('C:/a/c');
    expect(normalizeFsPath('/home/u/../x')).toBe('/home/x');
  });
});
