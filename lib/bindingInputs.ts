// Binding-check inputs: <App>.deps.json, the assembly manifest from Export-AssemblyManifest.ps1, and
// <App>.runtimeconfig.json. Parsers never throw; problems become errors or warnings.

import { parseAssemblyVersion } from './assemblyVersion';
import type {
  AssemblyManifest,
  AssemblyOwner,
  AssemblyRefInfo,
  BindingInputKind,
  DepsAsset,
  DepsGap,
  DepsModel,
  FrameworkAssembly,
  FrameworkFolder,
  ManifestAssembly,
  PackageAssemblyEntry,
  ReferencerRow,
  ReferencerScan,
  RuntimeConfigInfo,
} from './types';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Lowercase hex token, or null for null/empty/"null". */
export function normalizeToken(v: unknown): string | null {
  const s = str(v);
  if (!s || s.toLowerCase() === 'null') return null;
  return s.toLowerCase();
}

export interface BindingInputText {
  inputId: string;
  fileName: string;
  text: string;
}

export type BindingParseResult =
  | { ok: true; kind: 'deps'; deps: DepsModel }
  | { ok: true; kind: 'manifest'; manifest: AssemblyManifest }
  | { ok: true; kind: 'runtimeconfig'; runtimeConfig: RuntimeConfigInfo }
  | { ok: true; kind: 'referencer'; scan: ReferencerScan }
  | { ok: true; kind: 'packageMap'; packageMap: PackageAssemblyEntry[] }
  | { ok: false; error: string };

/** Identifies a parsed JSON document as deps.json, an assembly manifest, or runtimeconfig.json. */
export function detectBindingInput(json: unknown): BindingInputKind | null {
  if (!isObject(json)) return null;
  if (typeof json.schema === 'number' && Array.isArray(json.assemblies)) return 'manifest';
  if (isObject(json.runtimeOptions)) return 'runtimeconfig';
  // project.assets.json also has targets + libraries, but it has "project" and no runtimeTarget.
  if (isObject(json.targets) && isObject(json.libraries) && json.project === undefined && (isObject(json.runtimeTarget) || isObject(json.compilationOptions))) return 'deps';
  return null;
}

export function parseBindingInput(input: BindingInputText): BindingParseResult {
  const text = input.text.replace(/^﻿/, '');
  if (text.trim() === '') return { ok: false, error: 'Input is empty.' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // Not JSON: a REFERENCER scan pasted from Format-Table, or its CSV.
    const scan = parseReferencerScan(text, input.fileName);
    if (scan) return { ok: true, kind: 'referencer', scan };
    return { ok: false, error: `Not JSON and not a REFERENCER scan: ${e instanceof Error ? e.message : String(e)}` };
  }
  const packageMap = parsePackageAssemblyMap(json);
  if (packageMap) return { ok: true, kind: 'packageMap', packageMap };
  const kind = detectBindingInput(json);
  switch (kind) {
    case 'deps': {
      const r = parseDeps(json as Json, input.inputId, input.fileName);
      return 'error' in r ? { ok: false, error: r.error } : { ok: true, kind, deps: r };
    }
    case 'manifest': {
      const r = parseManifest(json as Json, input.fileName);
      return 'error' in r ? { ok: false, error: r.error } : { ok: true, kind, manifest: r };
    }
    case 'runtimeconfig':
      return { ok: true, kind, runtimeConfig: parseRuntimeConfig(json as Json, input.fileName) };
    default:
      return { ok: false, error: 'Not a deps.json, assembly manifest, or runtimeconfig.json file.' };
  }
}

// ---------------------------------------------------------------------------
// Fix Planner inputs: REFERENCER scans and the package → assembly map
// ---------------------------------------------------------------------------

