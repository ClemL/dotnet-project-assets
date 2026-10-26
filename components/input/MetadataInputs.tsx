'use client';

import { useMemo, useState } from 'react';
import { acceptMetadataFile, fromFileList, pickDirectory, walkPackagesFolder, type PickedFile, type PickResult } from '@/client/fileSources';
import type { Progress } from '@/client/workerClient';
import { metadataKey, parseNupkgMetadata, parseSourceMap } from '@/lib/metadata';
import type { ClassifyOutput, PackageRef, SourceMap } from '@/lib/types';
import type { MetadataLoadResult } from '@/workers/protocol';
import { Banner } from '../ui/Banner';
import { ProgressBar } from '../ui/ProgressBar';
import { btn, btnPrimary, btnSmall, field, h2, hint, linkBtn } from '../ui/styles';
import { FolderSummary, useDirectoryInput } from './AssetsFolderPicker';
import { SOURCE_MAP_SCRIPT } from './sourceMapScript';

export interface MetadataSources {
  folder: SourceMap;
  single: SourceMap;
  bundled: SourceMap;
}

export const EMPTY_METADATA: MetadataSources = { folder: {}, single: {}, bundled: {} };

export function MetadataInputs({
  packages,
  coverage,
  sources,
  onChange,
  loadFolder,
}: {
  packages: PackageRef[] | undefined;
  coverage: ClassifyOutput['coverage'] | undefined;
  sources: MetadataSources;
  onChange: (next: MetadataSources) => void;
  loadFolder: (files: PickedFile[], onProgress: (p: Progress) => void) => Promise<MetadataLoadResult>;
}) {
  // (a) packages folder
  const { inputRef, hasPicker } = useDirectoryInput();
  const [folderPick, setFolderPick] = useState<PickResult | null>(null);
  const [folderScan, setFolderScan] = useState<string | null>(null);
  const [folderProgress, setFolderProgress] = useState<Progress | null>(null);
  const [folderResult, setFolderResult] = useState<string | null>(null);

  // (b) single file
  const [singleText, setSingleText] = useState('');
  const [singleTarget, setSingleTarget] = useState('');
  const [singleMsg, setSingleMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // (c) bundled map
  const [bundledMsg, setBundledMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [error, setError] = useState<string | null>(null);

  const packageOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of packages ?? []) if (p.types.includes('package') && !p.isRootProject) map.set(`${p.id}/${p.version}`.toLowerCase(), `${p.id}/${p.version}`);
    return map;
  }, [packages]);

  const chooseFolder = async () => {
    setError(null);
    setFolderResult(null);
    if (!hasPicker) {
      inputRef.current?.click();
      return;
    }
    try {
      const handle = await pickDirectory('assets-graph-packages');
      if (!handle) return;
      setFolderScan('Scanning…');
      setFolderPick(await walkPackagesFolder(handle, (folders, matched) => setFolderScan(`Scanning… ${folders} version folders, ${matched} metadata files`)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFolderScan(null);
    }
  };

  const applyFolder = async () => {
    if (!folderPick) return;
    const files = folderPick.matched;
    setFolderPick(null);
    setFolderProgress({ stage: 'Reading metadata', done: 0, total: files.length });
    try {
      const r = await loadFolder(files, setFolderProgress);
      onChange({ ...sources, folder: r.map });
      setFolderResult(`Loaded ${r.loaded} metadata files${r.errors.length ? `; ${r.errors.length} rejected (first: ${r.errors[0]?.relPath}: ${r.errors[0]?.message})` : ''}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFolderProgress(null);
    }
  };

  const applySingle = () => {
    const parsed = parseNupkgMetadata(singleText);
    if (!parsed.ok) {
      setSingleMsg({ ok: false, text: parsed.error });
      return;
    }
    const chosen = packageOptions.get(singleTarget.trim().toLowerCase());
    if (!chosen) {
      setSingleMsg({ ok: false, text: 'Pick a package from the list. A .nupkg.metadata file does not name its package.' });
      return;
    }
    const slash = chosen.indexOf('/');
    onChange({ ...sources, single: { ...sources.single, [metadataKey(chosen.slice(0, slash), chosen.slice(slash + 1))]: parsed.source } });
    setSingleMsg({ ok: true, text: `${chosen} → ${parsed.source}` });
    setSingleText('');
    setSingleTarget('');
  };

  const counts = { folder: Object.keys(sources.folder).length, single: Object.keys(sources.single).length, bundled: Object.keys(sources.bundled).length };
  const anyMetadata = counts.folder + counts.single + counts.bundled > 0;

  return (
    <section className="space-y-4" aria-labelledby="metadata-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="metadata-heading" className={h2}>
            Package source metadata <span className="font-normal text-muted">(optional)</span>
          </h2>
          <p className={hint}>
            NuGet records the feed each package came from in <code className="font-mono">.nupkg.metadata</code>. When present, it outranks the nuget.org lookup but not manual overrides.
          </p>
        </div>
        {anyMetadata ? (
          <button type="button" className={btnSmall} onClick={() => onChange({ folder: {}, single: {}, bundled: {} })}>
            Clear metadata
          </button>
        ) : null}
      </div>

      <p className="text-sm">
        {coverage ? (
          <>
            <strong className="tabular">{coverage.withMetadata}</strong> of <strong className="tabular">{coverage.total}</strong> packages have source metadata.
          </>
        ) : (
          <span className="text-muted">Coverage appears after analysis.</span>
        )}{' '}
        <span className="text-muted">
          Loaded entries: folder {counts.folder}, single files {counts.single}, bundled map {counts.bundled}.
        </span>
      </p>

      {error ? <Banner tone="danger" title={error} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">a. Packages folder</h3>
          <p className={hint}>
            Pick <code className="font-mono">%UserProfile%\.nuget\packages</code>. Only <code className="font-mono">&lt;id&gt;/&lt;version&gt;/.nupkg.metadata</code> is read.
          </p>
          <button type="button" className={btn} onClick={chooseFolder} disabled={folderScan !== null || folderProgress !== null}>
            Choose packages folder…
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) setFolderPick(fromFileList(e.target.files, acceptMetadataFile));
              e.target.value = '';
            }}
          />
          {folderScan ? <p className="text-sm text-ink-2">{folderScan}</p> : null}
          {folderPick ? (
            <FolderSummary result={folderPick} noun=".nupkg.metadata files" addLabel={`Apply ${folderPick.matched.length} files`} onAdd={applyFolder} onDiscard={() => setFolderPick(null)} />
          ) : null}
          {folderProgress ? <ProgressBar label={folderProgress.stage} done={folderProgress.done} total={folderProgress.total} /> : null}
          {folderResult ? <p className="text-sm text-ok">{folderResult}</p> : null}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">b. Single .nupkg.metadata</h3>
          <p className={hint}>The file does not name its package, so pick which one it belongs to.</p>
          <input
            type="file"
            className="block w-full text-xs file:mr-2 file:rounded file:border file:border-line-strong file:bg-surface file:px-2 file:py-1"
            aria-label="Load a .nupkg.metadata file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setSingleText(await f.text());
              e.target.value = '';
            }}
          />
          <textarea
            className={`${field} h-20 w-full font-mono text-xs`}
            placeholder='{ "version": 2, "contentHash": "…", "source": "https://…/index.json" }'
            value={singleText}
            onChange={(e) => setSingleText(e.target.value)}
            aria-label=".nupkg.metadata contents"
          />
          <input
            className={`${field} w-full`}
            list="assets-graph-packages"
            placeholder={packages ? 'Package Id/Version…' : 'Analyze files first'}
            disabled={!packages}
            value={singleTarget}
            onChange={(e) => setSingleTarget(e.target.value)}
            aria-label="Package this metadata belongs to"
          />
          <datalist id="assets-graph-packages">
            {[...packageOptions.values()].map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <button type="button" className={btnPrimary} onClick={applySingle} disabled={!packages || !singleText.trim() || !singleTarget.trim()}>
            Apply
          </button>
          {singleMsg ? <p className={`text-sm ${singleMsg.ok ? 'text-ok' : 'text-danger-ink'}`}>{singleMsg.text}</p> : null}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">c. Bundled map</h3>
          <p className={hint}>
            JSON shaped <code className="font-mono">{'{ "<id-lowercase>/<version>": "<source>" }'}</code>, generated by the PowerShell script below.
          </p>
          <input
            type="file"
            accept=".json,application/json"
            className="block w-full text-xs file:mr-2 file:rounded file:border file:border-line-strong file:bg-surface file:px-2 file:py-1"
            aria-label="Load a bundled source map"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const r = parseSourceMap(await f.text());
              if (!r.ok) {
                setBundledMsg({ ok: false, text: r.error });
                return;
              }
              onChange({ ...sources, bundled: r.map });
              setBundledMsg({ ok: true, text: `Loaded ${Object.keys(r.map).length} entries${r.invalid ? `; skipped ${r.invalid} invalid` : ''}.` });
            }}
          />
          {bundledMsg ? <p className={`text-sm ${bundledMsg.ok ? 'text-ok' : 'text-danger-ink'}`}>{bundledMsg.text}</p> : null}
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-2">PowerShell script (Export-NuGetSourceMap.ps1)</summary>
            <div className="mt-2 space-y-2">
              <p className={hint}>
                Reads every <code className="font-mono">.nupkg.metadata</code> under your global packages folder and writes{' '}
                <code className="font-mono">results\NuGetSourceMap_yyyyMMdd_HHmm.json</code>. Defaults: <code className="font-mono">-PackagesPath</code> = <code className="font-mono">$env:NUGET_PACKAGES</code> or{' '}
                <code className="font-mono">%UserProfile%\.nuget\packages</code>, <code className="font-mono">-OutputFolder .\results</code>, <code className="font-mono">-IdFilter *</code>. Also in the repo at{' '}
                <code className="font-mono">scripts/Export-NuGetSourceMap.ps1</code>.
              </p>
              <button type="button" className={linkBtn} onClick={() => void navigator.clipboard?.writeText(SOURCE_MAP_SCRIPT)}>
                Copy script
              </button>
              <pre className="max-h-64 overflow-auto rounded border border-line bg-surface-2 p-2 font-mono text-[11px] leading-snug">{SOURCE_MAP_SCRIPT}</pre>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
