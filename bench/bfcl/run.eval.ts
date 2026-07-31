// ---------------------------------------------------------------------------
// BFCL live driver (eval config).
//
// Runs the AST-subset benchmark against a real model and prints a report with
// the reproducibility envelope. Skips cleanly when the chosen backend isn't
// available (no daemon / no API key), so it's safe in CI.
//
//   npm run bench:bfcl                              # gemma4:e4b on local Ollama
//   SIDECAR_BFCL_MODEL=ministral-3:latest npm run bench:bfcl
//   SIDECAR_BFCL_BACKEND=anthropic SIDECAR_BFCL_MODEL=claude-haiku-4-5 npm run bench:bfcl
//   SIDECAR_BFCL_DATA=/path/to/bfcl npm run bench:bfcl   # full upstream dataset
//
// Env:
//   SIDECAR_BFCL_MODEL       model id (default: gemma4:e4b)
//   SIDECAR_BFCL_BACKEND     ollama | anthropic | openai (default: ollama)
//   SIDECAR_BFCL_QUANT       quantization label for the envelope (default: unknown)
//   SIDECAR_BFCL_DATA        dir with BFCL_v*_<category>.json + possible_answer/ (optional)
//   SIDECAR_BFCL_OUT         where to write the markdown report (optional)
//   SIDECAR_BFCL_N           deterministic, category-proportional subset size (optional;
//                            default runs every loaded case). Use to get a clean
//                            native-vs-constrained comparison on an identical small
//                            slice — see bench/bfcl/README.md "Grammar-constraining
//                            experiment".
//   SIDECAR_BFCL_CONSTRAINED 1 = schema-constrained decoding (Ollama `format`) instead
//                            of native tool-calling
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseFixtures, parseUpstream, sampleCases } from './loader.js';
import { runBfcl } from './runner.js';
import { ollamaBackend, anthropicBackend, openAiBackend, type BfclBackend, type BackendOptions } from './backend.js';
import { formatReport, type RunEnvelope } from './report.js';
import type { BfclCase } from './types.js';

const MODEL = process.env.SIDECAR_BFCL_MODEL || 'gemma4:e4b';
const BACKEND = (process.env.SIDECAR_BFCL_BACKEND || 'ollama').toLowerCase();
const QUANT = process.env.SIDECAR_BFCL_QUANT || 'unknown (Ollama default ≈ Q4_K_M)';
const CONTEXT_TOKENS = 32_768;
const TEMPERATURE = 0;
const TIMEOUT_MS = parseInt(process.env.SIDECAR_EVAL_CASE_TIMEOUT ?? '', 10) || 120_000;
// The whole N-case sweep runs inside ONE vitest test, so its timeout must cover
// the full batch, not a single case. Default 30 min; override with
// SIDECAR_BFCL_TIMEOUT for very large runs.
const BENCH_TIMEOUT_MS = parseInt(process.env.SIDECAR_BFCL_TIMEOUT ?? '', 10) || 1_800_000;
// Phase 1: SIDECAR_BFCL_CONSTRAINED=1 forces schema-constrained decoding (Ollama
// `format`). Run on vs off to measure the schema-validity + accuracy delta.
const CONSTRAINED = process.env.SIDECAR_BFCL_CONSTRAINED === '1';
// SIDECAR_BFCL_RAW=1 measures the RAW model only (native tool_calls, no SideCar
// text-call recovery) — the baseline whose delta vs the default (SideCar-parsed)
// run quantifies what SideCar's parsing layer adds. Local models score ~0% raw.
const RAW = process.env.SIDECAR_BFCL_RAW === '1';
// Deterministic, category-proportional subset size (see loader.sampleCases).
// Unset (default) runs every loaded case. Used to get a clean, fully-completing
// native-vs-constrained comparison on an identical small slice instead of a
// full run that may exceed BENCH_TIMEOUT_MS under the constrained path's tax.
const N = process.env.SIDECAR_BFCL_N ? parseInt(process.env.SIDECAR_BFCL_N, 10) : undefined;

function makeBackend(): BfclBackend {
  const opts: BackendOptions = {
    model: MODEL,
    temperature: TEMPERATURE,
    contextTokens: CONTEXT_TOKENS,
    timeoutMs: TIMEOUT_MS,
    constrained: CONSTRAINED,
    rawParsing: RAW,
  };
  switch (BACKEND) {
    case 'anthropic':
      return anthropicBackend(opts);
    case 'openai':
      return openAiBackend(opts);
    default:
      return ollamaBackend(opts);
  }
}

/** Load cases: upstream dataset dir if SIDECAR_BFCL_DATA is set, else fixtures. */
function loadCases(): { cases: BfclCase[]; dataset: string } {
  const dir = process.env.SIDECAR_BFCL_DATA;
  if (dir) {
    // Supported form: a merged question/answer JSONL pair in the given dir.
    // (BFCL ships per-category files; concatenate them into these two before
    // pointing the runner here — see bench/bfcl/README.md.)
    const qFile = path.join(dir, 'questions.jsonl');
    const aFile = path.join(dir, 'possible_answers.jsonl');
    if (fs.existsSync(qFile) && fs.existsSync(aFile)) {
      const cases = parseUpstream(fs.readFileSync(qFile, 'utf-8'), fs.readFileSync(aFile, 'utf-8'));
      return { cases, dataset: `upstream:${path.basename(dir)}` };
    }
    throw new Error(`SIDECAR_BFCL_DATA=${dir} must contain questions.jsonl + possible_answers.jsonl`);
  }
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'ast.json'), 'utf-8');
  return { cases: parseFixtures(raw), dataset: 'bundled-fixtures' };
}

describe('BFCL AST subset', () => {
  const backend = makeBackend();

  it.skipIf(!backend.available())(
    `scores ${MODEL} on ${BACKEND}`,
    async () => {
      const { cases: allCases, dataset } = loadCases();
      const cases = N ? sampleCases(allCases, N) : allCases;
      console.info(
        `[bfcl] ${MODEL} via ${BACKEND}${CONSTRAINED ? ' [constrained]' : ''}: ${cases.length} cases` +
          (N ? ` (sampled from ${allCases.length})` : ''),
      );

      const report = await runBfcl(cases, backend.callModel, {
        onCase: (o) => {
          console.info(`[bfcl]   ${o.pass ? 'PASS' : 'FAIL'} ${o.id}${o.pass ? '' : ` — ${o.reason}`}`);
        },
      });

      const env: RunEnvelope = {
        model: CONSTRAINED ? `${MODEL} [schema-constrained]` : MODEL,
        quantization: QUANT,
        backend: BACKEND,
        contextTokens: CONTEXT_TOKENS,
        dataset,
        caseCount: cases.length,
        temperature: TEMPERATURE,
        perCaseTimeoutMs: TIMEOUT_MS,
      };
      const md = formatReport(report, env);
      console.info(`\n${md}\n`);

      const out = process.env.SIDECAR_BFCL_OUT;
      if (out) fs.writeFileSync(out, md);

      // The benchmark reports a score; it does not gate. Assert only that the run
      // produced a result for every case (no silently-dropped cases).
      expect(report.total).toBe(cases.length);
    },
    BENCH_TIMEOUT_MS,
  );
});
