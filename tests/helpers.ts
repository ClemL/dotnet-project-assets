import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeModels, DEFAULT_ANALYZE_OPTIONS, parseInputs } from '../lib/analyze';
import { DEFAULT_SYSTEM_PREFIXES } from '../lib/classify';
import type { ParseInput } from '../lib/parse';
import type { AnalysisResult, ProjectModel } from '../lib/types';

const FIXTURES = join(__dirname, 'fixtures');

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function fixtureInput(name: string): ParseInput {
  return { inputId: name, fileName: name, text: fixtureText(name) };
}

export function loadModels(...names: string[]): ProjectModel[] {
  const { models, errors } = parseInputs(names.map(fixtureInput));
  if (errors.length > 0) throw new Error(errors.map((e) => `${e.fileName}: ${e.message}`).join('\n'));
  return models;
}

export function analyzeFixtures(...names: string[]): AnalysisResult {
  return analyzeModels(loadModels(...names), [], DEFAULT_ANALYZE_OPTIONS, DEFAULT_SYSTEM_PREFIXES);
}
