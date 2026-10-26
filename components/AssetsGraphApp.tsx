'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnalysisWorkerClient, type Progress } from '@/client/workerClient';
import { MERGED_SCOPE, modelsOf, scopeOf, type ClassifiedResult } from '@/lib/analyze';
import { DEFAULT_SETTINGS } from '@/lib/classify';
import { DEFAULT_SKEW_SETTINGS } from '@/lib/skew';
import { normalizeSource } from '@/lib/metadata';
import type { AnalysisResult, BindingResult, ClassifySettings, IdKey, NugetLookup, Origin, SkewSettings } from '@/lib/types';
import type { AnalyzeInputMessage } from '@/workers/protocol';
import { CollectScripts } from './collect/CollectScripts';
import { useNugetLookups } from './hooks/useNugetLookups';
import { usePersistentState } from './hooks/usePersistentState';
import { BindingInputs, type BindingItem } from './input/BindingInputs';
import { InputsPanel } from './input/InputsPanel';
import { EMPTY_METADATA, MetadataInputs, type MetadataSources } from './input/MetadataInputs';
import type { FileItem, PasteSlot } from './inputTypes';
import { BindingCheck } from './results/BindingCheck';
import { BuildOrder } from './results/BuildOrder';
import { DependencyTable } from './results/DependencyTable';
import { DependencyTree, type TreeFocus } from './results/DependencyTree';
import { DuplicatesTabs } from './results/DuplicatesTabs';
import { ExportPanel } from './results/ExportPanel';
import { VersionSkew, type SkewFocus } from './results/VersionSkew';
import { ClassificationPanel, ProxyBanner } from './settings/ClassificationPanel';
import { Banner } from './ui/Banner';
import { card, field } from './ui/styles';
import { Tabs } from './ui/Tabs';

type TabId = 'inputs' | 'collect' | 'classification' | 'dependencies' | 'duplicates' | 'tree' | 'buildOrder' | 'skew' | 'binding' | 'export';

interface Prefs {
  includeRidTargets: boolean;
  includeProjects: boolean;
  showDag: boolean;
}

const DEFAULT_PREFS: Prefs = { includeRidTargets: false, includeProjects: true, showDag: true };

/** Adds suggested feeds the user has not explicitly removed. */
function mergeFeeds(settings: ClassifySettings, suggested: string[], removed: string[]): ClassifySettings {
  const have = new Set(settings.internalFeeds.map(normalizeSource));
  const gone = new Set(removed.map(normalizeSource));
  const add = suggested.filter((f) => !have.has(normalizeSource(f)) && !gone.has(normalizeSource(f)));
  return add.length > 0 ? { ...settings, internalFeeds: [...settings.internalFeeds, ...add] } : settings;
}

