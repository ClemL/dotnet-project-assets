// Messages between the UI thread and workers/analyze.worker.ts.

import type { BuildOrderOptions, ClassifiedResult } from '../lib/analyze';
import type { AnalysisResult, AnalyzeOptions, BindingResult, ClassifyInput, InputKind, SkewSettings, SourceMap } from '../lib/types';

export interface AnalyzeInputMessage {
  inputId: string;
  fileName: string;
  kind: InputKind;
  /** Either a File (read inside the worker) or pasted text. */
  file?: File;
  text?: string;
}

/** A binding-check input (deps.json, assembly manifest, runtimeconfig.json): a File or pasted text. */
export interface BindingInputMessage {
  inputId: string;
  fileName: string;
  file?: File;
  text?: string;
}

export interface MetadataFileMessage {
  relPath: string;
  file: File;
}

export type WorkerRequest =
  | { type: 'analyze'; requestId: number; inputs: AnalyzeInputMessage[]; options: AnalyzeOptions; systemPrefixes: string[] }
  | { type: 'classify'; requestId: number; input: Omit<ClassifyInput, 'packages'>; buildOrder: BuildOrderOptions; skew: SkewSettings }
  | { type: 'loadPackagesFolder'; requestId: number; files: MetadataFileMessage[] }
  | { type: 'binding'; requestId: number; inputs: BindingInputMessage[] };

export interface MetadataLoadResult {
  map: SourceMap;
  loaded: number;
  errors: { relPath: string; message: string }[];
}

export type WorkerResponse =
  | { type: 'progress'; requestId: number; stage: string; done: number; total: number; detail?: string }
  | { type: 'analyzed'; requestId: number; result: AnalysisResult }
  | { type: 'classified'; requestId: number; result: ClassifiedResult }
  | { type: 'packagesFolderLoaded'; requestId: number; result: MetadataLoadResult }
  | { type: 'bindingAnalyzed'; requestId: number; result: BindingResult }
  | { type: 'error'; requestId: number; message: string };
