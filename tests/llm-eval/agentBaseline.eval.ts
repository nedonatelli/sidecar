// Agent-eval regression baseline.
//
// The per-case scorers (agentScorers.ts) check each case against its authored
// expectations, but nothing tracked, per MODEL, WHICH cases a given model is
// known to pass — so a model silently regressing (e.g. 8/9 → 6/9, or a bug that
// drops a whole category) was only ever caught by eyeballing a run. This gates
// that: it records a committed baseline of per-case pass/fail + cost metrics per
// model, then FAILS if a case that used to pass now fails.
//
// Two modes (mirrors embeddingParity.eval.ts):
//   - Record (`SIDECAR_RECORD_AGENT_BASELINE=1`): overwrite the baseline for the
//     active model with the current run.
//   - Verify (default): run the baselined cases; fail on any confirmed
//     regression. Missing baseline → skip with a record hint.
//
// Stochasticity: agent runs are non-deterministic, so a regression candidate
// (baseline-pass → now-fail) is RE-RUN once and only counts if it fails again —
// a single flaky flip is reported, not failed. `apiUnavailable` cases (hung
// connection / rate-limit, not a behavioural change) are excluded either way.
//
// Model is selected via SIDECAR_EVAL_BACKEND / SIDECAR_EVAL_MODEL (same as the
// other evals); SIDECAR_EVAL_TAGS / SIDECAR_EVAL_CASE scope which cases record.

import { describe, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { runAgentCase, pickAgentBackend, DEFAULT_CASE_TIMEOUT_MS, runConfigForProvenance } from './agentHarness.js';
import type { AgentEvalCase } from './agentTypes.js';
import { compareProvenance, currentProvenance, type BaselineProvenance } from './baselineProvenance.js';
import { ALL_AGENT_CASES } from './allCases.js';

// The eval and the baseline MUST run the same cases; they drifted to 70 vs 61.
const ALL_CASES: AgentEvalCase[] = ALL_AGENT_CASES;

const BASELINE_DIR = path.resolve(__dirname, 'baselines');
const RECORD_MODE = process.env.SIDECAR_RECORD_AGENT_BASELINE === '1';
const TAG_FILTER = process.env.SIDECAR_EVAL_TAGS?.split(',').map((s) => s.trim());
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());

interface CaseBaseline {
  passed: boolean;
  iterationsUsed: number;
  durationMs: number;
}
interface AgentBaseline {
  model: string;
  recordedAt: string;
  version: string;
  /** Conditions the run was measured under. Absent on baselines recorded
   *  before provenance tracking — those are incomparable, not invalid. */
  provenance?: BaselineProvenance;
  cases: Record<string, CaseBaseline>;
}

const slug = (model: string): string => model.replace(/[^a-zA-Z0-9._-]/g, '_');
const baselinePath = (model: string): string => path.join(BASELINE_DIR, `agent.${slug(model)}.json`);

function readVersion(): string {
  try {
    return (
      JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8')) as { version: string }
    ).version;
  } catch {
    return '0.0.0';
  }
}

function selectCases(): AgentEvalCase[] {
  return ALL_CASES.filter(
    (c) =>
      (!CASE_FILTER || CASE_FILTER.some((f) => c.id.includes(f))) &&
      (!TAG_FILTER || TAG_FILTER.every((t) => c.tags.includes(t))),
  );
}

const backend = pickAgentBackend();

