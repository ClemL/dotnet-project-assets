import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInfoLine, parseChangelog } from '../lib/changelog';

describe('parseChangelog', () => {
  it('keeps one trimmed entry per line, oldest first', () => {
    expect(parseChangelog('2026-01-01T00:00:00Z - First\n  2026-01-02T00:00:00Z - Second  \n')).toEqual(['2026-01-01T00:00:00Z - First', '2026-01-02T00:00:00Z - Second']);
  });

  it('handles CRLF line endings', () => {
    expect(parseChangelog('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('drops blank and whitespace-only lines', () => {
    expect(parseChangelog('\n\na\n   \n\t\nb\n\n')).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty or whitespace-only file', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('\n\n   \r\n')).toEqual([]);
  });
});

describe('buildInfoLine', () => {
  it('includes the build time when there is one', () => {
    expect(buildInfoLine('Assets Graph', '0.1.0', '2026-10-30 23:00 UTC')).toBe('Assets Graph · v0.1.0 · built 2026-10-30 23:00 UTC');
  });

  it('leaves out the build part when the build time is empty', () => {
    expect(buildInfoLine('Assets Graph', '0.0.0', '')).toBe('Assets Graph · v0.0.0');
  });
});

describe('public/updates.txt', () => {
  it('has well-formed entries, oldest first', () => {
    const entries = parseChangelog(readFileSync(join(__dirname, '..', 'public', 'updates.txt'), 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z - \S/);
    const stamps = entries.map((e) => e.slice(0, 20));
    expect([...stamps].sort()).toEqual(stamps);
  });
});
