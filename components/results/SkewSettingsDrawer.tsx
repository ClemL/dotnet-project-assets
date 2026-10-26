'use client';

import { useEffect, useRef } from 'react';
import { DEFAULT_SKEW_SETTINGS } from '@/lib/skew';
import type { RebuildSeverity, SkewSettings } from '@/lib/types';
import { compileBuildPattern, extractBuildNumber } from '@/lib/versions';
import { btn, btnSmall, field, h2, hint } from '../ui/styles';

const SAMPLES = ['10.0.0-13243', '1.0.0-beta.11541', '1.2.3'];

export function SkewSettingsDrawer({ open, onClose, settings, onSettings }: { open: boolean; onClose: () => void; settings: SkewSettings; onSettings: (s: SkewSettings) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const compiled = compileBuildPattern(settings.buildNumberPattern);
  const t = settings.thresholds;
  const thresholdError = !(t.low >= 0 && t.medium >= t.low && t.high >= t.medium) ? 'Thresholds must satisfy low ≤ medium ≤ high.' : null;
  const setThreshold = (key: keyof SkewSettings['thresholds'], value: string) => {
    const n = Math.max(0, Math.floor(Number(value)));
    if (Number.isFinite(n)) onSettings({ ...settings, thresholds: { ...t, [key]: n } });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close settings" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-labelledby="skew-settings-title" className="relative flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-line bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="skew-settings-title" className={h2}>
            Version skew settings
          </h2>
          <button ref={closeRef} type="button" className={btnSmall} onClick={onClose}>
            Close
          </button>
        </div>
        <p className={hint}>Saved in this browser.</p>

        <div className="space-y-1">
          <label htmlFor="skew-pattern" className="text-sm font-medium">
            Build-number pattern (regex)
          </label>
          <input id="skew-pattern" className={`${field} w-full font-mono text-xs`} value={settings.buildNumberPattern} onChange={(e) => onSettings({ ...settings, buildNumberPattern: e.target.value })} spellCheck={false} />
          {compiled.ok ? (
            <ul className="text-xs text-ink-2">
              {SAMPLES.map((s) => (
                <li key={s}>
                  <span className="font-mono">{s}</span> → {extractBuildNumber(s, compiled.re) ?? 'no build number'}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-danger-ink">{compiled.error} The default pattern is used until this is fixed.</p>
          )}
          <p className={hint}>Matched against the normalized version; capture group 1 is the build number. Lag is computed only when both versions share major.minor.patch.</p>
        </div>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Severity thresholds (spread or lag in builds)</legend>
          <div className="grid grid-cols-3 gap-2">
            {(['low', 'medium', 'high'] as const).map((k) => (
              <label key={k} className="flex flex-col gap-0.5 text-xs text-ink-2">
                {k} ≥
                <input type="number" min={0} className={`${field} tabular`} value={t[k]} onChange={(e) => setThreshold(k, e.target.value)} />
              </label>
            ))}
          </div>
          {thresholdError ? <p className="text-xs text-danger-ink">{thresholdError}</p> : null}
          <p className={hint}>A major-version difference is always high, a minor difference medium, and a patch or prerelease-label difference low.</p>
        </fieldset>

        <label className="flex flex-col gap-1 text-sm font-medium">
          Minimum severity for the rebuild set
          <select className={field} value={settings.rebuildMinSeverity} onChange={(e) => onSettings({ ...settings, rebuildMinSeverity: e.target.value as RebuildSeverity })}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={settings.cascade} onChange={(e) => onSettings({ ...settings, cascade: e.target.checked })} />
          <span>
            Cascade to consumers
            <span className="block text-xs text-ink-2">A republished package gets a new version, so its internal consumers are rebuilt too.</span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={settings.includePublic} onChange={(e) => onSettings({ ...settings, includePublic: e.target.checked })} />
          <span>
            Include public and system packages
            <span className="block text-xs text-ink-2">Same edge analysis with SemVer distance only, in a separate table.</span>
          </span>
        </label>

        <div className="mt-auto">
          <button type="button" className={btn} onClick={() => onSettings(DEFAULT_SKEW_SETTINGS)}>
            Reset to defaults
          </button>
        </div>
      </aside>
    </div>
  );
}
