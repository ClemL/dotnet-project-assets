'use client';

import { useEffect, useState } from 'react';
import { Banner } from '../ui/Banner';
import { CodeBlock } from '../ui/CodeBlock';
import { card, h2, hint } from '../ui/styles';
import { COLLECT_SCRIPTS, COLLECTION_FOLDER, LAYOUT_SNIPPET, RUN_ALL_SNIPPET, SETUP_SNIPPET, type CollectScript } from './scripts';

type Loaded = Record<string, { text?: string; error?: string }>;

/** Fetches the scripts served from /scripts/ (same origin); embedded scripts need no request. */
function useScriptTexts(): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(() =>
    Object.fromEntries(COLLECT_SCRIPTS.filter((s) => 'text' in s.source).map((s) => [s.id, { text: (s.source as { text: string }).text }])),
  );
  useEffect(() => {
    let cancelled = false;
    for (const s of COLLECT_SCRIPTS) {
      if (!('url' in s.source)) continue;
      fetch(s.source.url)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((text) => {
          if (!cancelled) setLoaded((prev) => ({ ...prev, [s.id]: { text } }));
        })
        .catch((e: unknown) => {
          if (!cancelled) setLoaded((prev) => ({ ...prev, [s.id]: { error: e instanceof Error ? e.message : String(e) } }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return loaded;
}

function ScriptCard({ script, loaded }: { script: CollectScript; loaded: Loaded[string] | undefined }) {
  const lines = loaded?.text ? loaded.text.split('\n').length : 0;
  return (
    <section className={`${card} space-y-3`} aria-labelledby={`script-${script.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`script-${script.id}`} className={h2}>
          {script.title} <span className="font-mono text-sm font-normal text-ink-2">{script.file}</span>
        </h2>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">{script.requires}</span>
      </div>
      <p className="text-sm text-ink-2">{script.purpose}</p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-[max-content_1fr]">
        <dt className="text-ink-2">Looks in</dt>
        <dd>
          <ul className="list-disc pl-5">
            {script.searches.map((s) => (
              <li key={s} className="font-mono text-xs">
                {s}
              </li>
            ))}
          </ul>
        </dd>
        <dt className="text-ink-2">Copies to</dt>
        <dd className="font-mono text-xs">
          {COLLECTION_FOLDER}\{script.output}
        </dd>
        <dt className="text-ink-2">Use it in</dt>
        <dd>{script.feeds}</dd>
      </dl>
      <CodeBlock label="Example (every parameter at its default)" code={script.example} maxHeight="max-h-40" />
      {loaded?.text ? (
        <CodeBlock label={`${script.file} · ${lines} lines`} code={loaded.text} fileName={script.file} maxHeight="max-h-72" />
      ) : loaded?.error ? (
        <Banner tone="danger" title={`Could not load ${script.file} (${loaded.error})`}>
          <p>
            Download it directly from <a className="underline" href={'url' in script.source ? script.source.url : '#'}>{'url' in script.source ? script.source.url : script.file}</a>.
          </p>
        </Banner>
      ) : (
        <p className={hint}>Loading {script.file}…</p>
      )}
    </section>
  );
}

export function CollectScripts() {
  const loaded = useScriptTexts();
  return (
    <div className="space-y-4">
      <div className={`${card} space-y-2`}>
        <h2 className={h2}>Collect the inputs with PowerShell</h2>
        <p className="text-sm text-ink-2">
          These scripts look in the usual places on a developer machine or server and copy what this app reads into one folder,{' '}
          <code className="font-mono">{COLLECTION_FOLDER}</code>, ready to load on the Inputs tab or zip and move. They only read the folders they search; nothing there is changed. Every script supports{' '}
          <code className="font-mono">-WhatIf</code> to list what it would copy, writes a CSV log of what it copied, and prints the collection path and the OneDrive upload link.
        </p>
        <p className={hint}>
          The collect scripts run in Windows PowerShell 5.1 or PowerShell 7. Assembly manifests (for the Binding check) need PowerShell 7 (<code className="font-mono">pwsh</code>); in 5.1 the collect scripts print the commands to run instead.
        </p>
      </div>

      <section className="space-y-2" aria-labelledby="collect-setup">
        <h2 id="collect-setup" className={h2}>
          1. Set up once
        </h2>
        <CodeBlock label="Setup" code={SETUP_SNIPPET} maxHeight="max-h-60" />
      </section>

      <section className="space-y-2" aria-labelledby="collect-all">
        <h2 id="collect-all" className={h2}>
          2. Run everything
        </h2>
        <CodeBlock label="Run all collectors" code={RUN_ALL_SNIPPET} maxHeight="max-h-80" />
      </section>

      <section className="space-y-2" aria-labelledby="collect-layout">
        <h2 id="collect-layout" className={h2}>
          3. Load the results
        </h2>
        <p className="text-sm text-ink-2">What ends up in the collection folder, and where each part goes in this app:</p>
        <CodeBlock label="Collection folder layout" code={LAYOUT_SNIPPET} maxHeight="max-h-60" />
      </section>

      <h2 className={h2}>The scripts</h2>
      {COLLECT_SCRIPTS.map((s) => (
        <ScriptCard key={s.id} script={s} loaded={loaded[s.id]} />
      ))}
    </div>
  );
}
