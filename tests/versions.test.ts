import { describe, expect, it } from 'vitest';
import { normalizeFramework, splitTargetKey } from '../lib/framework';
import {
  compareVersionStrings,
  compileBuildPattern,
  DEFAULT_BUILD_PATTERN,
  describeRange,
  extractBuildNumber,
  normalizeVersion,
  parseDependencyGroupEntry,
  parseRange,
  parseVersion,
  rangeKind,
  requestedVersion,
  satisfiesText,
  versionDiff,
} from '../lib/versions';

describe('versions', () => {
  it('normalizes like NuGet', () => {
    expect(normalizeVersion('1.0')).toBe('1.0.0');
    expect(normalizeVersion('1.0.0.0')).toBe('1.0.0');
    expect(normalizeVersion('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeVersion('01.2.3-Beta.1+sha.abc')).toBe('1.2.3-Beta.1');
  });

  it('orders prereleases before releases and compares numeric labels numerically', () => {
    const sorted = ['1.0.0', '1.0.0-beta.10', '1.0.0-beta.2', '1.0.0-alpha', '0.9.0'].sort(compareVersionStrings);
    expect(sorted).toEqual(['0.9.0', '1.0.0-alpha', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0']);
  });
});

describe('ranges', () => {
  it('treats a bare version as a minimum', () => {
    expect(satisfiesText('1.0.0', '1.5.0')).toBe(true);
    expect(satisfiesText('1.0.0', '0.9.0')).toBe(false);
  });

  it('handles interval notation', () => {
    expect(satisfiesText('[1.0.0, 2.0.0)', '2.0.0')).toBe(false);
    expect(satisfiesText('[1.0.0, 2.0.0]', '2.0.0')).toBe(true);
    expect(satisfiesText('(1.0.0, )', '1.0.0')).toBe(false);
    expect(satisfiesText('(, 2.0.0]', '0.1.0')).toBe(true);
    expect(satisfiesText('[1.2.3]', '1.2.3')).toBe(true);
    expect(satisfiesText('[1.2.3]', '1.2.4')).toBe(false);
  });

  it('handles floating ranges', () => {
    expect(satisfiesText('1.*', '1.9.0')).toBe(true);
    expect(satisfiesText('1.*', '2.0.0')).toBe(false);
    expect(satisfiesText('1.0.0-*', '1.0.0-beta.3')).toBe(true);
    expect(satisfiesText('*', '42.0.0')).toBe(true);
  });

  it('rejects malformed ranges', () => {
    expect(parseRange('[1.0.0')).toBeNull();
    expect(parseRange('(1.0.0)')).toBeNull();
    expect(satisfiesText('banana', '1.0.0')).toBeNull();
  });

  it('describes ranges compactly', () => {
    expect(describeRange('[1.0.0, )')).toBe('≥ 1.0.0');
    expect(describeRange('13.0.1')).toBe('≥ 13.0.1');
    expect(describeRange('[1.0.0]')).toBe('= 1.0.0');
    expect(describeRange('[1.0.0, 2.0.0)')).toBe('[1.0.0, 2.0.0)');
  });

  it('parses projectFileDependencyGroups entries', () => {
    expect(parseDependencyGroupEntry('Newtonsoft.Json >= 13.0.3')).toEqual({ id: 'Newtonsoft.Json', range: '[13.0.3, )' });
    expect(parseDependencyGroupEntry('Foo >= 1.0.0 < 2.0.0')).toEqual({ id: 'Foo', range: '[1.0.0, 2.0.0)' });
    expect(parseDependencyGroupEntry('Foo >= 1.0.0 <= 1.0.0')).toEqual({ id: 'Foo', range: '[1.0.0]' });
    expect(parseDependencyGroupEntry('Foo')).toEqual({ id: 'Foo', range: '' });
    expect(parseDependencyGroupEntry('Foo ~> 1.0')).toBeNull();
  });
});

describe('frameworks', () => {
  it('normalizes long framework names', () => {
    expect(normalizeFramework('.NETCoreApp,Version=v8.0')).toBe('net8.0');
    expect(normalizeFramework('.NETCoreApp,Version=v3.1')).toBe('netcoreapp3.1');
    expect(normalizeFramework('.NETStandard,Version=v2.0')).toBe('netstandard2.0');
    expect(normalizeFramework('.NETFramework,Version=v4.7.2')).toBe('net472');
    expect(normalizeFramework('.NETFramework,Version=v4.8')).toBe('net48');
    expect(normalizeFramework('.NETFramework,Version=v4.0,Profile=Client')).toBe('net40-client');
    expect(normalizeFramework('NET8.0-windows7.0')).toBe('net8.0-windows7.0');
  });

  it('splits runtime-specific target keys', () => {
    expect(splitTargetKey('net8.0/win-x64')).toEqual({ framework: 'net8.0', rid: 'win-x64' });
    expect(splitTargetKey('net8.0')).toEqual({ framework: 'net8.0' });
  });
});

describe('NuGet range parsing (Version Skew)', () => {
  const v = (s: string) => parseVersion(s)!;
  it('treats a bare version as its own lower bound', () => {
    expect(parseRange('10.0.0-13243')).toEqual({ min: v('10.0.0-13243'), minInclusive: true, maxInclusive: false });
  });
  it('parses an inclusive-exclusive interval', () => {
    expect(parseRange('[3.1.1, 4.0.0)')).toEqual({ min: v('3.1.1'), minInclusive: true, max: v('4.0.0'), maxInclusive: false });
  });
  it('parses a floating prerelease range', () => {
    const r = parseRange('[10.0.*-*, )');
    expect(r?.float).toEqual({ fixedParts: [10, 0], releasePrefix: '' });
    expect(r?.max).toBeUndefined();
    expect(rangeKind('[10.0.*-*, )')).toBe('floatingPrerelease');
  });
  it('parses a prerelease upper bound', () => {
    expect(parseRange('[2.0.0, 3.0.0-A)')).toEqual({ min: v('2.0.0'), minInclusive: true, max: v('3.0.0-A'), maxInclusive: false });
  });
  it('parses an upper-only range', () => {
    expect(parseRange('(,10.0.32767]')).toEqual({ minInclusive: false, max: v('10.0.32767'), maxInclusive: true });
    expect(requestedVersion('(,10.0.32767]', '10.0.1')).toBeUndefined();
  });
  it('parses an exact range, including the [x, x] form NuGet writes', () => {
    expect(parseRange('[1.0.0]')).toEqual({ min: v('1.0.0'), minInclusive: true, max: v('1.0.0'), maxInclusive: true });
    expect(rangeKind('[1.0.0]')).toBe('pinned');
    expect(rangeKind('[2.1.35, 2.1.35]')).toBe('pinned');
  });
  it('uses the resolved version as the requested version of a satisfied float', () => {
    expect(requestedVersion('[10.0.*-*, )', '10.0.0-13615')).toBe('10.0.0-13615');
    expect(requestedVersion('10.0.0-13243', '10.0.0-13615')).toBe('10.0.0-13243');
  });
});

describe('build numbers', () => {
  const re = new RegExp(DEFAULT_BUILD_PATTERN);
  it('extracts the build number from the prerelease label', () => {
    expect(extractBuildNumber('10.0.0-13243', re)).toBe(13243);
    expect(extractBuildNumber('1.0.0-beta.11541', re)).toBe(11541);
    expect(extractBuildNumber('1.2.3', re)).toBeNull();
  });
  it('validates custom patterns', () => {
    expect(compileBuildPattern('-ci(\\d+)$').ok).toBe(true);
    expect(compileBuildPattern('-\\d+$')).toMatchObject({ ok: false });
    expect(compileBuildPattern('(')).toMatchObject({ ok: false });
  });
  it('computes a lag only within the same major.minor.patch', () => {
    expect(versionDiff('10.0.0-13018', '10.0.0-13511', re)).toEqual({ diff: 'build', lag: 493 });
    expect(versionDiff('6.1.1', '7.1.1', re)).toEqual({ diff: 'major', lag: null });
    expect(versionDiff('10.0.0-13018', '10.1.0-13511', re)).toEqual({ diff: 'minor', lag: null });
    expect(versionDiff('10.0.0-13018', '10.0.0-13511', null)).toEqual({ diff: 'prerelease', lag: null });
  });
});

describe('SemVer precedence', () => {
  it('orders a prerelease before its release', () => {
    expect(compareVersionStrings('1.0.0-13243', '1.0.0')).toBeLessThan(0);
  });
  it('orders numeric identifiers numerically and below alphanumeric ones', () => {
    expect(compareVersionStrings('1.0.0-beta.9', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersionStrings('1.0.0-2', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersionStrings('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersionStrings('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBeGreaterThan(0);
  });
});
