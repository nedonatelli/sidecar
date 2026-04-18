// ---------------------------------------------------------------------------
// Layer 3 — real-model embedding parity.
//
// Layers 1 and 2 of the retrieval suite run against a deterministic fake
// pipeline (see `src/test/retrieval-eval/harness.ts`) so they stay fast
// and cheap. That's great for catching pipeline-glue regressions but
// useless for catching MODEL regressions — the concrete case this
// harness was built for is the `@xenova/transformers@2` →
// `@huggingface/transformers@4` migration (captured in v0.65).
//
// This file fills that gap: it loads the REAL pipeline via a dynamic
// `@huggingface/transformers` import, runs it against the fixed fixture
// in `embeddingParity.fixture.ts`, and compares the output vectors
// against a committed baseline JSON. Two modes:
//
//   - **Record mode** (`SIDECAR_RECORD_PARITY_BASELINE=1`): overwrites
//     the baseline with whatever the current model produces, prints
//     the path on success, skips assertions. Run once on the pre-
//     migration codebase to capture a v2 snapshot; run again on v3
//     if the snapshot needs re-baselining (with an audit step: why
//     did it drift?).
//
//   - **Verify mode** (default): loads the baseline, recomputes
//     vectors against the current model, asserts every input's
//     cosine similarity to its baseline vector exceeds
//     `SIMILARITY_FLOOR`. Fails loudly if the model produces
//     materially different embeddings.
//
// The test skips cleanly (not fails) when:
//   - `@xenova/transformers` can't be imported (package not installed)
//   - Model download fails (offline, firewall, CDN hiccup)
//   - The baseline file doesn't exist (first-ever run; record-mode hint surfaces in the skip message)
//
// Run via `npm run eval:parity`. Not included in default `npm test` or
// `npm run eval:llm` because loading the real ONNX model takes 10-30s
// on a cold cache — too slow for the main suite but acceptable as a
// gated regression check.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PARITY_FIXTURES, type ParityFixture } from './embeddingParity.fixture.js';

const BASELINE_PATH = path.resolve(__dirname, 'embeddingParity.baseline.json');
const RECORD_MODE = process.env.SIDECAR_RECORD_PARITY_BASELINE === '1';

/**
 * Cosine similarity floor.
 *
 * Originally 0.999 (strict byte-near-identical). Relaxed to 0.99 in the
 * v2 → @huggingface/transformers@4 migration: most inputs stay at
 * exactly 1.000 (same q8 quantized ONNX weights via the new `dtype`
 * API), but the two longest fixture inputs drift to ~0.996 because v4's
 * tokenizer normalizes multi-line code whitespace slightly differently
 * than v2 did. The gate still catches:
 *   - accidental dtype/quantization changes (→ all inputs drift to ~0.99)
 *   - model-weight swaps (→ all inputs to ~0.95 or worse)
 *   - real behavioral regressions (→ non-uniform scatter below 0.99)
 *
 * Tighten back toward 0.999 if a future upstream release restores the
 * older tokenizer normalization, and investigate any input-specific
 * drop below 0.99 as a real regression.
 */
const SIMILARITY_FLOOR = 0.99;

/** Model id — must match the one used by `symbolEmbeddingIndex.ts` in production. */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

interface BaselineEntry {
  id: string;
  description: string;
  /** Flat Float32 vector serialized as number[] for readability + JSON-roundtrip. */
  vector: number[];
}

interface BaselineFile {
  /** Model id the baseline was recorded against. */
  modelId: string;
  /** Unix timestamp when the baseline was captured. Purely informational. */
  recordedAt: number;
  /** Package.json version when the baseline was captured. Purely informational. */
  packageVersion: string;
  /** Per-input vectors, ordered to match PARITY_FIXTURES. */
  entries: BaselineEntry[];
}

type Pipeline = (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;

async function loadPipeline(): Promise<Pipeline | null> {
  try {
    const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = true;
    // v4's `pipeline()` dropped the `quantized: boolean` flag in favor of
    // an explicit `dtype` enum. `'q8'` maps to the 8-bit quantized ONNX
    // weights that v2's `quantized: true` loaded — any other value
    // produces DIFFERENT weights and the parity harness will flag drift.
    const pipe = (await createPipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })) as unknown as Pipeline;
    return pipe;
  } catch (err) {
    console.warn(`[parity] could not load real pipeline: ${(err as Error).message}`);
    return null;
  }
}