describe.skipIf(!backend)('agent regression baseline', () => {
  const model = backend ? backend.defaultModel() : 'unavailable';
  // The hint named ollama regardless of which backend was actually in use,
  // so following it against a cloud baseline re-recorded the wrong thing.
  const recordHint =
    `  SIDECAR_EVAL_BACKEND=${backend?.name ?? 'ollama'} SIDECAR_EVAL_MODEL=${model} ` +
    `npm run eval:agent:baseline:record`;
  const bpath = baselinePath(model);
  const rel = (p: string) => path.relative(process.cwd(), p);
  // Opt-in + slow: a full run plus a retry on every regression. Cap at 4h.
  const timeout = Math.min(2 * ALL_CASES.length * (DEFAULT_CASE_TIMEOUT_MS + 10_000) + 120_000, 4 * 60 * 60 * 1000);

  if (RECORD_MODE) {
    it(
      `records a fresh baseline for ${model}`,
      async () => {
        const cases = selectCases();
        // Reading the version throws if it cannot be determined — a baseline
        // that cannot describe its own conditions must not be written, and
        // failing here costs nothing where failing after the run costs hours.
        const provenance = currentProvenance(model, runConfigForProvenance());
        const baseline: AgentBaseline = {
          model,
          recordedAt: new Date().toISOString(),
          version: readVersion(),
          provenance,
          cases: {},
        };
        for (const c of cases) {
          const r = await runAgentCase(c, backend!);
          if (r.apiUnavailable) {
            console.warn(`[baseline] ${c.id}: API unavailable — not recorded`);
            continue;
          }
          baseline.cases[c.id] = { passed: r.passed, iterationsUsed: r.iterationsUsed, durationMs: r.durationMs };
        }
        fs.mkdirSync(BASELINE_DIR, { recursive: true });
        fs.writeFileSync(bpath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
        const total = Object.keys(baseline.cases).length;
        const passing = Object.values(baseline.cases).filter((c) => c.passed).length;
        console.log(`[baseline] recorded ${passing}/${total} passing for ${model} → ${rel(bpath)}`);
      },
      timeout,
    );
    return;
  }

  it(
    `no baseline-passing case regressed for ${model}`,
    async () => {
      if (!fs.existsSync(bpath)) {
        console.warn(`[baseline] no baseline for "${model}" (${rel(bpath)}). Record one:\n` + recordHint);
        return; // first run for this model — skip gracefully
      }
      const baseline = JSON.parse(fs.readFileSync(bpath, 'utf-8')) as AgentBaseline;

      // An incomparable baseline is worth exactly what a missing one is worth,
      // and is treated identically: say so, say why, say how to fix it, and do
      // not produce a verdict. Comparing across a changed tool surface or a
      // changed thinking configuration measures the change, not the model —
      // and a green result there is worse than no result, because it is
      // believed.
      const verdict = compareProvenance(baseline.provenance, currentProvenance(model, runConfigForProvenance()));
      if (!verdict.comparable) {
        console.warn(
          `[baseline] baseline for "${model}" (${rel(bpath)}) is NOT comparable to this run:\n` +
            verdict.divergences.map((d) => `  - ${d}`).join('\n') +
            `\nNo regression verdict was produced. Re-record:\n` +
            recordHint,
        );
        return;
      }

      const cases = ALL_CASES.filter((c) => Object.prototype.hasOwnProperty.call(baseline.cases, c.id));

      const regressions: { id: string; failures: string[] }[] = [];
      const improvements: string[] = [];
      const metricDrift: string[] = [];

      for (const c of cases) {
        const base = baseline.cases[c.id];
        const r = await runAgentCase(c, backend!);
        if (r.apiUnavailable) {
          console.warn(`[baseline] ${c.id}: API unavailable — excluded from the check`);
          continue;
        }

        if (!base.passed && r.passed) improvements.push(c.id);

        if (base.passed && !r.passed) {
          // Retry once — filter a stochastic flip from a real regression.
          const retry = await runAgentCase(c, backend!);
          if (retry.apiUnavailable) {
            console.warn(`[baseline] ${c.id}: retry API-unavailable — excluded`);
          } else if (!retry.passed) {
            const failures = (retry.failures.length ? retry.failures : r.failures).slice(0, 6);
            regressions.push({ id: c.id, failures });
          } else {
            console.warn(`[baseline] ${c.id}: failed once then passed on retry — stochastic flip, not a regression`);
          }
        } else if (r.passed && base.passed && r.iterationsUsed > base.iterationsUsed + 2) {
          metricDrift.push(`${c.id}: iterations ${base.iterationsUsed} → ${r.iterationsUsed}`);
        }
      }

      if (improvements.length)
        console.log(`[baseline] improvements (baseline-fail → now-pass): ${improvements.join(', ')}`);
      if (metricDrift.length) console.log(`[baseline] metric drift (iterations grew):\n  ${metricDrift.join('\n  ')}`);

      if (regressions.length > 0) {
        const detail = regressions.map((rg) => `  ✗ ${rg.id}\n      ${rg.failures.join('\n      ')}`).join('\n');
        throw new Error(
          `${regressions.length} case(s) regressed vs baseline (recorded ${baseline.recordedAt}, v${baseline.version}) ` +
            `for ${model} — each failed twice:\n${detail}\n\n` +
            `If this is an intended behaviour change, re-record: npm run eval:agent:baseline:record`,
        );
      }
    },
    timeout,
  );
});
