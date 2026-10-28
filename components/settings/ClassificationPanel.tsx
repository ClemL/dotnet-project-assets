'use client';

import { DEFAULT_SYSTEM_PREFIXES, ORIGIN_LABELS } from '@/lib/classify';
import { ORIGINS, type AnalysisResult, type ClassifyOutput, type ClassifySettings, type IdKey, type NugetLookup, type Origin } from '@/lib/types';
import type { LookupStatus } from '../hooks/useNugetLookups';
import { Banner } from '../ui/Banner';
import { ChipListEditor } from '../ui/ChipListEditor';
import { OriginBadge } from '../ui/OriginBadge';
import { ProgressBar } from '../ui/ProgressBar';
import { btn, btnPrimary, btnSmall, card, field, h2, hint } from '../ui/styles';

export function ProxyBanner({ warning, trust, onTrust }: { warning: NonNullable<ClassifyOutput['proxyWarning']>; trust: boolean; onTrust: (v: boolean) => void }) {
  return (
    <Banner tone="warn" title="Your internal feed appears to proxy nuget.org">
      <p>
        All {warning.publicLookingCount} public-looking packages with source metadata report <code className="break-all font-mono text-xs">{warning.feed}</code>. The feed serves nuget.org packages as an upstream, so source metadata cannot
        tell internal packages from public ones. The prefix and nuget.org lookup rules decide instead
        {warning.ignored ? ', and metadata from this feed is being ignored.' : '.'}
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={trust} onChange={(e) => onTrust(e.target.checked)} />
        Trust this feed&apos;s metadata anyway
      </label>
    </Banner>
  );
}

