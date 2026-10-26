// Promise wrapper around the analysis worker.

import type { BuildOrderOptions, ClassifiedResult } from '../lib/analyze';
import type { AnalysisResult, AnalyzeOptions, ClassifyInput } from '../lib/types';
import type { AnalyzeInputMessage, MetadataFileMessage, MetadataLoadResult, WorkerRequest, WorkerResponse } from '../workers/protocol';

export interface Progress {
  stage: string;
  done: number;
  total: number;
  detail?: string;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: (p: Progress) => void;
}

/** WorkerRequest without requestId, kept as a union. */
type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'requestId'> : never) : never;

export class AnalysisWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('../workers/analyze.worker.ts', import.meta.url), { type: 'module', name: 'assets-graph-analyzer' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Worker failed to load.');
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  private receive(msg: WorkerResponse): void {
    const p = this.pending.get(msg.requestId);
    if (!p) return;
    switch (msg.type) {
      case 'progress':
        p.onProgress?.({ stage: msg.stage, done: msg.done, total: msg.total, detail: msg.detail });
        return;
      case 'error':
        this.pending.delete(msg.requestId);
        p.reject(new Error(msg.message));
        return;
      default:
        this.pending.delete(msg.requestId);
        p.resolve(msg.result as never);
    }
  }

  private send<T>(body: RequestBody, onProgress?: (p: Progress) => void): Promise<T> {
    const requestId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: never) => void, reject, onProgress });
      this.worker.postMessage({ ...body, requestId } as WorkerRequest);
    });
  }

  analyze(inputs: AnalyzeInputMessage[], options: AnalyzeOptions, systemPrefixes: string[], onProgress?: (p: Progress) => void): Promise<AnalysisResult> {
    return this.send({ type: 'analyze', inputs, options, systemPrefixes }, onProgress);
  }

  classify(input: Omit<ClassifyInput, 'packages'>, buildOrder: BuildOrderOptions): Promise<ClassifiedResult> {
    return this.send({ type: 'classify', input, buildOrder });
  }

  loadPackagesFolder(files: MetadataFileMessage[], onProgress?: (p: Progress) => void): Promise<MetadataLoadResult> {
    return this.send({ type: 'loadPackagesFolder', files }, onProgress);
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Worker disposed.'));
    this.pending.clear();
  }
}