export default function AssetsGraphApp() {
  const workerRef = useRef<AnalysisWorkerClient | null>(null);
  useEffect(() => {
    const w = new AnalysisWorkerClient();
    workerRef.current = w;
    return () => {
      w.dispose();
      workerRef.current = null;
    };
  }, []);

  const [settings, setSettings] = usePersistentState<ClassifySettings>('settings', DEFAULT_SETTINGS);
  const [prefs, setPrefs] = usePersistentState<Prefs>('prefs', DEFAULT_PREFS);
  const [overrides, setOverrides] = usePersistentState<Record<IdKey, Origin>>('overrides', {});
  const [removedFeeds, setRemovedFeeds] = usePersistentState<string[]>('removed-feeds', []);
  const [skewSettings, setSkewSettings] = usePersistentState<SkewSettings>('skew-settings', DEFAULT_SKEW_SETTINGS);

  const [pastes, setPastes] = useState<PasteSlot[]>(() => [{ id: 'paste-0', text: '' }]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [lookups, setLookups] = useState<Record<IdKey, NugetLookup>>({});
  const [metadata, setMetadata] = useState<MetadataSources>(EMPTY_METADATA);
  const sourceMap = useMemo(() => ({ ...metadata.bundled, ...metadata.folder, ...metadata.single }), [metadata]);
  const [classified, setClassified] = useState<ClassifiedResult | null>(null);

  const [tab, setTab] = useState<TabId>('inputs');
  const [scopeId, setScopeId] = useState(MERGED_SCOPE);
  const [treeFocus, setTreeFocus] = useState<TreeFocus | undefined>();
  const [skewFocus, setSkewFocus] = useState<SkewFocus | undefined>();
  const [dupFocus, setDupFocus] = useState<{ sub: 'drift'; nonce: number } | undefined>();

  const [bindingItems, setBindingItems] = useState<BindingItem[]>([]);
  const [binding, setBinding] = useState<BindingResult | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);

  const onLookupResults = useCallback((batch: Record<IdKey, NugetLookup>) => setLookups((prev) => ({ ...prev, ...batch })), []);
  const nuget = useNugetLookups(onLookupResults);

  const analyze = async () => {
    const worker = workerRef.current;
    if (!worker) return;
    const inputs: AnalyzeInputMessage[] = [
      ...pastes.filter((p) => p.text.trim()).map((p, i): AnalyzeInputMessage => ({ inputId: p.id, fileName: `Paste #${i + 1}`, kind: 'paste', text: p.text })),
      ...files.map((f): AnalyzeInputMessage => ({ inputId: f.id, fileName: f.name, kind: f.kind, file: f.file })),
    ];
    if (inputs.length === 0) return;
    setAnalyzing(true);
    setError(null);
    setProgress({ stage: 'Starting', done: 0, total: inputs.length });
    try {
      const result = await worker.analyze(inputs, { includeRidTargets: prefs.includeRidTargets }, settings.systemPrefixes, setProgress);
      setClassified(null);
      setAnalysis(result);
      setSettings((s) => mergeFeeds(s, result.suggestions.internalFeeds, removedFeeds));
      // Previously cached lookups classify immediately; nothing is fetched here.
      setLookups((prev) => ({ ...prev, ...nuget.cached([...new Set(result.packages.map((p) => p.key))]) }));
      if (!result.files.some((f) => f.scopeId === scopeId)) setScopeId(MERGED_SCOPE);
      if (result.models.length > 0) setTab((t) => (t === 'inputs' ? 'dependencies' : t));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
      setProgress(null);
    }
  };

  // Recompute classification and build order whenever an input to them changes.
  const classifySeq = useRef(0);
  useEffect(() => {
    const worker = workerRef.current;
    if (!analysis || !worker) return;
    const seq = ++classifySeq.current;
    const handle = setTimeout(() => {
      worker
        .classify({ settings, lookups, metadata: sourceMap, overrides }, { includeProjects: prefs.includeProjects }, skewSettings)
        .then((r) => {
          if (seq === classifySeq.current) setClassified(r);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, 120);
    return () => clearTimeout(handle);
  }, [analysis, settings, lookups, sourceMap, overrides, prefs.includeProjects, skewSettings]);

  // The binding check runs whenever its inputs change; it does not depend on the assets analysis.
  const bindingSeq = useRef(0);
  useEffect(() => {
    const worker = workerRef.current;
    const seq = ++bindingSeq.current;
    if (bindingItems.length === 0 || !worker) {
      setBinding(null);
      return;
    }
    setBindingBusy(true);
    worker
      .binding(bindingItems.map((b) => ({ inputId: b.id, fileName: b.name, file: b.file, text: b.text })))
      .then((r) => {
        if (seq === bindingSeq.current) setBinding(r);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (seq === bindingSeq.current) setBindingBusy(false);
      });
  }, [bindingItems]);
  const bindingReady = binding !== null && binding.missing.length === 0;

  const hasResults = analysis !== null && analysis.models.length > 0;
  const scope = analysis ? scopeOf(analysis, scopeId) : null;
  const scopeModels = analysis ? modelsOf(analysis, scopeId) : [];
  const classification = classified?.classification;
  const buildOrder = classified?.buildOrders[scopeId];
  const skew = classified?.skew[scopeId];
  const floating = classified?.floating[scopeId];

  const setOverride = (key: IdKey, origin: Origin | undefined) =>
    setOverrides((prev) => {
      const next = { ...prev };
      if (origin) next[key] = origin;
      else delete next[key];
      return next;
    });

  const conflicts = scope ? scope.duplicates.ranges.filter((r) => r.hasConflict).length : 0;
  const dupCount = scope ? scope.duplicates.tfm.length + scope.duplicates.drift.length + conflicts + scope.duplicates.redundant.length + scope.duplicates.caseCollisions.length : undefined;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assets Graph</h1>
          <p className="text-sm text-ink-2">Dependencies, duplicates, origins, and internal build order from NuGet project.assets.json files.</p>
        </div>
        <p className="max-w-md text-xs text-muted">
          Everything runs in this browser tab. File contents are never uploaded; nuget.org lookups send package Ids only, and only when you start them.
        </p>
      </header>

      <Tabs<TabId>
        label="Sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'inputs', label: 'Inputs' },
          { id: 'collect', label: 'Collect scripts' },
          { id: 'classification', label: 'Classification', disabled: !hasResults },
          { id: 'dependencies', label: 'Dependencies', count: scope?.rows.length, disabled: !hasResults },
          { id: 'duplicates', label: 'Duplicates', count: dupCount, disabled: !hasResults },
          { id: 'tree', label: 'Tree', disabled: !hasResults },
          { id: 'buildOrder', label: 'Build order', disabled: !hasResults },
          { id: 'skew', label: 'Version skew', count: skew?.internal.length, disabled: !hasResults },
          { id: 'binding', label: 'Binding check', count: bindingReady ? binding.counts.error : undefined, disabled: !bindingReady },
          { id: 'export', label: 'Export', disabled: !hasResults },
        ]}
      />

      {hasResults && tab !== 'inputs' && tab !== 'collect' && classification?.proxyWarning && tab !== 'classification' ? (
        <ProxyBanner warning={classification.proxyWarning} trust={settings.trustProxyFeedMetadata} onTrust={(v) => setSettings({ ...settings, trustProxyFeedMetadata: v })} />
      ) : null}

      {hasResults && tab !== 'inputs' && tab !== 'collect' && tab !== 'classification' && tab !== 'binding' && analysis ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="scope" className="text-ink-2">
            Scope
          </label>
          <select id="scope" className={field} value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            <option value={MERGED_SCOPE}>{analysis.models.length > 1 ? `Merged (${analysis.models.length} projects)` : `${analysis.merged.label} (only file)`}</option>
            {analysis.models.length > 1
              ? analysis.files.map((f) => (
                  <option key={f.scopeId} value={f.scopeId}>
                    {f.label}
                  </option>
                ))
              : null}
          </select>
          {analysis.errors.length > 0 ? <span className="text-xs text-danger-ink">{analysis.errors.length} input(s) failed to parse; see Inputs.</span> : null}
          {!classification ? <span className="text-xs text-muted">Classifying…</span> : null}
        </div>
      ) : null}

      {tab === 'inputs' ? (
        <div className="space-y-4">
          <InputsPanel
            pastes={pastes}
            onPastes={setPastes}
            files={files}
            onFiles={setFiles}
            includeRid={prefs.includeRidTargets}
            onIncludeRid={(v) => setPrefs({ ...prefs, includeRidTargets: v })}
            analyzing={analyzing}
            progress={progress}
            onAnalyze={() => void analyze()}
            analysis={analysis}
            error={error}
          />
          <div className={card}>
            <MetadataInputs
              packages={analysis?.packages}
              coverage={classification?.coverage}
              sources={metadata}
              onChange={setMetadata}
              loadFolder={(picked, onProgress) => {
                const worker = workerRef.current;
                if (!worker) return Promise.reject(new Error('Worker not ready.'));
                return worker.loadPackagesFolder(
                  picked.map((p) => ({ relPath: p.relPath, file: p.file })),
                  onProgress,
                );
              }}
            />
          </div>
          <div className={card}>
            <BindingInputs items={bindingItems} onItems={setBindingItems} result={binding} busy={bindingBusy} />
          </div>
        </div>
      ) : null}

      {tab === 'collect' ? <CollectScripts /> : null}

      {tab === 'classification' && analysis ? (
        <ClassificationPanel
          settings={settings}
          onSettings={setSettings}
          analysis={analysis}
          classification={classification}
          lookups={lookups}
          lookupStatus={nuget.status}
          onRunLookups={(ids) => void nuget.run(ids)}
          onCancelLookups={nuget.cancel}
          onClearLookupCache={() => {
            nuget.clearCache();
            setLookups({});
          }}
          overrides={overrides}
          onOverrides={setOverrides}
          onFeedRemoved={(feed) => setRemovedFeeds((prev) => [...prev, feed])}
        />
      ) : null}

      {tab === 'dependencies' && scope ? <DependencyTable rows={scope.rows} classification={classification} overrides={overrides} onOverride={setOverride} /> : null}

      {tab === 'duplicates' && scope && analysis ? (
        <DuplicatesTabs key={dupFocus?.nonce ?? 0} duplicates={scope.duplicates} isMerged={scopeId === MERGED_SCOPE} fileCount={analysis.models.length} initialSub={dupFocus?.sub} />
      ) : null}

      {tab === 'tree' && scopeModels.length > 0 ? (
        <DependencyTree key={scopeId} models={scopeModels} classification={classification} includeRid={analysis?.options.includeRidTargets ?? false} focus={treeFocus} />
      ) : null}

      {tab === 'buildOrder' && scope ? (
        <BuildOrder
          view={buildOrder}
          graph={scope.graph}
          classification={classification}
          includeProjects={prefs.includeProjects}
          onIncludeProjects={(v) => setPrefs({ ...prefs, includeProjects: v })}
          showDag={prefs.showDag}
          onShowDag={(v) => setPrefs({ ...prefs, showDag: v })}
        />
      ) : null}

      {tab === 'skew' && analysis ? (
        <VersionSkew
          skew={skew}
          floating={floating}
          settings={skewSettings}
          onSettings={setSkewSettings}
          isMerged={scopeId === MERGED_SCOPE}
          fileCount={analysis.models.length}
          onOpenDrift={() => {
            setDupFocus({ sub: 'drift', nonce: Date.now() });
            setTab('duplicates');
          }}
          canJump={hasResults}
          onJumpTree={(id) => {
            setTreeFocus({ key: id.toLowerCase(), nonce: Date.now() });
            setTab('tree');
          }}
          focus={skewFocus}
        />
      ) : null}

      {tab === 'binding' && bindingReady ? (
        <BindingCheck
          result={binding}
          classification={classification}
          settings={settings}
          canJump={hasResults}
          onJump={(packageId) => {
            setScopeId(MERGED_SCOPE);
            setTreeFocus({ key: packageId.toLowerCase(), nonce: Date.now() });
            setTab('tree');
          }}
          onJumpSkew={(packageId) => {
            setScopeId(MERGED_SCOPE);
            setSkewFocus({ key: packageId.toLowerCase(), nonce: Date.now() });
            setTab('skew');
          }}
        />
      ) : null}

      {tab === 'export' && scope && analysis ? (
        <ExportPanel
          scope={scope}
          models={scopeModels}
          errors={analysis.errors}
          classification={classification}
          buildOrder={buildOrder}
          settings={settings}
          options={{ ...analysis.options, includeProjects: prefs.includeProjects }}
          skew={skew}
          floating={floating}
          skewSettings={skewSettings}
        />
      ) : null}

      {tab !== 'inputs' && tab !== 'collect' && tab !== 'binding' && !hasResults ? <Banner tone="info" title="Analyze at least one file first." /> : null}
      {tab === 'binding' && !bindingReady ? <Banner tone="info" title="Load a deps.json and an assembly manifest under Inputs → Runtime binding inputs." /> : null}

      <footer className="pt-4 text-xs text-muted">Assets Graph · static site, no server code, no analytics.</footer>
    </div>
  );
}
