'use client';

import { useEffect, useRef, useState } from 'react';
import { acceptAssetsFile, fromFileList, pickDirectory, supportsDirectoryPicker, walkForAssets, type PickedFile, type PickResult } from '@/client/fileSources';
import { IGNORED_DIRS } from '@/lib/paths';
import { formatBytes } from '../inputTypes';
import { btn, btnPrimary, btnSmall, h2, hint, linkBtn } from '../ui/styles';

/**
 * A hidden <input webkitdirectory> plus feature detection for showDirectoryPicker. Detection runs
 * after mount so the static HTML and the first client render agree.
 */
export function useDirectoryInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasPicker, setHasPicker] = useState(false);
  useEffect(() => {
    // webkitdirectory is non-standard and not in React's attribute types.
    inputRef.current?.setAttribute('webkitdirectory', '');
    setHasPicker(supportsDirectoryPicker());
  }, []);
  return { inputRef, hasPicker };
}

export function FolderSummary({ result, noun, onAdd, onDiscard, addLabel }: { result: PickResult; noun: string; onAdd: () => void; onDiscard: () => void; addLabel: string }) {
  const total = result.matched.reduce((n, m) => n + m.file.size, 0);
  return (
    <div className="space-y-2 rounded-md border border-line bg-surface-2 p-3 text-sm">
      <p>
        Found <strong className="tabular">{result.matched.length}</strong> {noun} ({formatBytes(total)}), scanned <span className="tabular">{result.scanned}</span> {result.scannedUnit}.
      </p>
      {result.matched.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-ink-2">Show matched paths</summary>
          <ul className="mt-1 max-h-48 overflow-auto font-mono text-xs">
            {result.matched.slice(0, 500).map((m) => (
              <li key={m.relPath} className="truncate">
                {m.relPath}
              </li>
            ))}
            {result.matched.length > 500 ? <li className="text-muted">… and {result.matched.length - 500} more</li> : null}
          </ul>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} disabled={result.matched.length === 0} onClick={onAdd}>
          {addLabel}
        </button>
        <button type="button" className={btnSmall} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

export function AssetsFolderPicker({ onAdd }: { onAdd: (files: PickedFile[]) => void }) {
  const [result, setResult] = useState<PickResult | null>(null);
  const [scanning, setScanning] = useState<{ folders: number; matched: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { inputRef, hasPicker } = useDirectoryInput();

  const choose = async () => {
    setError(null);
    if (!hasPicker) {
      inputRef.current?.click();
      return;
    }
    try {
      const handle = await pickDirectory('assets-graph-source');
      if (!handle) return;
      setScanning({ folders: 0, matched: 0 });
      setResult(await walkForAssets(handle, (folders, matched) => setScanning({ folders, matched })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(null);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="folder-heading">
      <div>
        <h2 id="folder-heading" className={h2}>
          Scan a folder
        </h2>
        <p className={hint}>
          Pick a source root such as <code className="font-mono">C:\dev\git</code>. Only <code className="font-mono">**/obj/project.assets.json</code> is kept; {IGNORED_DIRS.join(', ')} are skipped.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={choose} disabled={scanning !== null}>
          Choose folder…
        </button>
        {hasPicker ? (
          <button type="button" className={`${linkBtn} text-xs`} onClick={() => inputRef.current?.click()}>
            Use the browser&apos;s folder upload instead
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) setResult(fromFileList(e.target.files, acceptAssetsFile));
            e.target.value = '';
          }}
        />
      </div>
      {!hasPicker ? (
        <p className={hint}>
          This browser lists every file under the folder (including node_modules) before the app can filter them, and may ask to confirm an &quot;upload&quot;. Nothing leaves your machine. Edge and Chrome skip ignored folders.
        </p>
      ) : null}
      {scanning ? (
        <p className="text-sm text-ink-2" aria-live="polite">
          Scanning… {scanning.folders} folders, {scanning.matched} matches
        </p>
      ) : null}
      {error ? <p className="text-sm text-danger-ink">{error}</p> : null}
      {result ? (
        <FolderSummary
          result={result}
          noun="project.assets.json files"
          addLabel={`Add ${result.matched.length} files`}
          onAdd={() => {
            onAdd(result.matched);
            setResult(null);
          }}
          onDiscard={() => setResult(null)}
        />
      ) : null}
    </section>
  );
}
