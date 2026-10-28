import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_MAP_SCRIPT } from '../components/input/sourceMapScript';

describe('source map script', () => {
  it('matches the copy embedded in the UI', () => {
    // Normalize line endings: Git for Windows may check the script out with CRLF.
    const onDisk = readFileSync(join(__dirname, '..', 'scripts', 'Export-NuGetSourceMap.ps1'), 'utf8').replace(/\r\n/g, '\n');
    expect(SOURCE_MAP_SCRIPT).toBe(onDisk);
  });
});

describe('assembly manifest script', () => {
  const script = readFileSync(join(__dirname, '..', 'public', 'scripts', 'Export-AssemblyManifest.ps1'), 'utf8');

  it('declares every parameter with a default value', () => {
    expect(script).toContain("[string]$BinPath = 'C:\\dev\\git\\<Repo>\\<Project>\\bin\\Debug\\net10.0'");
    expect(script).toContain('[string[]]$ExtraPaths = @()');
    expect(script).toContain('[bool]$IncludeFramework = $true');
    expect(script).toContain("[string]$DotnetRoot = 'C:\\Program Files\\dotnet'");
    expect(script).toContain("[string]$ResultsFolder = '.\\results'");
  });

  it('reads metadata without loading assemblies', () => {
    expect(script).toContain('#Requires -Version 7.0');
    expect(script).toContain('System.Reflection.PortableExecutable.PEReader');
    expect(script).toContain('System.Reflection.Metadata.PEReaderExtensions');
    expect(script).not.toMatch(/Assembly\]::(Load|LoadFrom|LoadFile|ReflectionOnlyLoad)|Add-Type\s+-Path/i);
  });

  it('writes a timestamped manifest and prints the OneDrive link', () => {
    expect(script).toContain("'AssemblyManifest_{0}_{1}.json' -f $safeName, (Get-Date -Format 'yyyyMMdd_HHmm')");
    expect(script).toContain('https://inscriptrx-my.sharepoint.com/');
  });
});

describe('Fix Planner scripts', () => {
  const read = (f: string) => readFileSync(join(__dirname, '..', 'public', 'scripts', f), 'utf8');

  it('Export-PackageAssemblyMap.ps1 follows the spec', () => {
    const s = read('Export-PackageAssemblyMap.ps1');
    expect(s).toContain('#Requires -Version 7.0');
    expect(s).toContain('[string]$PackagesPath = "$env:USERPROFILE\\.nuget\\packages"');
    expect(s).toContain("[string]$IdPattern = '^(model|plugin|datalayer|feature|linql)\\.'");
    expect(s).toContain("[string]$Tfm = 'net10.0'");
    expect(s).toContain("[string]$ResultsFolder = '.\\results'");
    expect(s).toContain("'PackageAssemblyMap_{0}.json' -f (Get-Date -Format 'yyyyMMdd_HHmm')");
    expect(s).toContain('System.Reflection.PortableExecutable.PEReader');
    expect(s).toContain("dotnet package search <Id> --source '{0}' --prerelease --exact-match --format table");
    expect(s).toContain("$FeedUrl = 'https://pkgs.dev.azure.com/inscriptrx/_packaging/org/nuget/v3/index.json'");
    expect(s).toContain('https://inscriptrx-my.sharepoint.com/');
    expect(s).not.toMatch(/Assembly\]::(Load|LoadFrom|LoadFile)/i);
  });

  it('Find-AssemblyReference.ps1 writes the CSV columns the Fix Planner reads', () => {
    const s = read('Find-AssemblyReference.ps1');
    expect(s).toContain('Select-Object Kind, Assembly, AssemblyVersion, ReferencesVersion, Path | Export-Csv');
    expect(s).toContain("'AssemblyReferences_{0}_{1}.csv' -f $safeName, (Get-Date -Format 'yyyyMMdd_HHmm')");
    expect(s).toContain('https://inscriptrx-my.sharepoint.com/');
    expect(s).not.toMatch(/Assembly\]::(Load|LoadFrom|LoadFile)/i);
  });
});