export function ClassificationPanel({
  settings,
  onSettings,
  analysis,
  classification,
  lookups,
  lookupStatus,
  onRunLookups,
  onCancelLookups,
  onClearLookupCache,
  overrides,
  onOverrides,
  onFeedRemoved,
}: {
  settings: ClassifySettings;
  onSettings: (s: ClassifySettings) => void;
  analysis: AnalysisResult | null;
  classification: ClassifyOutput | undefined;
  lookups: Record<IdKey, NugetLookup>;
  lookupStatus: LookupStatus | null;
  onRunLookups: (ids: IdKey[]) => void;
  onCancelLookups: () => void;
  onClearLookupCache: () => void;
  overrides: Record<IdKey, Origin>;
  onOverrides: (o: Record<IdKey, Origin>) => void;
  onFeedRemoved: (feed: string) => void;
}) {
  const candidates = classification?.lookupCandidates ?? [];
  const pending = candidates.filter((id) => {
    const l = lookups[id];
    return !l || l.status === 'error';
  });
  const resolved = candidates.length - pending.length;
  const running = lookupStatus?.running === true;

  const counts = new Map<Origin, number>();
  if (classification && analysis) {
    for (const row of analysis.merged.rows) {
      const o = classification.byId[row.key]?.origin;
      if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
    }
  }
  const prefixSuggestions = (analysis?.suggestions.internalPrefixes ?? []).map((s) => ({ value: s.prefix, note: `${s.count} project${s.count === 1 ? '' : 's'}` }));
  const feedSuggestions = (analysis?.suggestions.internalFeeds ?? []).map((f) => ({ value: f, note: 'restore source' }));
  const spellings = new Map<IdKey, string>();
  for (const p of analysis?.packages ?? []) if (!spellings.has(p.key)) spellings.set(p.key, p.id);

  return (
    <div className="space-y-4">
      {classification?.proxyWarning ? <ProxyBanner warning={classification.proxyWarning} trust={settings.trustProxyFeedMetadata} onTrust={(v) => onSettings({ ...settings, trustProxyFeedMetadata: v })} /> : null}

      <div className={`${card} space-y-2`}>
        <h2 className={h2}>How origins are decided</h2>
        <ol className="list-decimal space-y-0.5 pl-5 text-sm text-ink-2">
          <li>Manual override</li>
          <li>Source metadata for the exact Id + version (nuget.org → Public/System, internal feed → Private; local paths fall through)</li>
          <li>
            <code className="font-mono">type: project</code> → Project
          </li>
          <li>System prefix → System</li>
          <li>Internal prefix → Private</li>
          <li>
            Package signature: a <code className="font-mono">.signature.p7s</code> in the assets file&apos;s file list → Public (nuget.org repository-signs every package); none → Private (inferred), since internal feeds serve unsigned packages. An author-signed internal package also has the file; give it an internal prefix or an override
          </li>
          <li>nuget.org lookup: version listed → Public; 404 or version not listed → Private (inferred). Offline → Unclassified</li>
        </ol>
        {counts.size > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
            {ORIGINS.filter((o) => counts.has(o)).map((o) => (
              <span key={o} className="flex items-center gap-1.5 text-sm">
                <OriginBadge origin={o} /> <span className="tabular text-ink-2">{counts.get(o)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className={h2}>nuget.org lookups</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.offline} onChange={(e) => onSettings({ ...settings, offline: e.target.checked })} />
          Offline mode: prefix rules only, no network requests. Unknown packages become Unclassified.
        </label>
        <p className={hint}>
          A lookup sends only the package Id to <code className="font-mono">api.nuget.org/v3-flatcontainer/&lt;id&gt;/index.json</code> (8 at a time). Results are cached in this browser for 7 days. Add internal prefixes first so
          internal Ids are never sent.
        </p>
        {analysis ? (
          <p className="text-sm">
            <span className="tabular">{candidates.length}</span> Ids are not decided by an earlier rule: <span className="tabular">{resolved}</span> resolved (cached or looked up), <span className="tabular">{pending.length}</span> pending.
          </p>
        ) : (
          <p className="text-sm text-muted">Analyze files to see which packages need a lookup.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnPrimary} disabled={settings.offline || pending.length === 0 || running} onClick={() => onRunLookups(pending)}>
            Look up {pending.length} package{pending.length === 1 ? '' : 's'} on nuget.org
          </button>
          {running ? (
            <button type="button" className={btn} onClick={onCancelLookups}>
              Cancel
            </button>
          ) : null}
          <button type="button" className={btnSmall} onClick={onClearLookupCache} disabled={running}>
            Clear lookup cache
          </button>
        </div>
        {pending.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-2">Ids that would be sent ({pending.length})</summary>
            <p className="mt-1 max-h-40 overflow-auto break-words font-mono text-xs text-ink-2">{pending.map((k) => spellings.get(k) ?? k).join(', ')}</p>
          </details>
        ) : null}
        {lookupStatus ? (
          lookupStatus.running ? (
            <ProgressBar label="Looking up on nuget.org" done={lookupStatus.done} total={lookupStatus.total} />
          ) : (
            <p className="text-sm text-ink-2">
              Last run: {lookupStatus.done} of {lookupStatus.total} resolved{lookupStatus.errors ? `, ${lookupStatus.errors} failed (shown as Unclassified; retry later)` : ''}
              {lookupStatus.cancelled ? ', cancelled' : ''}.
            </p>
          )
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className={`${card} space-y-2`}>
          <h2 className={h2}>System prefixes</h2>
          <p className={hint}>Case-insensitive prefix match → System.</p>
          <ChipListEditor
            label="System prefixes"
            values={settings.systemPrefixes}
            onChange={(v) => onSettings({ ...settings, systemPrefixes: v })}
            onReset={() => onSettings({ ...settings, systemPrefixes: [...DEFAULT_SYSTEM_PREFIXES] })}
            placeholder="e.g. Azure."
          />
        </div>
        <div className={`${card} space-y-2`}>
          <h2 className={h2}>Internal prefixes</h2>
          <p className={hint}>Case-insensitive prefix match → Private. Suggestions come from project names in the loaded files.</p>
          <ChipListEditor label="Internal prefixes" values={settings.internalPrefixes} onChange={(v) => onSettings({ ...settings, internalPrefixes: v })} placeholder="e.g. Acme." suggestions={prefixSuggestions} />
        </div>
        <div className={`${card} space-y-2`}>
          <h2 className={h2}>Internal feeds</h2>
          <p className={hint}>Source metadata from these feeds → Private. Pre-filled from project.restore.sources, excluding nuget.org and the Visual Studio offline folder.</p>
          <ChipListEditor
            label="Internal feeds"
            values={settings.internalFeeds}
            onChange={(v) => onSettings({ ...settings, internalFeeds: v })}
            onRemove={onFeedRemoved}
            placeholder="https://pkgs.dev.azure.com/…/nuget/v3/index.json"
            suggestions={feedSuggestions}
            mono
          />
        </div>
      </div>

      <div className={`${card} space-y-2`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className={h2}>
            Manual overrides <span className="tabular font-normal text-muted">({Object.keys(overrides).length})</span>
          </h2>
          {Object.keys(overrides).length > 0 ? (
            <button type="button" className={btnSmall} onClick={() => onOverrides({})}>
              Clear all
            </button>
          ) : null}
        </div>
        <p className={hint}>Set per Id from the Dependencies tab. Saved in this browser.</p>
        {Object.keys(overrides).length > 0 ? (
          <ul className="divide-y divide-line text-sm">
            {Object.entries(overrides)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, origin]) => (
                <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-1">
                  <span className="font-mono text-xs">{spellings.get(key) ?? key}</span>
                  <span className="flex items-center gap-2">
                    <select
                      className={field}
                      value={origin}
                      aria-label={`Override for ${key}`}
                      onChange={(e) => onOverrides({ ...overrides, [key]: e.target.value as Origin })}
                    >
                      {ORIGINS.map((o) => (
                        <option key={o} value={o}>
                          {ORIGIN_LABELS[o]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={btnSmall}
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[key];
                        onOverrides(next);
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
