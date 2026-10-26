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
