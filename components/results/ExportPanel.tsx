'use client';

import { useState } from 'react';
import { downloadText } from '@/client/download';
import type { BuildOrderOptions } from '@/lib/analyze';
import { buildFileName, buildOrderCsv, dependenciesCsv, jsonReport, markdownReport, skewCsv, type ReportInput } from '@/lib/export';
import type { AnalyzeOptions, BuildOrderView, ClassifyOutput, ClassifySettings, FloatingReport, ParseError, ProjectModel, ScopeAnalysis, SkewReport, SkewSettings } from '@/lib/types';
import { Banner } from '../ui/Banner';
import { btn, card, h2, hint } from '../ui/styles';

const ONEDRIVE_URL = 'https://inscriptrx-my.sharepoint.com/';

export function ExportPanel({
  scope,
  models,
  errors,
  classification,
  buildOrder,
  settings,
  options,
  skew,
  floating,
  skewSettings,
}: {
  scope: ScopeAnalysis;
  models: ProjectModel[];
  errors: ParseError[];
  classification: ClassifyOutput | undefined;
  buildOrder: BuildOrderView | undefined;
  settings: ClassifySettings;
  options: AnalyzeOptions & BuildOrderOptions;
  skew: SkewReport | undefined;
  floating: FloatingReport | undefined;
  skewSettings: SkewSettings;
}) {
  const [last, setLast] = useState<string | null>(null);
  const report = (): ReportInput => ({ generatedAt: new Date(), scope, models, errors, classification, buildOrder, settings, options, skew, floating, skewSettings });

  const save = (ext: string, mime: string, content: (r: ReportInput) => string, suffix?: string) => {
    const r = report();
    const name = buildFileName(scope.label, ext, r.generatedAt, suffix);
    downloadText(name, content(r), mime);
    setLast(name);
  };

  return (
    <div className="space-y-4">
      <div className={`${card} space-y-3`}>
        <div>
          <h2 className={h2}>Export: {scope.label}</h2>
          <p className={hint}>
            Files are generated in the browser and saved to your Downloads folder as <code className="font-mono">AssetsGraph_&lt;ProjectNameOrMerged&gt;_yyyyMMdd_HHmm.&lt;ext&gt;</code>. Exports follow the scope selected above.
          </p>
        </div>
        {!classification ? <p className="text-sm text-warn-ink">Classification is still running; origins will be blank in exports until it finishes.</p> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => save('md', 'text/markdown', markdownReport)}>
            Markdown report (.md)
          </button>
          <button type="button" className={btn} onClick={() => save('json', 'application/json', jsonReport)}>
            Full analysis (.json)
          </button>
          <button type="button" className={btn} onClick={() => save('csv', 'text/csv', (r) => dependenciesCsv(r.scope.rows, r.classification), 'Dependencies')}>
            Dependency list (.csv)
          </button>
          <button
            type="button"
            className={btn}
            disabled={!buildOrder}
            onClick={() => save('csv', 'text/csv', (r) => (r.buildOrder ? buildOrderCsv(r.buildOrder, r.scope.graph, r.classification) : ''), 'BuildOrder')}
          >
            Build order (.csv)
          </button>
          <button type="button" className={btn} disabled={!skew} onClick={() => save('csv', 'text/csv', (r) => (r.skew ? skewCsv(r.skew) : ''), 'VersionSkew')}>
            Version skew (.csv)
          </button>
        </div>
      </div>
      {last ? (
        <Banner tone="info" title={`Saved ${last}`}>
          <p>
            Upload it to OneDrive:{' '}
            <a className="underline" href={ONEDRIVE_URL} target="_blank" rel="noopener noreferrer">
              {ONEDRIVE_URL}
            </a>
          </p>
        </Banner>
      ) : null}
    </div>
  );
}
