// Target framework key handling for assets.json.

/**
 * Normalizes a framework name to its short folder form:
 * ".NETCoreApp,Version=v8.0" → "net8.0", ".NETStandard,Version=v2.0" → "netstandard2.0",
 * ".NETFramework,Version=v4.7.2" → "net472". Short names are lowercased; unknown long names
 * are lowercased as-is.
 */
export function normalizeFramework(name: string): string {
  const trimmed = name.trim();
  const m = /^([^,]+),\s*Version=v?([\d.]+)(.*)$/i.exec(trimmed);
  if (!m) return trimmed.toLowerCase();
  const identifier = (m[1] as string).trim().toLowerCase();
  const version = m[2] as string;
  const rest = m[3] ?? '';
  const profile = /Profile=([^,]+)/i.exec(rest)?.[1];
  const parts = version.split('.').map((p) => Number(p));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  let short: string;
  switch (identifier) {
    case '.netcoreapp':
      short = major >= 5 ? `net${major}.${minor}` : `netcoreapp${major}.${minor}`;
      break;
    case '.netstandard':
      short = `netstandard${major}.${minor}`;
      break;
    case '.netframework': {
      const build = parts[2] ?? 0;
      short = `net${major}${minor}${build > 0 ? build : ''}`;
      break;
    }
    default:
      return trimmed.toLowerCase();
  }
  return profile ? `${short}-${profile.toLowerCase()}` : short;
}

/** Splits "net8.0/win-x64" into framework and runtime identifier. */
export function splitTargetKey(key: string): { framework: string; rid?: string } {
  const slash = key.indexOf('/');
  if (slash < 0) return { framework: key };
  return { framework: key.slice(0, slash), rid: key.slice(slash + 1) };
}
