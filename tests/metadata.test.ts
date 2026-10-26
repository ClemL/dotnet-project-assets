import { describe, expect, it } from 'vitest';
import { classifySource, metadataKey, parseNupkgMetadata, parsePackagesFolderPath, parseSourceMap, suggestInternalFeeds } from '../lib/metadata';
import { fixtureText } from './helpers';

const FEED = 'https://pkgs.dev.azure.com/inscriptrx/_packaging/acme/nuget/v3/index.json';

describe('.nupkg.metadata', () => {
  it('reads source and ignores unknown fields', () => {
    expect(parseNupkgMetadata(fixtureText('metadata/newtonsoft.json.nupkg.metadata'))).toMatchObject({ ok: true, source: 'https://api.nuget.org/v3/index.json' });
    expect(parseNupkgMetadata('{"version":2,"source":"x","futureField":[1]}')).toMatchObject({ ok: true, source: 'x' });
  });

  it('rejects files without a source', () => {
    expect(parseNupkgMetadata(fixtureText('metadata/no-source.nupkg.metadata'))).toEqual({ ok: false, error: 'Missing "source".' });
    expect(parseNupkgMetadata('{"source":""}').ok).toBe(false);
    expect(parseNupkgMetadata('not json').ok).toBe(false);
    expect(parseNupkgMetadata('[]').ok).toBe(false);
  });
});

describe('packages folder paths', () => {
  it('derives Id and version from <id>/<version>/.nupkg.metadata', () => {
    expect(parsePackagesFolderPath('packages/newtonsoft.json/13.0.1/.nupkg.metadata')).toEqual({ key: 'newtonsoft.json/13.0.1', id: 'newtonsoft.json', version: '13.0.1' });
    expect(parsePackagesFolderPath('.nuget\\packages\\Acme.Core\\1.0.0-Beta\\.nupkg.metadata')?.key).toBe('acme.core/1.0.0-beta');
  });

  it('rejects other files and nested paths', () => {
    expect(parsePackagesFolderPath('packages/newtonsoft.json/13.0.1/newtonsoft.json.nuspec')).toBeNull();
    expect(parsePackagesFolderPath('packages/newtonsoft.json/13.0.1/lib/.nupkg.metadata')).toBeNull();
    expect(parsePackagesFolderPath('.nupkg.metadata')).toBeNull();
  });
});

describe('bundled source map', () => {
  it('normalizes keys and counts invalid entries', () => {
    const r = parseSourceMap(fixtureText('metadata/source-map.json'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.invalid).toBe(2);
      expect(Object.keys(r.map).sort()).toEqual(['acme.core/1.0.0', 'acme.logging/1.2.0', 'contoso.plugin/2.0.0', 'microsoft.extensions.logging/8.0.0', 'newtonsoft.json/13.0.1']);
    }
    expect(parseSourceMap('[]').ok).toBe(false);
  });

  it('keys by lowercase Id and normalized version', () => {
    expect(metadataKey('Newtonsoft.Json', '13.0.1.0')).toBe('newtonsoft.json/13.0.1');
  });
});

describe('sources', () => {
  it('classifies source kinds', () => {
    expect(classifySource('https://api.nuget.org/v3/index.json/', [])).toBe('nugetOrg');
    expect(classifySource(FEED.toUpperCase(), [FEED])).toBe('internalFeed');
    expect(classifySource('https://nuget.pkg.github.com/acme/index.json', [FEED])).toBe('otherRemote');
    expect(classifySource('C:\\Program Files (x86)\\Microsoft Visual Studio\\Shared\\NuGetPackages', [])).toBe('local');
    expect(classifySource('\\\\fileserver\\nuget', ['\\\\fileserver\\nuget\\'])).toBe('internalFeed');
  });

  it('suggests internal feeds without nuget.org or the Visual Studio offline folder', () => {
    expect(
      suggestInternalFeeds([
        'https://api.nuget.org/v3/index.json',
        'C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\',
        FEED,
        `${FEED}/`,
        '\\\\fileserver\\nuget',
      ]),
    ).toEqual(['\\\\fileserver\\nuget', FEED]);
  });
});
