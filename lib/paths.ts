// Path filters for folder uploads. Paths are relative ("git/App/obj/project.assets.json").

/** Directory names that are never searched. Compared case-insensitively. */
export const IGNORED_DIRS: readonly string[] = ['node_modules', 'bin', '.vs', '.git'];

export function splitPath(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
}

export function isIgnoredDir(name: string): boolean {
  const n = name.toLowerCase();
  return IGNORED_DIRS.includes(n);
}

/** Matches **\/obj/project.assets.json outside ignored directories. */
export function isProjectAssetsPath(path: string): boolean {
  const segs = splitPath(path);
  const n = segs.length;
  if (n < 2) return false;
  if ((segs[n - 1] as string).toLowerCase() !== 'project.assets.json') return false;
  if ((segs[n - 2] as string).toLowerCase() !== 'obj') return false;
  return !segs.slice(0, n - 1).some(isIgnoredDir);
}

/** Lexically resolves "." and ".." and normalizes separators; case is preserved. */
export function normalizeFsPath(path: string): string {
  const unified = path.replace(/\\/g, '/');
  const leadingSlashes = /^\/+/.exec(unified)?.[0] ?? '';
  const out: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..' && !/^[A-Za-z]:$/.test(out[out.length - 1] as string)) out.pop();
      else if (out.length === 0) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return leadingSlashes + out.join('/');
}

export function dirname(path: string): string {
  const n = normalizeFsPath(path);
  const i = n.lastIndexOf('/');
  return i < 0 ? '' : n.slice(0, i);
}

export function joinPath(base: string, relative: string): string {
  const r = relative.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(r) || r.startsWith('/')) return normalizeFsPath(r);
  return normalizeFsPath(base ? `${base}/${r}` : r);
}

/** Comparable key for file-system paths (Windows paths are case-insensitive). */
export function pathKey(path: string): string {
  return normalizeFsPath(path).toLowerCase();
}
