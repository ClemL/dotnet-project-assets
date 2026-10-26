import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLLECT_SCRIPTS, RUN_ALL_SNIPPET, SETUP_SNIPPET, type CollectScript } from '../components/collect/scripts';

const PUBLIC = join(__dirname, '..', 'public');

function scriptText(s: CollectScript): string {
  return 'text' in s.source ? s.source.text : readFileSync(join(PUBLIC, s.source.url), 'utf8').replace(/\r\n/g, '\n');
}

/** Parameter names declared in the script's top-level param( … ) block. */
function declaredParams(text: string): Set<string> {
  const start = text.indexOf('\nparam(');
  const end = text.indexOf('\n)\n', start);
  return new Set([...text.slice(start, end).matchAll(/\]\$(\w+)/g)].map((m) => (m[1] as string).toLowerCase()));
}

/** Flags passed to `file` anywhere in `snippet`. */
function flagsUsed(snippet: string, file: string): string[] {
  return snippet
    .split('\n')
    .filter((line) => line.includes(`.\\${file}`))
    .flatMap((line) => [...line.slice(line.indexOf(file)).matchAll(/\s-(\w+)/g)].map((m) => (m[1] as string).toLowerCase()));
}

const COMMON = new Set(['whatif', 'verbose', 'confirm']);

describe('collect scripts catalog', () => {
  it('serves every listed script from public/', () => {
    for (const s of COLLECT_SCRIPTS) {
      if ('url' in s.source) expect(existsSync(join(PUBLIC, s.source.url)), s.file).toBe(true);
      expect(scriptText(s).length).toBeGreaterThan(500);
    }
  });

  it('uses only declared parameters in the examples and the run-all snippet', () => {
    for (const s of COLLECT_SCRIPTS) {
      const params = declaredParams(scriptText(s));
      expect(params.size, s.file).toBeGreaterThan(0);
      for (const flag of [...flagsUsed(s.example, s.file), ...flagsUsed(RUN_ALL_SNIPPET, s.file)]) {
        expect(params.has(flag) || COMMON.has(flag), `${s.file} -${flag}`).toBe(true);
      }
    }
  });

  it('spells out every parameter in each example', () => {
    for (const s of COLLECT_SCRIPTS) {
      const used = new Set(flagsUsed(s.example, s.file));
      expect([...declaredParams(scriptText(s))].filter((p) => !used.has(p)), s.file).toEqual([]);
    }
  });

  it('runs only scripts from the catalog in the snippets', () => {
    const files = new Set(COLLECT_SCRIPTS.map((s) => s.file));
    for (const m of RUN_ALL_SNIPPET.matchAll(/\.\\([\w-]+\.ps1)/g)) expect(files.has(m[1] as string), m[1]).toBe(true);
    expect(SETUP_SNIPPET).toContain("Set-ExecutionPolicy -Scope Process");
  });
});

describe('collect scripts', () => {
  const collectors = COLLECT_SCRIPTS.filter((s) => s.file.startsWith('Collect-'));

  it('copy into C:\\dev\\results\\AssetsGraphInputs_yyyyMMdd_HHmm and print the path and OneDrive link', () => {
    for (const s of collectors) {
      const text = scriptText(s);
      expect(text, s.file).toContain("[string]$Destination = ('C:\\dev\\results\\AssetsGraphInputs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmm'))");
      expect(text, s.file).toContain("Write-Host 'Collected into:'");
      expect(text, s.file).toContain('https://inscriptrx-my.sharepoint.com/');
      expect(text, s.file).toContain('SupportsShouldProcess = $true');
    }
  });

  it('never delete or move anything', () => {
    for (const s of COLLECT_SCRIPTS) expect(scriptText(s), s.file).not.toMatch(/\b(Remove-Item|Move-Item|Rename-Item|Clear-Content|Set-Content\s+-LiteralPath\s+\$(file|deps|rc))\b/i);
  });

  it('stay compatible with Windows PowerShell 5.1', () => {
    for (const s of COLLECT_SCRIPTS.filter((x) => x.requires !== 'PowerShell 7+')) {
      const text = scriptText(s);
      // 5.1 reads BOM-less files as ANSI, so keep them ASCII.
      expect([...text].filter((c) => c.charCodeAt(0) > 127).join(''), s.file).toBe('');
      expect(text, s.file).not.toMatch(/\?\?|\?\.|&&|\|\||-Parallel|GetRelativePath|::HashData|SemanticVersion|\$IsWindows/);
      if (s.file.startsWith('Collect-')) expect(text, s.file).toContain('#Requires -Version 5.1');
    }
  });
});
