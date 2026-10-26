// Web Worker: reads and parses assets files, runs the analysis, recomputes classification and
// build order on request, and runs the binding check. Holds the latest analysis so classification
// requests stay small.

import { analyzeModels, classifyAndOrder } from '../lib/analyze';
import { analyzeBindingInputs } from '../lib/binding';
import type { BindingInputText } from '../lib/bindingInputs';
import { assignLabels, parseAssetsJson } from '../lib/parse';
import { mapWithConcurrency } from '../lib/concurrency';
import { parseNupkgMetadata, parsePackagesFolderPath } from '../lib/metadata';
import type { AnalysisResult, ParseError, ProjectModel } from '../lib/types';
import type { MetadataLoadResult, WorkerRequest, WorkerResponse } from './protocol';

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
let current: AnalysisResult | null = null;

const post = (message: WorkerResponse) => scope.postMessage(message);

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case 'analyze': {
      const models: ProjectModel[] = [];
      const errors: ParseError[] = [];
      const total = req.inputs.length;
      for (let i = 0; i < total; i++) {
        const input = req.inputs[i] as (typeof req.inputs)[number];
        post({ type: 'progress', requestId: req.requestId, stage: 'Parsing', done: i, total, detail: input.fileName });
        let text: string;
        try {
          text = input.text ?? (input.file ? await input.file.text() : '');
        } catch (e) {
          errors.push({ inputId: input.inputId, fileName: input.fileName, message: `Could not read file: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        const r = parseAssetsJson({ inputId: input.inputId, fileName: input.fileName, text });
        if (r.ok) models.push(r.model);
        else errors.push(r.error);
      }
      post({ type: 'progress', requestId: req.requestId, stage: 'Analyzing', done: total, total });
      current = analyzeModels(assignLabels(models), errors, req.options, req.systemPrefixes);
      post({ type: 'analyzed', requestId: req.requestId, result: current });
      return;
    }
    case 'classify': {
      if (!current) throw new Error('Nothing analyzed yet.');
      post({ type: 'classified', requestId: req.requestId, result: classifyAndOrder(current, req.input, req.buildOrder, req.skew) });
      return;
    }
    case 'loadPackagesFolder': {
      const result: MetadataLoadResult = { map: {}, loaded: 0, errors: [] };
      const total = req.files.length;
      let done = 0;
      await mapWithConcurrency(req.files, 32, async ({ relPath, file }) => {
        const pkg = parsePackagesFolderPath(relPath);
        if (!pkg) {
          result.errors.push({ relPath, message: 'Path is not <id>/<version>/.nupkg.metadata.' });
        } else {
          try {
            const parsed = parseNupkgMetadata(await file.text());
            if (parsed.ok) {
              result.map[pkg.key] = parsed.source;
              result.loaded++;
            } else {
              result.errors.push({ relPath, message: parsed.error });
            }
          } catch (e) {
            result.errors.push({ relPath, message: e instanceof Error ? e.message : String(e) });
          }
        }
        done++;
        if (done % 250 === 0) post({ type: 'progress', requestId: req.requestId, stage: 'Reading metadata', done, total });
      });
      post({ type: 'packagesFolderLoaded', requestId: req.requestId, result });
      return;
    }
    case 'binding': {
      const texts: BindingInputText[] = [];
      const unreadable: { inputId: string; fileName: string; error: string }[] = [];
      for (const input of req.inputs) {
        try {
          texts.push({ inputId: input.inputId, fileName: input.fileName, text: input.text ?? (input.file ? await input.file.text() : '') });
        } catch (e) {
          unreadable.push({ inputId: input.inputId, fileName: input.fileName, error: `Could not read file: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      const result = analyzeBindingInputs(texts);
      result.inputs.push(...unreadable);
      post({ type: 'bindingAnalyzed', requestId: req.requestId, result });
      return;
    }
  }
}

scope.onmessage = (event) => {
  const req = event.data;
  handle(req).catch((e: unknown) => post({ type: 'error', requestId: req.requestId, message: e instanceof Error ? e.message : String(e) }));
};
