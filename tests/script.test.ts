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
