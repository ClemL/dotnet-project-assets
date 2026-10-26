import { describe, expect, it } from 'vitest';
import { normalizeFramework, splitTargetKey } from '../lib/framework';
import {
  compareVersionStrings,
  describeRange,
  normalizeVersion,
  parseDependencyGroupEntry,
  parseRange,
  satisfiesText,
} from '../lib/version';

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
