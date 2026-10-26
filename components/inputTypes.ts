export interface PasteSlot {
  id: string;
  text: string;
}

export interface FileItem {
  id: string;
  file: File;
  /** Display name: the relative path for folder picks, the file name otherwise. */
  name: string;
  kind: 'file' | 'folder';
}

let counter = 0;
export function newId(prefix = 'in'): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
