// Four-part AssemblyVersion values (major.minor.build.revision, 16-bit parts). Kept apart from NuGet
// package versions (lib/versions.ts): the two come from different counters and are never compared.

/** A four-part AssemblyVersion. Deliberately a different shape from NuGetVersion. */
export interface AssemblyVersion {
  readonly kind: 'assembly';
  readonly parts: readonly [number, number, number, number];
}

export function parseAssemblyVersion(text: string | null | undefined): AssemblyVersion | null {
  if (!text) return null;
  const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const parts = [m[1], m[2], m[3] ?? '0', m[4] ?? '0'].map(Number) as [number, number, number, number];
  // Each part is a 16-bit value in metadata.
  if (parts.some((p) => p > 65535)) return null;
  return { kind: 'assembly', parts };
}

export function compareAssemblyVersions(a: AssemblyVersion, b: AssemblyVersion): number {
  for (let i = 0; i < 4; i++) {
    const d = (a.parts[i] as number) - (b.parts[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
