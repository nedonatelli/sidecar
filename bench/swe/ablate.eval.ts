// ---------------------------------------------------------------------------
// SWE-bench ablation driver (eval config, standalone — no src imports).
//
// Step 4 of the protocol: after the official swebench harness has scored both
// arms, read its two resolved reports + our predictions.meta.jsonl and print the
// lift report. Gated on the resolved-report paths being set.
//
//   SIDECAR_SWE_DATA=swe.jsonl SIDECAR_SWE_N=50 \
//   SIDECAR_SWE_RESOLVED_ON=on.json SIDECAR_SWE_RESOLVED_OFF=off.json \
//   SIDECAR_SWE_PREDS=/path/to/out \
//   SIDECAR_SWE_MODEL=gemma4:e4b SIDECAR_SWE_QUANT=Q4_K_M \
//   npm run bench:swe:ablate
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseTasks, sampleTasks } from './loader.js';
import { parseResolvedReport } from './predictions.js';
import { computeAblation } from './ablation.js';
import { formatAblationReport, type SweEnvelope } from './report.js';
import type { SwePrediction } from './types.js';

const DATA = process.env.SIDECAR_SWE_DATA;
const ON = process.env.SIDECAR_SWE_RESOLVED_ON;
const OFF = process.env.SIDECAR_SWE_RESOLVED_OFF;
const PREDS = process.env.SIDECAR_SWE_PREDS;
const ready = Boolean(DATA && ON && OFF && PREDS);

describe('SWE-bench Verified — ablation', () => {
  it.skipIf(!ready)('computes the harness lift from the official resolved reports', () => {
    const all = parseTasks(fs.readFileSync(DATA as string, 'utf-8'));
    const repos = (process.env.SIDECAR_SWE_REPOS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const tasks = sampleTasks(all, parseInt(process.env.SIDECAR_SWE_N ?? '50', 10), repos);

    const predictions: SwePrediction[] = fs
      .readFileSync(path.join(PREDS as string, 'predictions.meta.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SwePrediction);

    const resolvedOn = parseResolvedReport(fs.readFileSync(ON as string, 'utf-8'));
    const resolvedOff = parseResolvedReport(fs.readFileSync(OFF as string, 'utf-8'));

    const report = computeAblation(tasks, predictions, resolvedOn, resolvedOff);
    const env: SweEnvelope = {
      model: process.env.SIDECAR_SWE_MODEL || 'gemma4:e4b',
      quantization: process.env.SIDECAR_SWE_QUANT || 'unknown (≈Q4_K_M)',
      backend: 'ollama',
      contextTokens: 32_768,
      dataset: `SWE-bench_Verified slice (${tasks.length})${repos.length ? ` · repos: ${repos.join(',')}` : ''}`,
      taskCount: tasks.length,
      maxIterations: parseInt(process.env.SIDECAR_SWE_MAX_ITERS ?? '20', 10),
      swebenchHarnessVersion: process.env.SIDECAR_SWE_HARNESS_VERSION || 'unspecified',
    };
    const md = formatAblationReport(report, env);
    // eslint-disable-next-line no-console
    console.info(`\n${md}\n`);
    if (process.env.SIDECAR_SWE_OUT) fs.writeFileSync(path.join(process.env.SIDECAR_SWE_OUT, 'ablation.md'), md);

    expect(report.on.total).toBe(tasks.length);
  });
});
