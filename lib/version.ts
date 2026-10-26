// NuGet version and version-range handling (subset of NuGet.Versioning semantics).

export interface NuGetVersion {
  major: number;
  minor: number;
  patch: number;
  revision: number;
  /** Prerelease identifiers ("beta.2" → ["beta", "2"]); empty for a stable release. */
  release: string[];
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?$/;

export function parseVersion(text: string): NuGetVersion | null {
  const m = VERSION_RE.exec(text.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    revision: Number(m[4] ?? 0),
    release: m[5] ? m[5].split('.') : [],
  };
}

export function formatVersion(v: NuGetVersion): string {
  let s = `${v.major}.${v.minor}.${v.patch}`;
  if (v.revision > 0) s += `.${v.revision}`;
  if (v.release.length > 0) s += `-${v.release.join('.')}`;
  return s;
}

/** NuGet normalized form: "1.0" → "1.0.0", "1.0.0.0" → "1.0.0", build metadata dropped. Unparseable input is returned trimmed. */
export function normalizeVersion(text: string): string {
  const v = parseVersion(text);
  return v ? formatVersion(v) : text.trim();
}

/** Key form used for metadata and nuget.org comparisons. */
export function versionKey(text: string): string {
  return normalizeVersion(text).toLowerCase();
}

const NUMERIC_RE = /^\d+$/;

function compareReleaseLabels(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // stable > prerelease
  if (b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    const xNum = NUMERIC_RE.test(x);
    const yNum = NUMERIC_RE.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else {
      const xl = x.toLowerCase();
      const yl = y.toLowerCase();
      if (xl !== yl) return xl < yl ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function compareVersions(a: NuGetVersion, b: NuGetVersion): number {
  for (const k of ['major', 'minor', 'patch', 'revision'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return compareReleaseLabels(a.release, b.release);
}

/** Compares two version strings; unparseable strings sort after parseable ones, then ordinally. */
export function compareVersionStrings(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va && vb) return compareVersions(va, vb);
  if (va) return -1;
  if (vb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export interface FloatSpec {
  /** Numeric parts that must match exactly ("1.2.*" → [1, 2]). */
  fixedParts: number[];
  /** Prerelease prefix for "1.0.0-beta*"; undefined when prereleases are not floated. */
  releasePrefix?: string;
}

export interface VersionRange {
  min?: NuGetVersion;
  minInclusive: boolean;
  max?: NuGetVersion;
  maxInclusive: boolean;
  float?: FloatSpec;
}

function parseFloat(text: string): { min: NuGetVersion; float: FloatSpec } | null {
  const t = text.trim();
  if (t === '*') return { min: { major: 0, minor: 0, patch: 0, revision: 0, release: [] }, float: { fixedParts: [] } };
  const dash = t.indexOf('-');
  const numPart = dash >= 0 ? t.slice(0, dash) : t;
  const relPart = dash >= 0 ? t.slice(dash + 1) : undefined;
  const parts = numPart.split('.');
  const fixed: number[] = [];
  let sawStar = false;
  for (const p of parts) {
    if (p === '*') {
      sawStar = true;
      break;
    }
    if (!NUMERIC_RE.test(p)) return null;
    fixed.push(Number(p));
  }
  let releasePrefix: string | undefined;
  if (relPart !== undefined) {
    if (!relPart.endsWith('*')) return null;
    releasePrefix = relPart.slice(0, -1);
  } else if (!sawStar) {
    return null;
  }
  const filled = [...fixed, 0, 0, 0, 0];
  return {
    min: { major: filled[0] as number, minor: filled[1] as number, patch: filled[2] as number, revision: filled[3] as number, release: releasePrefix !== undefined ? ['0'] : [] },
    // For "1.0.0-beta*" every numeric part is fixed; for "1.*" only the leading parts are.
    float: { fixedParts: sawStar ? fixed : fixed.slice(0, 4), releasePrefix },
  };
}

/**
 * Parses NuGet range syntax: "1.0" (≥), "[1.0]", "[1.0, 2.0)", "(, 2.0]", "1.*", "1.0.0-*".
 * Returns null when the text is not a valid range.
 */
export function parseRange(text: string): VersionRange | null {
  const t = text.trim();
  if (t === '') return { minInclusive: true, maxInclusive: false };
  const first = t[0];
  if (first !== '[' && first !== '(') {
    if (t.includes('*')) {
      const f = parseFloat(t);
      return f ? { min: f.min, minInclusive: true, maxInclusive: false, float: f.float } : null;
    }
    const v = parseVersion(t);
    return v ? { min: v, minInclusive: true, maxInclusive: false } : null;
  }
  const last = t[t.length - 1];
  if (last !== ']' && last !== ')') return null;
  const inner = t.slice(1, -1);
  const comma = inner.indexOf(',');
  if (comma < 0) {
    // "[1.0]" is the only legal single-value bracket form.
    if (first !== '[' || last !== ']') return null;
    const v = parseVersion(inner);
    return v ? { min: v, minInclusive: true, max: v, maxInclusive: true } : null;
  }
  const lo = inner.slice(0, comma).trim();
  const hi = inner.slice(comma + 1).trim();
  const range: VersionRange = { minInclusive: first === '[', maxInclusive: last === ']' };
  if (lo) {
    if (lo.includes('*')) {
      const f = parseFloat(lo);
      if (!f) return null;
      range.min = f.min;
      range.float = f.float;
    } else {
      const v = parseVersion(lo);
      if (!v) return null;
      range.min = v;
    }
  }
  if (hi) {
    const v = parseVersion(hi);
    if (!v) return null;
    range.max = v;
  }
  return range;
}

/** Whether `version` is inside `range`. Floating ranges match versions that share the fixed prefix. */
export function satisfies(range: VersionRange, version: NuGetVersion): boolean {
  if (range.min) {
    const c = compareVersions(version, range.min);
    if (c < 0 || (c === 0 && !range.minInclusive)) {
      // A floating prerelease range like "1.0.0-*" also admits the stable 1.0.0 and its prereleases.
      if (!range.float) return false;
    }
  }
  if (range.max) {
    const c = compareVersions(version, range.max);
    if (c > 0 || (c === 0 && !range.maxInclusive)) return false;
  }
  if (range.float) {
    const parts = [version.major, version.minor, version.patch, version.revision];
    for (let i = 0; i < range.float.fixedParts.length; i++) {
      if (parts[i] !== range.float.fixedParts[i]) return false;
    }
    const prefix = range.float.releasePrefix;
    if (prefix !== undefined && version.release.length > 0) {
      if (!version.release.join('.').toLowerCase().startsWith(prefix.toLowerCase())) return false;
    }
  }
  return true;
}

/** Convenience wrapper over strings; null when either side does not parse. */
export function satisfiesText(rangeText: string, versionText: string): boolean | null {
  const r = parseRange(rangeText);
  const v = parseVersion(versionText);
  if (!r || !v) return null;
  return satisfies(r, v);
}

/** Short display form: "≥ 1.0.0", "= 1.0.0", "[1.0.0, 2.0.0)", or the original text when unparseable. */
export function describeRange(text: string): string {
  const t = text.trim();
  if (t === '') return '';
  const r = parseRange(t);
  if (!r) return t;
  if (r.float) return t;
  if (r.min && r.max && r.minInclusive && r.maxInclusive && compareVersions(r.min, r.max) === 0) return `= ${formatVersion(r.min)}`;
  if (r.min && !r.max && r.minInclusive) return `≥ ${formatVersion(r.min)}`;
  if (r.min && !r.max) return `> ${formatVersion(r.min)}`;
  const lo = r.min ? formatVersion(r.min) : '';
  const hi = r.max ? formatVersion(r.max) : '';
  return `${r.minInclusive && r.min ? '[' : '('}${lo}, ${hi}${r.maxInclusive && r.max ? ']' : ')'}`;
}

/** Minimum version a range admits, if any. */
export function rangeMin(text: string): NuGetVersion | undefined {
  return parseRange(text)?.min;
}

/**
 * Parses a projectFileDependencyGroups entry such as "Newtonsoft.Json >= 13.0.3" or
 * "Foo >= 1.0.0 < 2.0.0" into an Id and a NuGet range string.
 */
export function parseDependencyGroupEntry(entry: string): { id: string; range: string } | null {
  const tokens = entry.trim().split(/\s+/);
  const id = tokens[0];
  if (!id) return null;
  let min: string | undefined;
  let minInclusive = true;
  let max: string | undefined;
  let maxInclusive = false;
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i];
    const v = tokens[i + 1] as string;
    switch (op) {
      case '>=':
        min = v;
        minInclusive = true;
        break;
      case '>':
        min = v;
        minInclusive = false;
        break;
      case '<=':
        max = v;
        maxInclusive = true;
        break;
      case '<':
        max = v;
        maxInclusive = false;
        break;
      case '==':
      case '=':
        min = v;
        max = v;
        minInclusive = true;
        maxInclusive = true;
        break;
      default:
        return null;
    }
  }
  if (tokens.length > 1 && tokens.length % 2 === 0) return null;
  if (min === undefined && max === undefined) return { id, range: '' };
  if (min !== undefined && max !== undefined && min === max && minInclusive && maxInclusive) return { id, range: `[${min}]` };
  if (max === undefined) return { id, range: minInclusive ? `[${min}, )` : `(${min}, )` };
  return { id, range: `${min !== undefined && minInclusive ? '[' : '('}${min ?? ''}, ${max}${maxInclusive ? ']' : ')'}` };
}