const assemblyOf = (dll: string) => dll.replace(/^.*[\\/]/, '').replace(/\.(dll|exe)$/i, '');

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const CSV_ALIASES: Record<string, 'kind' | 'dll' | 'version' | 'refersTo' | 'path'> = {
  kind: 'kind',
  assembly: 'dll',
  dll: 'dll',
  name: 'dll',
  assemblyversion: 'version',
  version: 'version',
  referencesversion: 'refersTo',
  refersto: 'refersTo',
  referencedversion: 'refersTo',
  path: 'path',
};

function toRow(kind: string, dll: string, version: string, refersTo: string | undefined, path: string | undefined, warnings: string[], lineNo: number): ReferencerRow | null {
  const k = kind.toUpperCase();
  if (k !== 'REFERENCER' && k !== 'DEPLOYED') {
    warnings.push(`Line ${lineNo}: unknown kind "${kind}"; skipped.`);
    return null;
  }
  for (const v of [dll, version, refersTo ?? '']) {
    if (/(…|\.\.\.)$/.test(v)) warnings.push(`Line ${lineNo}: "${v}" looks truncated by Format-Table; use Format-Table -AutoSize or the CSV export.`);
  }
  if (!parseAssemblyVersion(version)) warnings.push(`Line ${lineNo}: "${version}" is not an assembly version.`);
  if (k === 'REFERENCER' && !parseAssemblyVersion(refersTo)) {
    warnings.push(`Line ${lineNo}: REFERENCER row without a valid RefersTo version; skipped.`);
    return null;
  }
  return { kind: k, dll, assembly: assemblyOf(dll), version, refersTo: k === 'REFERENCER' ? refersTo : undefined, path: path || undefined };
}

/**
 * Parses a REFERENCER scan: the PowerShell Format-Table output (Kind, Dll, Version, RefersTo; split on
 * whitespace, blank lines and the ---- row ignored) or the CSV from Find-AssemblyReference.ps1 (Kind,
 * Assembly, AssemblyVersion, ReferencesVersion, Path). Returns null when the text is neither.
 */
export function parseReferencerScan(text: string, fileName = 'Pasted scan'): ReferencerScan | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => /^\s*"?kind"?\s*[,\s]/i.test(l));
  if (headerIndex < 0) return null;
  const header = lines[headerIndex] as string;
  const warnings: string[] = [];
  const rows: ReferencerRow[] = [];
  let source: ReferencerScan['source'];

  if (header.includes(',')) {
    source = 'csv';
    const cols = splitCsvLine(header).map((h) => CSV_ALIASES[h.replace(/\s+/g, '').toLowerCase()]);
    if (!cols.includes('kind') || !cols.includes('dll') || !cols.includes('version')) return null;
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() === '') continue;
      const cells = splitCsvLine(line);
      const get = (c: string) => {
        const idx = cols.indexOf(c as never);
        return idx >= 0 ? (cells[idx] ?? '') : '';
      };
      const row = toRow(get('kind'), get('dll'), get('version'), get('refersTo') || undefined, get('path'), warnings, i + 1);
      if (row) rows.push(row);
    }
  } else {
    source = 'table';
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = (lines[i] as string).trim();
      if (line === '' || /^[-\s]+$/.test(line)) continue;
      const t = line.split(/\s+/);
      // Text around the table (a script's summary lines) is skipped; only row-like lines are reported.
      if (!/^(REFERENCER|DEPLOYED)$/i.test(t[0] as string)) {
        if (t.length >= 3 && parseAssemblyVersion(t[2])) warnings.push(`Line ${i + 1}: unknown kind "${t[0]}"; skipped.`);
        continue;
      }
      if (t.length < 3) {
        warnings.push(`Line ${i + 1}: expected Kind, Dll, Version[, RefersTo]; skipped.`);
        continue;
      }
      const row = toRow(t[0] as string, t[1] as string, t[2] as string, t[3], undefined, warnings, i + 1);
      if (row) rows.push(row);
    }
  }
  if (rows.length === 0) return null;
  const targets = [...new Set(rows.filter((r) => r.kind === 'DEPLOYED').map((r) => r.assembly))];
  if (targets.length > 1) warnings.push(`DEPLOYED rows name several assemblies (${targets.join(', ')}); using ${targets[0]}.`);
  return { source, fileName, target: targets[0], rows, warnings };
}