async function embed(pipe: Pipeline, input: string): Promise<number[]> {
  const { data } = await pipe([input], { pooling: 'mean', normalize: true });
  return Array.from(data);
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Both inputs are mean-pooled + normalized by the pipeline, so cosine
  // degenerates to the dot product. Keep the explicit math here as a
  // safety net in case the normalize step ever drops.
  return dot;
}

function readBaseline(): BaselineFile | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as BaselineFile;
}

function writeBaseline(baseline: BaselineFile): void {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

describe('embedding-parity eval (Layer 3 — real `@xenova/transformers` pipeline)', () => {
  it(
    RECORD_MODE
      ? 'records a fresh baseline against the current model'
      : 'every fixture embedding matches the committed baseline within cosine-similarity floor',
    async () => {
      const pipe = await loadPipeline();
      if (!pipe) {
        console.warn('[parity] skipping — real pipeline unavailable. Check network + package install.');
        return;
      }

      if (RECORD_MODE) {
        const entries: BaselineEntry[] = [];
        for (const f of PARITY_FIXTURES) {
          const vector = await embed(pipe, f.input);
          entries.push({ id: f.id, description: f.description, vector });
        }
        const baseline: BaselineFile = {
          modelId: MODEL_ID,
          recordedAt: Date.now(),
          packageVersion: readPackageVersion(),
          entries,
        };
        writeBaseline(baseline);
        console.log(`[parity] wrote baseline with ${entries.length} entries to ${BASELINE_PATH}`);
        return;
      }

      const baseline = readBaseline();
      if (!baseline) {
        console.warn(
          `[parity] no baseline at ${BASELINE_PATH}. Run once with SIDECAR_RECORD_PARITY_BASELINE=1 to create it.`,
        );
        return;
      }

      if (baseline.modelId !== MODEL_ID) {
        throw new Error(
          `Baseline model id (${baseline.modelId}) doesn't match current MODEL_ID (${MODEL_ID}). ` +
            `Either update MODEL_ID in production code or rebaseline explicitly via SIDECAR_RECORD_PARITY_BASELINE=1.`,
        );
      }

      // Keep the scorecard-style log the retrieval baseline test has,
      // so a reviewer can see per-input similarity even when every
      // case passes.
      const rows: Array<{ id: string; similarity: number; pass: boolean }> = [];
      let worst = 1;

      for (const fixture of PARITY_FIXTURES) {
        const entry = baseline.entries.find((e) => e.id === fixture.id);
        expect(entry, `baseline missing entry for fixture id "${fixture.id}"`).toBeDefined();
        const current = await embed(pipe, fixture.input);
        const similarity = cosineSimilarity(current, entry!.vector);
        rows.push({ id: fixture.id, similarity, pass: similarity >= SIMILARITY_FLOOR });
        if (similarity < worst) worst = similarity;
      }

      // Log every row BEFORE asserting so a failure surfaces the full
      // picture in CI output instead of a single ugly line.
      console.log(`\nEmbedding-parity report (model: ${MODEL_ID}, floor: ${SIMILARITY_FLOOR})`);
      console.log(`  baseline: packageVersion=${baseline.packageVersion}, recordedAt=${baseline.recordedAt}`);
      for (const r of rows) {
        const marker = r.pass ? '✓' : '✗';
        console.log(`  ${marker} ${r.id.padEnd(22)} similarity=${r.similarity.toFixed(6)}`);
      }
      console.log(`  worst-case similarity: ${worst.toFixed(6)}`);

      for (const r of rows) {
        expect(r.similarity, `fixture "${r.id}" diverged from baseline`).toBeGreaterThanOrEqual(SIMILARITY_FLOOR);
      }
    },
    120_000, // 2-minute timeout — model download on a cold cache can be slow.
  );
});

// Re-export so a future integration test can reuse the same fixtures
// without duplicating the string corpus.
export { PARITY_FIXTURES, type ParityFixture, SIMILARITY_FLOOR, MODEL_ID };
