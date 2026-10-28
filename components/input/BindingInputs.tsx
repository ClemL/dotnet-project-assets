'use client';

import { useState } from 'react';
import type { BindingInputKind, BindingResult } from '@/lib/types';
import { formatBytes, newId } from '../inputTypes';
import { btnSmall, field, h2, hint, linkBtn } from '../ui/styles';
import { FileDropzone } from './FileDropzone';

export interface BindingItem {
  id: string;
  name: string;
  file?: File;
  text?: string;
}

export const SCRIPT_URL = '/scripts/Export-AssemblyManifest.ps1';

const KIND_LABEL: Record<BindingInputKind, string> = {
  deps: 'deps.json',
  manifest: 'assembly manifest',
  runtimeconfig: 'runtimeconfig.json',
  referencer: 'REFERENCER scan',
  packageMap: 'package → assembly map',
};

export function BindingInputs({ items, onItems, result, busy }: { items: BindingItem[]; onItems: (items: BindingItem[]) => void; result: BindingResult | null; busy: boolean }) {
  const [paste, setPaste] = useState('');
  const summary = new Map((result?.inputs ?? []).map((i) => [i.inputId, i]));
  const pasteCount = items.filter((i) => i.text !== undefined).length;

  return (
    <section className="space-y-3" aria-labelledby="binding-inputs-heading">
      <div>
        <h2 id="binding-inputs-heading" className={h2}>
          Runtime binding inputs <span className="font-normal text-muted">(optional, for the Binding check tab)</span>
        </h2>
        <p className={hint}>
          <code className="font-mono">&lt;App&gt;.deps.json</code> and an assembly manifest from{' '}
          <a className={linkBtn} href={SCRIPT_URL} download>
            Export-AssemblyManifest.ps1
          </a>{' '}
          enable the tab; <code className="font-mono">&lt;App&gt;.runtimeconfig.json</code> is optional. The Fix planner also reads REFERENCER scans (table or CSV from Find-AssemblyReference.ps1) and the package →
          assembly map from Export-PackageAssemblyMap.ps1. The file type is detected from its content.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="binding-paste" className="text-sm font-medium">
            Paste JSON or a REFERENCER table
          </label>
          <textarea
            id="binding-paste"
            className={`${field} h-28 w-full font-mono text-xs`}
            placeholder="Paste deps.json, the assembly manifest, runtimeconfig.json, the package map, or a REFERENCER scan…"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            spellCheck={false}
          />
          <button
            type="button"
            className={btnSmall}
            disabled={paste.trim() === ''}
            onClick={() => {
              onItems([...items, { id: newId('bind'), name: `Pasted binding input #${pasteCount + 1}`, text: paste }]);
              setPaste('');
            }}
          >
            Add pasted input
          </button>
        </div>
        <FileDropzone id="binding-upload" title="Upload binding files" extensions={['.json', '.csv', '.txt']} onFiles={(files) => onItems([...items, ...files.map((file) => ({ id: newId('bind'), name: file.name, file }))])} />
      </div>

      {items.length > 0 ? (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              Loaded <span className="tabular text-muted">({items.length})</span> {busy ? <span className="text-xs text-muted">checking…</span> : null}
            </p>
            <button type="button" className={btnSmall} onClick={() => onItems([])}>
              Clear all
            </button>
          </div>
          <ul className="divide-y divide-line text-sm">
            {items.map((item) => {
              const s = summary.get(item.id);
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                  <span className="min-w-0 truncate font-mono text-xs" title={item.name}>
                    {item.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    {s?.kind ? <span className="rounded bg-surface-2 px-1.5 py-0.5 text-ink-2">{KIND_LABEL[s.kind]}</span> : null}
                    {s?.error ? <span className="text-danger-ink">{s.error}</span> : null}
                    {item.file ? <span className="tabular text-muted">{formatBytes(item.file.size)}</span> : null}
                    <button type="button" className={btnSmall} aria-label={`Remove ${item.name}`} onClick={() => onItems(items.filter((x) => x.id !== item.id))}>
                      Remove
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {result && result.missing.length > 0 ? (
            <p className="mt-1 text-xs text-warn-ink">Binding check also needs: {result.missing.map((k) => KIND_LABEL[k]).join(' and ')}. The Fix planner works with a REFERENCER scan alone.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