/** Parses the JSON array written by Export-PackageAssemblyMap.ps1. Returns null for any other JSON. */
export function parsePackageAssemblyMap(json: unknown): PackageAssemblyEntry[] | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const out: PackageAssemblyEntry[] = [];
  for (const item of json) {
    if (typeof item !== 'object' || item === null) return null;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.packageVersion !== 'string' || typeof o.assemblyVersion !== 'string') return null;
    out.push({
      id: o.id,
      packageVersion: o.packageVersion,
      dll: typeof o.dll === 'string' ? o.dll : `${o.id}.dll`,
      assemblyVersion: o.assemblyVersion,
      fileVersion: typeof o.fileVersion === 'string' ? o.fileVersion : null,
      tfm: typeof o.tfm === 'string' ? o.tfm : '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// deps.json
// ---------------------------------------------------------------------------

/** Windows RIDs the app runs under, best first. Other RIDs' assets are kept per package but not mapped. */
export const RID_PREFERENCE: readonly string[] = ['win-x64', 'win'];

/** Higher is better: win-x64 2, win 1, no RID 0, any other RID -1 (not used on Windows x64). */
export function ridRank(rid: string | null | undefined): number {
  if (!rid) return 0;
  const i = RID_PREFERENCE.indexOf(rid.toLowerCase());
  return i < 0 ? -1 : RID_PREFERENCE.length - i;
}

function splitKey(key: string): { id: string; version: string } | null {
  const i = key.indexOf('/');
  if (i <= 0 || i === key.length - 1) return null;
  return { id: key.slice(0, i), version: key.slice(i + 1) };
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function readAssets(entry: Json): DepsAsset[] {
  const assets: DepsAsset[] = [];
  const add = (path: string, value: unknown, rid?: string) => {
    if (!/\.dll$/i.test(path)) return;
    const v = isObject(value) ? value : {};
    assets.push({ path, assemblyName: fileName(path).replace(/\.dll$/i, ''), assemblyVersion: str(v.assemblyVersion), fileVersion: str(v.fileVersion), rid });
  };
  if (isObject(entry.runtime)) for (const [path, value] of Object.entries(entry.runtime)) add(path, value);
  if (isObject(entry.runtimeTargets)) {
    for (const [path, value] of Object.entries(entry.runtimeTargets)) {
      if (!isObject(value) || value.assetType !== 'runtime') continue;
      add(path, value, str(value.rid) ?? undefined);
    }
  }
  return assets;
}

/** Parses <App>.deps.json, reading targets[runtimeTarget.name]. */
export function parseDeps(json: Json, inputId: string, depsFile: string): DepsModel | { error: string } {
  const targets = json.targets as Json;
  const libraries = isObject(json.libraries) ? json.libraries : {};
  const warnings: string[] = [];
  let runtimeTarget = isObject(json.runtimeTarget) ? str(json.runtimeTarget.name) : null;
  if (!runtimeTarget) {
    const keys = Object.keys(targets);
    if (keys.length !== 1) return { error: 'deps.json has no runtimeTarget.name and more than one target.' };
    runtimeTarget = keys[0] as string;
    warnings.push(`No runtimeTarget.name; used the only target "${runtimeTarget}".`);
  }
  const target = targets[runtimeTarget];
  if (!isObject(target)) return { error: `deps.json has no target "${runtimeTarget}".` };

  // The application's own entry: named like the file (App.deps.json → App), else the first project entry.
  const baseName = depsFile.replace(/^.*[\\/]/, '').replace(/\.deps\.json$/i, '').toLowerCase();
  let appId: string | undefined;
  for (const key of Object.keys(target)) {
    const split = splitKey(key);
    if (split && split.id.toLowerCase() === baseName) appId = split.id;
  }
  if (!appId) {
    for (const key of Object.keys(target)) {
      const lib = libraries[key];
      if (isObject(lib) && lib.type === 'project') {
        appId = splitKey(key)?.id;
        break;
      }
    }
  }

  const byPackage: Record<string, DepsAsset[]> = {};
  const byAssembly: Record<string, AssemblyOwner[]> = {};
  const gaps: DepsGap[] = [];
  let libraryCount = 0;

  for (const [key, value] of Object.entries(target)) {
    const split = splitKey(key);
    if (!split || !isObject(value)) {
      warnings.push(`Unrecognized target entry "${key}".`);
      continue;
    }
    libraryCount++;
    const lib = libraries[key];
    const packageType = isObject(lib) && typeof lib.type === 'string' ? lib.type : 'package';
    const assets = readAssets(value);
    byPackage[`${split.id.toLowerCase()}/${split.version.toLowerCase()}`] = assets;

    // One owner per assembly name per package: the asset the host would pick on Windows x64.
    const best = new Map<string, DepsAsset>();
    for (const a of assets) {
      if (a.assemblyVersion === null) {
        gaps.push({ packageId: split.id, packageVersion: split.version, packageType, path: a.path, expected: split.id === appId });
      }
      if (ridRank(a.rid) < 0) continue;
      const k = a.assemblyName.toLowerCase();
      const current = best.get(k);
      if (!current || ridRank(a.rid) > ridRank(current.rid)) best.set(k, a);
    }
    for (const [k, a] of best) {
      const owners = byAssembly[k] ?? [];
      owners.push({ packageId: split.id, packageVersion: split.version, packageType, assemblyVersion: a.assemblyVersion, fileVersion: a.fileVersion, path: a.path, rid: a.rid, depsFile });
      byAssembly[k] = owners;
    }
  }

  for (const [k, owners] of Object.entries(byAssembly)) {
    if (owners.length > 1) warnings.push(`${owners.length} libraries ship ${owners[0]?.path.replace(/^.*[\\/]/, '') ?? k}: ${owners.map((o) => `${o.packageId}/${o.packageVersion}`).join(', ')}.`);
  }
  const unexpected = gaps.filter((g) => !g.expected).length;
  if (unexpected > 0) warnings.push(`${unexpected} runtime asset${unexpected === 1 ? ' has' : 's have'} no assemblyVersion; their version is unknown.`);

  return { inputId, fileName: depsFile, runtimeTarget, primary: false, appId, libraryCount, byPackage, byAssembly, gaps, warnings };
}

// ---------------------------------------------------------------------------
// Assembly manifest
// ---------------------------------------------------------------------------

function parseReference(v: unknown): AssemblyRefInfo | null {
  if (!isObject(v)) return null;
  const name = str(v.name);
  const version = str(v.version);
  if (!name || !version) return null;
  return { name, version, publicKeyToken: normalizeToken(v.publicKeyToken), culture: str(v.culture) };
}

/** Parses the manifest written by Export-AssemblyManifest.ps1 (schema 1). Unknown fields are ignored. */
export function parseManifest(json: Json, manifestFile: string): AssemblyManifest | { error: string } {
  if (json.schema !== 1) return { error: `Unsupported manifest schema ${String(json.schema)}; expected 1.` };
  const roots = Array.isArray(json.roots) ? json.roots.map((r) => (typeof r === 'string' ? r : '')) : [];
  let invalid = 0;
  const assemblies: ManifestAssembly[] = [];
  for (const a of json.assemblies as unknown[]) {
    if (!isObject(a)) {
      invalid++;
      continue;
    }
    const name = str(a.name);
    const version = str(a.version);
    const path = str(a.path) ?? (name ? `${name}.dll` : null);
    if (!name || !version || !path) {
      invalid++;
      continue;
    }
    const references: AssemblyRefInfo[] = [];
    for (const r of Array.isArray(a.references) ? a.references : []) {
      const parsed = parseReference(r);
      if (parsed) references.push(parsed);
      else invalid++;
    }
    assemblies.push({
      path,
      root: typeof a.root === 'number' && Number.isInteger(a.root) && a.root >= 0 ? a.root : 0,
      name,
      version,
      publicKeyToken: normalizeToken(a.publicKeyToken),
      fileVersion: str(a.fileVersion),
      culture: str(a.culture),
      rid: str(a.rid),
      references,
    });
  }
  const framework: FrameworkAssembly[] = [];
  for (const f of Array.isArray(json.framework) ? json.framework : []) {
    if (!isObject(f) || !str(f.name) || !str(f.version)) {
      invalid++;
      continue;
    }
    framework.push({ name: str(f.name) as string, version: str(f.version) as string, framework: str(f.framework) ?? '', publicKeyToken: normalizeToken(f.publicKeyToken) });
  }
  const frameworks: FrameworkFolder[] | undefined = Array.isArray(json.frameworks)
    ? json.frameworks.filter(isObject).map((f) => ({
        name: str(f.name) ?? '',
        requestedVersion: str(f.requestedVersion) ?? '',
        usedVersion: str(f.usedVersion),
        exact: f.exact === true,
        path: str(f.path),
      }))
    : undefined;
  const skipped = isObject(json.skipped)
    ? Object.fromEntries(Object.entries(json.skipped).filter((e): e is [string, number] => typeof e[1] === 'number'))
    : undefined;
  const manifest: AssemblyManifest = {
    schema: 1,
    generatedAt: str(json.generatedAt) ?? '',
    appName: str(json.appName) ?? undefined,
    roots,
    assemblies,
    framework,
    frameworks,
    skipped,
    source: json.source === 'dll-upload' ? 'dll-upload' : 'script',
    fileNames: [manifestFile],
  };
  if (invalid > 0) (manifest.skipped ??= {}).invalidEntries = invalid;
  return manifest;
}

/** Merges several manifests: roots are appended and root indexes shifted; framework lists are unioned by name. */
export function mergeManifests(list: AssemblyManifest[]): AssemblyManifest | undefined {
  if (list.length <= 1) return list[0];
  const [first, ...rest] = list as [AssemblyManifest, ...AssemblyManifest[]];
  const merged: AssemblyManifest = { ...first, roots: [...first.roots], assemblies: [...first.assemblies], framework: [...first.framework], frameworks: [...(first.frameworks ?? [])], fileNames: [...first.fileNames] };
  const fw = new Set(first.framework.map((f) => f.name.toLowerCase()));
  for (const m of rest) {
    const offset = merged.roots.length;
    merged.roots.push(...m.roots);
    merged.assemblies.push(...m.assemblies.map((a) => ({ ...a, root: a.root + offset })));
    for (const f of m.framework) {
      if (fw.has(f.name.toLowerCase())) continue;
      fw.add(f.name.toLowerCase());
      merged.framework.push(f);
    }
    merged.frameworks?.push(...(m.frameworks ?? []));
    merged.fileNames.push(...m.fileNames);
    if (m.source === 'dll-upload') merged.source = 'dll-upload';
  }
  return merged;
}

// ---------------------------------------------------------------------------
// runtimeconfig.json
// ---------------------------------------------------------------------------

export function parseRuntimeConfig(json: Json, configFile: string): RuntimeConfigInfo {
  const options = json.runtimeOptions as Json;
  const read = (v: unknown) => (isObject(v) && str(v.name) ? { name: str(v.name) as string, version: str(v.version) ?? '' } : null);
  const frameworks: { name: string; version: string }[] = [];
  const single = read(options.framework);
  if (single) frameworks.push(single);
  for (const f of Array.isArray(options.frameworks) ? options.frameworks : []) {
    const r = read(f);
    if (r) frameworks.push(r);
  }
  const included = Array.isArray(options.includedFrameworks) ? options.includedFrameworks.map(read).filter((x): x is { name: string; version: string } => x !== null) : [];
  return {
    fileName: configFile,
    frameworks: frameworks.length > 0 ? frameworks : included,
    rollForward: str(options.rollForward) ?? undefined,
    selfContained: included.length > 0,
  };
}
