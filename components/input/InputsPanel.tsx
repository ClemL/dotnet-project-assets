'use client';

import type { PickedFile } from '@/client/fileSources';
import type { Progress } from '@/client/workerClient';
import type { AnalysisResult } from '@/lib/types';
import { Banner } from '../ui/Banner';
import { ProgressBar } from '../ui/ProgressBar';
import { btnPrimary, btnSmall, card, h2 } from '../ui/styles';
import { formatBytes, newId, type FileItem, type PasteSlot } from '../inputTypes';
import { AssetsFolderPicker } from './AssetsFolderPicker';
import { FileDropzone } from './FileDropzone';
import { PasteInputs } from './PasteInputs';

export function InputsPanel({
  pastes,
  onPastes,
  files,
  onFiles,
  includeRid,
  onIncludeRid,
  analyzing,
  progress,
  onAnalyze,
  analysis,
  error,
}: {
  pastes: PasteSlot[];
  onPastes: (slots: PasteSlot[]) => void;
  files: FileItem[];
  onFiles: (files: FileItem[]) => void;
  includeRid: boolean;
  onIncludeRid: (value: boolean) => void;
  analyzing: boolean;
  progress: Progress | null;
  onAnalyze: () => void;
  analysis: AnalysisResult | null;
  error: string | null;
}) {
  const inputCount = pastes.filter((p) => p.text.trim()).length + files.length;
  const addFiles = (incoming: FileItem[]) => {
    const seen = new Set(files.map((f) => `${f.name}\u0000${f.file.size}\u0000${f.file.lastModified}`));
    onFiles([...files, ...incoming.filter((f) => !seen.has(`${f.name}\u0000${f.file.size}\u0000${f.file.lastModified}`))]);
  };
  const ridMismatch = analysis !== null && analysis.options.includeRidTargets !== includeRid;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className={card}>
          <PasteInputs slots={pastes} onChange={onPastes} />
        </div>
        <div className={card}>
          <FileDropzone onFiles={(list) => addFiles(list.map((file) => ({ id: newId('file'), file, name: file.name, kind: 'file' })))} />
        </div>
        <div className={card}>
          <AssetsFolderPicker onAdd={(picked: PickedFile[]) => addFiles(picked.map((p) => ({ id: newId('dir'), file: p.file, name: p.relPath, kind: 'folder' })))} />
        </div>
      </div>

      {files.length > 0 ? (
        <div className={card}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className={h2}>
              Files <span className="tabular font-normal text-muted">({files.length})</span>
            </h2>
            <button type="button" className={btnSmall} onClick={() => onFiles([])}>
              Clear all
            </button>
          </div>
          <ul className="max-h-56 divide-y divide-line overflow-auto text-sm">
            {files.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-2 py-1">
                <span className="min-w-0 truncate font-mono text-xs" title={f.name}>
                  {f.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular text-xs text-muted">{formatBytes(f.file.size)}</span>
                  <button type="button" className={btnSmall} aria-label={`Remove ${f.name}`} onClick={() => onFiles(files.filter((x) => x.id !== f.id))}>
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnPrimary} disabled={analyzing || inputCount === 0} onClick={onAnalyze}>
            {analyzing ? 'Analyzing…' : `Analyze ${inputCount} input${inputCount === 1 ? '' : 's'}`}
          </button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeRid} onChange={(e) => onIncludeRid(e.target.checked)} />
            Include runtime-specific targets (e.g. net8.0/win-x64)
          </label>
          {ridMismatch ? <span className="text-xs text-warn-ink">Re-analyze to apply.</span> : null}
        </div>
        {progress ? <ProgressBar label={progress.stage} done={progress.done} total={progress.total} detail={progress.detail} /> : null}
        {error ? <Banner tone="danger" title="Analysis failed">{error}</Banner> : null}
        {analysis ? <AnalysisSummary analysis={analysis} /> : null}
      </div>
    </div>
  );
}

function AnalysisSummary({ analysis }: { analysis: AnalysisResult }) {
  const warned = analysis.models.filter((m) => m.warnings.length > 0);
  return (
    <div className="space-y-2 text-sm">
      <p>
        Parsed <strong className="tabular">{analysis.models.length}</strong> file{analysis.models.length === 1 ? '' : 's'}
        {analysis.errors.length > 0 ? (
          <>
            , <strong className="tabular text-danger-ink">{analysis.errors.length}</strong> failed
          </>
        ) : null}
        . {analysis.merged.rows.length} distinct dependencies across {analysis.models.reduce((n, m) => n + m.targets.length, 0)} targets.
      </p>
      {analysis.errors.length > 0 ? (
        <Banner tone="danger" title={`${analysis.errors.length} input${analysis.errors.length === 1 ? '' : 's'} could not be parsed`}>
          <ul className="list-disc space-y-0.5 pl-5">
            {analysis.errors.map((e) => (
              <li key={e.inputId}>
                <span className="font-mono text-xs">{e.fileName}</span>: {e.message}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {warned.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-warn-ink">
            Warnings in {warned.length} file{warned.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {warned.flatMap((m) =>
              m.warnings.map((w, i) => (
                <li key={`${m.inputId}-${i}`}>
                  <strong>{m.label}</strong>: {w}
                </li>
              )),
            )}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
