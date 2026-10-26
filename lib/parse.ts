// assets.json validation and model building.

import { normalizeFramework, splitTargetKey } from './framework';
import { dirname, joinPath, pathKey } from './paths';
import type { DirectDep, IdKey, ParseResult, ProjectModel, TargetGraph, TargetNode } from './types';
import { normalizeVersion, parseDependencyGroupEntry } from './version';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Splits "Id/Version". Ids and versions never contain "/". */
export function splitLibraryKey(key: string): { id: string; version: string } | null {
  const i = key.indexOf('/');
  if (i <= 0 || i === key.length - 1) return null;
  return { id: key.slice(0, i), version: key.slice(i + 1) };
}

interface LibraryInfo {
  type: string;
  msbuildProject?: string;
  path?: string;
}

export interface ParseInput {
  inputId: string;
  fileName: string;
  text: string;
}

/** Validates and parses one assets.json body. Never throws. */
export function parseAssetsJson(input: ParseInput): ParseResult {
  const { inputId, fileName } = input;
  const fail = (message: string): ParseResult => ({ ok: false, error: { inputId, fileName, message } });

  const text = input.text.replace(/^﻿/, '');
  if (text.trim() === '') return fail('Input is empty.');
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return fail(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(root)) return fail('Top-level JSON value must be an object.');

  const missing: string[] = [];
  if (root.version === undefined) missing.push('version');
  if (!isObject(root.targets)) missing.push('targets');
  if (!isObject(root.libraries)) missing.push('libraries');
  const project = isObject(root.project) ? root.project : undefined;
  const restore = project && isObject(project.restore) ? project.restore : undefined;
  const projectName = restore?.projectName;
  if (typeof projectName !== 'string' || projectName.trim() === '') missing.push('project.restore.projectName');
  if (missing.length > 0) {
    return fail(`Not a project.assets.json file: missing or invalid ${missing.join(', ')}.`);
  }

  const targetsJson = root.targets as Json;
  const librariesJson = root.libraries as Json;
  const warnings: string[] = [];

  const libraries = new Map<string, LibraryInfo>();
  for (const [key, value] of Object.entries(librariesJson)) {
    if (!isObject(value)) continue;
    libraries.set(key.toLowerCase(), {
      type: typeof value.type === 'string' ? value.type : 'package',
      msbuildProject: typeof value.msbuildProject === 'string' ? value.msbuildProject : undefined,
      path: typeof value.path === 'string' ? value.path : undefined,
    });
  }

  const projectPath = typeof restore?.projectPath === 'string' ? restore.projectPath : undefined;
  const projectVersion = typeof project?.version === 'string' ? normalizeVersion(project.version) : '1.0.0';
  const sources = isObject(restore?.sources) ? Object.keys(restore.sources) : [];

  // Direct package references per normalized framework.
  const groupsJson = isObject(root.projectFileDependencyGroups) ? root.projectFileDependencyGroups : {};
  const packageRoots = new Map<string, DirectDep[]>();
  for (const [fw, entries] of Object.entries(groupsJson)) {
    if (!Array.isArray(entries)) continue;
    const deps: DirectDep[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      const parsed = parseDependencyGroupEntry(entry);
      if (!parsed) {
        warnings.push(`Could not parse projectFileDependencyGroups entry "${entry}".`);
        continue;
      }
      deps.push({ id: parsed.id, range: parsed.range, kind: 'packageReference' });
    }
    packageRoots.set(fw === '' ? '' : normalizeFramework(fw), deps);
  }
  // Fallback: project.frameworks[alias].dependencies when projectFileDependencyGroups is absent.
  const frameworksJson = project && isObject(project.frameworks) ? project.frameworks : {};
  if (packageRoots.size === 0) {
    for (const [alias, fwValue] of Object.entries(frameworksJson)) {
      if (!isObject(fwValue) || !isObject(fwValue.dependencies)) continue;
      const deps: DirectDep[] = [];
      for (const [id, dep] of Object.entries(fwValue.dependencies)) {
        const range = isObject(dep) && typeof dep.version === 'string' ? dep.version : typeof dep === 'string' ? dep : '';
        deps.push({ id, range, kind: 'packageReference' });
      }
      packageRoots.set(normalizeFramework(alias), deps);
    }
  }

  // Project references per normalized framework, as absolute path keys.
  const restoreFrameworks = restore && isObject(restore.frameworks) ? restore.frameworks : {};
  const projectRefPaths = new Map<string, string[]>();
  for (const [alias, fwValue] of Object.entries(restoreFrameworks)) {
    if (!isObject(fwValue)) continue;
    const refs = isObject(fwValue.projectReferences) ? Object.keys(fwValue.projectReferences) : [];
    projectRefPaths.set(normalizeFramework(alias), refs.map(pathKey));
  }
  const haveProjectRefInfo = projectRefPaths.size > 0;

  // Map absolute project paths to library Ids, resolving msbuildProject against this project's directory.
  const projectDir = projectPath ? dirname(projectPath) : '';
  const libraryIdByProjectPath = new Map<string, string>();
  for (const [key, info] of libraries) {
    if (info.type !== 'project') continue;
    const rel = info.msbuildProject ?? info.path;
    const split = splitLibraryKey(key);
    if (!rel || !split) continue;
    libraryIdByProjectPath.set(pathKey(joinPath(projectDir, rel)), split.id);
  }

  const targets: TargetGraph[] = [];
  const targetEntries = Object.entries(targetsJson);
  const baseFrameworks = new Set(targetEntries.map(([k]) => normalizeFramework(splitTargetKey(k).framework)));

  for (const [targetKey, targetValue] of targetEntries) {
    if (!isObject(targetValue)) {
      warnings.push(`Target "${targetKey}" is not an object; skipped.`);
      continue;
    }
    const { framework, rid } = splitTargetKey(targetKey);
    const tfm = normalizeFramework(framework);
    const nodes: Record<IdKey, TargetNode> = {};
    for (const [libKey, libValue] of Object.entries(targetValue)) {
      const split = splitLibraryKey(libKey);
      if (!split || !isObject(libValue)) {
        warnings.push(`Target "${targetKey}": unrecognized entry "${libKey}".`);
        continue;
      }
      const rawType = typeof libValue.type === 'string' ? libValue.type : libraries.get(libKey.toLowerCase())?.type ?? 'package';
      if (rawType !== 'package' && rawType !== 'project') {
        warnings.push(`Target "${targetKey}": "${libKey}" has unknown type "${rawType}"; treated as package.`);
      }
      const dependencies: Record<string, string> = {};
      if (isObject(libValue.dependencies)) {
        for (const [depId, depRange] of Object.entries(libValue.dependencies)) {
          if (typeof depRange === 'string') dependencies[depId] = depRange;
        }
      }
      const key = split.id.toLowerCase();
      const existing = nodes[key];
      if (existing) {
        warnings.push(`Target "${targetKey}": "${libKey}" duplicates "${existing.id}/${existing.version}"; kept the first.`);
        continue;
      }
      nodes[key] = {
        id: split.id,
        version: normalizeVersion(split.version),
        type: rawType === 'project' ? 'project' : 'package',
        dependencies,
      };
    }

    // Package roots: exact framework match, then the single-group fallback, then the framework-agnostic "" group.
    let pkgRoots = packageRoots.get(tfm);
    if (!pkgRoots && packageRoots.size === 1 && baseFrameworks.size === 1) {
      pkgRoots = [...packageRoots.values()][0];
    }
    if (!pkgRoots && packageRoots.size > 0 && !rid) {
      warnings.push(`No projectFileDependencyGroups entry matches target "${targetKey}".`);
    }
    const roots: DirectDep[] = [];
    const seen = new Set<IdKey>();
    for (const dep of [...(pkgRoots ?? []), ...(packageRoots.get('') ?? [])]) {
      const k = dep.id.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      // An entry that resolves to a project node is a project reference.
      roots.push(nodes[k]?.type === 'project' ? { id: nodes[k].id, range: '', kind: 'projectReference' } : dep);
    }

    // Project references.
    if (haveProjectRefInfo) {
      for (const refPath of projectRefPaths.get(tfm) ?? []) {
        const id = libraryIdByProjectPath.get(refPath);
        if (!id) {
          if (!rid) warnings.push(`Target "${targetKey}": project reference "${refPath}" has no matching library entry.`);
          continue;
        }
        const k = id.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        roots.push({ id: nodes[k]?.id ?? id, range: '', kind: 'projectReference' });
      }
    } else {
      // No restore metadata: treat project nodes nobody depends on as direct references.
      const dependedOn = new Set<IdKey>();
      for (const n of Object.values(nodes)) for (const d of Object.keys(n.dependencies)) dependedOn.add(d.toLowerCase());
      for (const [k, n] of Object.entries(nodes)) {
        if (n.type === 'project' && !dependedOn.has(k) && !seen.has(k)) {
          seen.add(k);
          roots.push({ id: n.id, range: '', kind: 'projectReference' });
        }
      }
    }

    targets.push({ key: targetKey, tfm, rid, nodes, roots });
  }

  if (targets.length === 0) warnings.push('The file contains no targets.');

  const name = (projectName as string).trim();
  const model: ProjectModel = {
    inputId,
    fileName,
    projectName: name,
    label: name,
    projectPath,
    projectVersion,
    sources,
    targets,
    warnings,
  };
  return { ok: true, model };
}

/** Assigns unique labels; files sharing a projectName are disambiguated with their file name. */
export function assignLabels(models: ProjectModel[]): ProjectModel[] {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.projectName.toLowerCase(), (counts.get(m.projectName.toLowerCase()) ?? 0) + 1);
  return models.map((m) => ({
    ...m,
    label: (counts.get(m.projectName.toLowerCase()) ?? 0) > 1 ? `${m.projectName} [${m.fileName}]` : m.projectName,
  }));
}
