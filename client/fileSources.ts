// Folder and file selection: FileList (webkitdirectory) filtering and File System Access API walking.

import { mapWithConcurrency } from '../lib/concurrency';
import { parsePackagesFolderPath } from '../lib/metadata';
import { isIgnoredDir, isProjectAssetsPath } from '../lib/paths';

export interface PickedFile {
  file: File;
  relPath: string;
}

export interface PickResult {
  matched: PickedFile[];
  /** Files (FileList) or directories (directory walk) examined. */
  scanned: number;
  scannedUnit: 'files' | 'folders';
}

export function relativePath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel.length > 0 ? rel : file.name;
}

export function fromFileList(files: FileList | readonly File[], accept: (relPath: string) => boolean): PickResult {
  const matched: PickedFile[] = [];
  const list = Array.from(files);
  for (const file of list) {
    const relPath = relativePath(file);
    if (accept(relPath)) matched.push({ file, relPath });
  }
  return { matched, scanned: list.length, scannedUnit: 'files' };
}

export const acceptAssetsFile = isProjectAssetsPath;
export const acceptMetadataFile = (relPath: string) => parsePackagesFolderPath(relPath) !== null;

// Minimal File System Access API types (not in TypeScript's DOM lib).
interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}
export interface FsDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FsFileHandle | FsDirHandle>;
  getFileHandle(name: string): Promise<FsFileHandle>;
  getDirectoryHandle(name: string): Promise<FsDirHandle>;
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Opens the directory picker; null when the user cancels. */
export async function pickDirectory(id: string): Promise<FsDirHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker: (o: { id?: string; mode?: 'read' }) => Promise<FsDirHandle> }).showDirectoryPicker;
  try {
    return await picker({ id, mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

async function tryFile(dir: FsDirHandle, name: string): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

/**
 * Walks a source tree for obj/project.assets.json, never entering ignored folders
 * (node_modules, bin, .vs, .git) and never descending below obj.
 */
export async function walkForAssets(root: FsDirHandle, onProgress?: (folders: number, matched: number) => void, signal?: AbortSignal): Promise<PickResult> {
  const matched: PickedFile[] = [];
  let folders = 0;
  const stack: { dir: FsDirHandle; path: string }[] = [{ dir: root, path: root.name }];
  while (stack.length > 0) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { dir, path } = stack.pop() as { dir: FsDirHandle; path: string };
    folders++;
    if (folders % 200 === 0) onProgress?.(folders, matched.length);
    for await (const entry of dir.values()) {
      if (entry.kind !== 'directory' || isIgnoredDir(entry.name)) continue;
      const childPath = `${path}/${entry.name}`;
      if (entry.name.toLowerCase() === 'obj') {
        const file = await tryFile(entry, 'project.assets.json');
        if (file) matched.push({ file, relPath: `${childPath}/project.assets.json` });
        continue;
      }
      stack.push({ dir: entry, path: childPath });
    }
  }
  onProgress?.(folders, matched.length);
  matched.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { matched, scanned: folders, scannedUnit: 'folders' };
}

/**
 * Walks a NuGet global packages folder (<id>/<version>/.nupkg.metadata), reading only the
 * metadata file of each version folder. Picking the parent ".nuget" folder also works.
 */
export async function walkPackagesFolder(root: FsDirHandle, onProgress?: (folders: number, matched: number) => void, signal?: AbortSignal): Promise<PickResult> {
  let base = root;
  let basePath = root.name;
  if (root.name.toLowerCase() === '.nuget') {
    try {
      base = await root.getDirectoryHandle('packages');
      basePath = `${root.name}/packages`;
    } catch {
      // not a .nuget folder after all
    }
  }
  const idDirs: FsDirHandle[] = [];
  for await (const entry of base.values()) if (entry.kind === 'directory') idDirs.push(entry);

  const matched: PickedFile[] = [];
  let folders = 0;
  await mapWithConcurrency(
    idDirs,
    16,
    async (idDir) => {
      for await (const versionDir of idDir.values()) {
        if (versionDir.kind !== 'directory') continue;
        folders++;
        const file = await tryFile(versionDir, '.nupkg.metadata');
        if (file) matched.push({ file, relPath: `${basePath}/${idDir.name}/${versionDir.name}/.nupkg.metadata` });
      }
      if (folders % 100 < 16) onProgress?.(folders, matched.length);
    },
    signal,
  );
  onProgress?.(folders, matched.length);
  matched.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { matched, scanned: folders, scannedUnit: 'folders' };
}
